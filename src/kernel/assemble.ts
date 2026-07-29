// kernel/assemble.ts — the kernel assembler: emits SPECIALIZED escape-kernel source from a
// frame spec. The formula compiler's codegen approach applied to the whole loop: frame
// constants (formula, filter, periodicity, set-type wiring) are baked into the emitted
// source, so the per-iteration formulaId/filterId/periodOn branches do not exist in the
// generated code. DD primitives are inlined (twoSum/twoProduct sequences with generated
// temps — same ops, same order as math/dd.ts, so results are bit-identical).
//
// ABI (see kernel.ts GenKernel): generated bodies are `new Function`-compiled, so they
// CANNOT capture module scope. Everything arrives via parameters:
//   (cr, ci, ax, ay, maxIters, K)
// where (cr,ci) is the primary coordinate, (ax,ay) is the per-variant aux (DD lo-limbs |
// pert δc | K2 c when (cr,ci) is z₀), and K is the frame context, read ONCE into locals
// before the loop. Side channels go out through K.out at exit only:
//   K.out[0] = deDist-channel   K.out[1] = iterations   K.out[2] = outcome code
// with outcome 0 = escaped, 1 = in-set (shortcut), 2 = in-set (periodicity), 3 = capped.
// Pure functions + exit-only side effects = trivially testable and rename-safe.
import { FILTERS } from "../filters/index";

export interface KernelSpec {
	usePeriod: boolean;
	formulaBody: string | null;   // compiled f(z,c) body (assigns _cre/_cim), null = z²+c
	filterId: number;             // 0 = escape-time
	juliaMode: boolean;           // K2 trap-geometry + observer-skip baking
}

export interface AssembledKernels {
	key: string;
	srcs: { k1f64: string; k1dd: string; k1pert: string; k2: string; probeStep: string };
}

// Baked constants (mirror kernel.ts; goldens pin the values).
const BAILOUT2 = 256;
const BAILOUT_CUSTOM2 = 4;
const PERIOD_WARMUP = 64;

//---------------------------------------------------------------------------\\
// Emitter: line buffer + temp names + inlined DD primitives (exact op order of
// math/dd.ts — Knuth twoSum / Dekker twoProduct via the 2^27+1 split).
//---------------------------------------------------------------------------\\

class Emit {
	public lines: string[] = [];
	private n = 0;
	public t(p = "t"): string { return p + this.n++; }
	public push(s: string): void { this.lines.push(s); }

	// Hoist an expression (e.g. a negation) into a const so DD arg re-reads are literal.
	public val(expr: string): string {
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) || /^-?\d/.test(expr)) return expr;
		const v = this.t("v");
		this.push(`const ${v} = ${expr};`);
		return v;
	}

	// (ahi,alo) + (bhi,blo) → [hi, lo]
	public ddAdd(ahi: string, alo: string, bhi: string, blo: string): [string, string] {
		ahi = this.val(ahi); alo = this.val(alo); bhi = this.val(bhi); blo = this.val(blo);
		const s = this.t("s"), v = this.t("v"), e = this.t("e"), hi = this.t("h"), lo = this.t("l");
		this.push(`const ${s} = ${ahi} + ${bhi};`);
		this.push(`const ${v} = ${s} - ${ahi};`);
		this.push(`let ${e} = (${ahi} - (${s} - ${v})) + (${bhi} - ${v});`);
		this.push(`${e} += ${alo} + ${blo};`);
		this.push(`const ${hi} = ${s} + ${e};`);
		this.push(`const ${lo} = ${e} - (${hi} - ${s});`);
		return [hi, lo];
	}

	// (ahi,alo) * (bhi,blo) → [hi, lo]
	public ddMul(ahi: string, alo: string, bhi: string, blo: string): [string, string] {
		ahi = this.val(ahi); alo = this.val(alo); bhi = this.val(bhi); blo = this.val(blo);
		const p = this.t("p"), sa = this.t("sa"), ah = this.t("ah"), al = this.t("al");
		const sb = this.t("sb"), bh = this.t("bh"), bl = this.t("bl"), e = this.t("e");
		const hi = this.t("h"), lo = this.t("l");
		this.push(`const ${p} = ${ahi} * ${bhi};`);
		this.push(`const ${sa} = 134217729 * ${ahi}; const ${ah} = ${sa} - (${sa} - ${ahi}); const ${al} = ${ahi} - ${ah};`);
		this.push(`const ${sb} = 134217729 * ${bhi}; const ${bh} = ${sb} - (${sb} - ${bhi}); const ${bl} = ${bhi} - ${bh};`);
		this.push(`let ${e} = ((${ah} * ${bh} - ${p}) + ${ah} * ${bl} + ${al} * ${bh}) + ${al} * ${bl};`);
		this.push(`${e} += ${ahi} * ${blo} + ${alo} * ${bhi};`);
		this.push(`const ${hi} = ${p} + ${e};`);
		this.push(`const ${lo} = ${e} - (${hi} - ${p});`);
		return [hi, lo];
	}

	// (ahi,alo)² → [hi, lo] — the cheaper twoProduct with b == a.
	public ddSq(ahi: string, alo: string): [string, string] {
		ahi = this.val(ahi); alo = this.val(alo);
		const p = this.t("p"), sa = this.t("sa"), ah = this.t("ah"), al = this.t("al"), e = this.t("e");
		const hi = this.t("h"), lo = this.t("l");
		this.push(`const ${p} = ${ahi} * ${ahi};`);
		this.push(`const ${sa} = 134217729 * ${ahi}; const ${ah} = ${sa} - (${sa} - ${ahi}); const ${al} = ${ahi} - ${ah};`);
		this.push(`let ${e} = ((${ah} * ${ah} - ${p}) + 2 * ${ah} * ${al}) + ${al} * ${al};`);
		this.push(`${e} += 2 * ${ahi} * ${alo};`);
		this.push(`const ${hi} = ${p} + ${e};`);
		this.push(`const ${lo} = ${e} - (${hi} - ${p});`);
		return [hi, lo];
	}
}

// z²+c interior shortcuts (period-2 bulb, main cardioid, the real-axis interval) on the
// given coordinate names. Outcome 1 (in-set via shortcut), deDist channel zeroed —
// deDist is now DEFINED (0) for in-set returns (the P3 fix; the old kernels left a stale
// side-channel).
function shortcuts(cr: string, ci: string, extraRealGuard = ""): string {
	return [
		`const scb = ${cr} + 1;`,
		`if (scb * scb + ${ci} * ${ci} < 0.0625) { K.out[0] = 0; K.out[1] = 0; K.out[2] = 1; return Infinity; }`,
		`const scx = ${cr} - 0.25;`,
		`const scq = scx * scx + ${ci} * ${ci};`,
		`if (scq * (scq + scx) < 0.25 * ${ci} * ${ci}) { K.out[0] = 0; K.out[1] = 0; K.out[2] = 1; return Infinity; }`,
		`if (${ci} === 0 && ${extraRealGuard}${cr} >= -2 && ${cr} <= 0.25) { K.out[0] = 0; K.out[1] = 0; K.out[2] = 1; return Infinity; }`,
	].join("\n");
}

const wrap = (name: string, body: string): string =>
	body + `\n//# sourceURL=mandel-kernel/${name}.js`;

//---------------------------------------------------------------------------\\
// K1 f64 — the optimized z²+c Mandelbrot engine (escape-time, derivative for DE).
//---------------------------------------------------------------------------\\

function emitK1f64(usePeriod: boolean): string {
	const per = usePeriod ? `
if (n >= ${PERIOD_WARMUP}) {
	const rx = zx - refx, ry = zy - refy;
	if (rx * rx + ry * ry < eps2) { K.out[0] = 0; K.out[1] = n; K.out[2] = 2; return Infinity; }
	if (n === checkAt) { refx = zx; refy = zy; checkAt *= 2; }
}` : "";
	return wrap("k1f64", `
const eps2 = K.eps2;
${shortcuts("cr", "ci")}
let zx = 0, zy = 0, dzx = 0, dzy = 0, n = 0;
let refx = 0, refy = 0, checkAt = ${PERIOD_WARMUP};
while (n < maxIters) {
	const x2 = zx * zx, y2 = zy * zy;
	const mag2 = x2 + y2;
	if (mag2 > ${BAILOUT2}) {
		const zmag = Math.sqrt(mag2);
		const dmag = Math.sqrt(dzx * dzx + dzy * dzy);
		K.out[0] = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
		const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
		K.out[1] = n; K.out[2] = 0;
		return mu < 0 ? 0 : mu;
	}
	const ndzx = 2 * (zx * dzx - zy * dzy) + 1;
	const ndzy = 2 * (zx * dzy + zy * dzx);
	const nzx = x2 - y2 + cr;
	const nzy = 2 * zx * zy + ci;
	zx = nzx; zy = nzy;
	dzx = ndzx; dzy = ndzy;
	n++;${per}
}
K.out[0] = 0.5 * Math.log(dzx * dzx + dzy * dzy + 1e-300);
K.out[1] = n; K.out[2] = 3;
return -Infinity;`);
}

//---------------------------------------------------------------------------\\
// K1 pert — rebasing perturbation (Zhuoran): δ off the shared reference, fold on
// |z|<|δ| or reference exhaustion, full-z Brent. (cr,ci) = full coord, (ax,ay) = δc.
//---------------------------------------------------------------------------\\

function emitK1pert(usePeriod: boolean): string {
	const per = usePeriod ? `
	if (n >= ${PERIOD_WARMUP}) {
		const rx = zx - refx, ry = zy - refy;
		if (rx * rx + ry * ry < eps2) { K.out[0] = 0; K.out[1] = n; K.out[2] = 2; return Infinity; }
		if (n === checkAt) { refx = zx; refy = zy; checkAt *= 2; }
	}` : "";
	return wrap("k1pert", `
const eps2 = K.eps2;
const refZx = K.refZx, refZy = K.refZy, refLen = K.refLen;
const dcx = ax, dcy = ay;
${shortcuts("cr", "ci")}
let dx = 0, dy = 0, dzx = 0, dzy = 0, n = 0, m = 0;
let refx = 0, refy = 0, checkAt = ${PERIOD_WARMUP};
while (n < maxIters) {
	const Zx = refZx[m], Zy = refZy[m];
	const zx = Zx + dx, zy = Zy + dy;
	const z2 = zx * zx + zy * zy;
	if (z2 > ${BAILOUT2}) {
		const zmag = Math.sqrt(z2), dmag = Math.sqrt(dzx * dzx + dzy * dzy);
		K.out[0] = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
		const mu = n + 1 - Math.log(0.5 * Math.log(z2)) / Math.LN2;
		K.out[1] = n; K.out[2] = 0;
		return mu < 0 ? 0 : mu;
	}${per}
	const ndzx = 2 * (zx * dzx - zy * dzy) + 1, ndzy = 2 * (zx * dzy + zy * dzx);
	dzx = ndzx; dzy = ndzy;
	let bZx = Zx, bZy = Zy;
	if (z2 < dx * dx + dy * dy || m + 1 >= refLen) { dx = zx; dy = zy; bZx = 0; bZy = 0; m = 0; }
	const ndx = 2 * (bZx * dx - bZy * dy) + (dx * dx - dy * dy) + dcx;
	const ndy = 2 * (bZx * dy + bZy * dx) + 2 * dx * dy + dcy;
	dx = ndx; dy = ndy; m++; n++;
}
K.out[0] = 0.5 * Math.log(dzx * dzx + dzy * dzy + 1e-300);
K.out[1] = n; K.out[2] = 3;
return -Infinity;`);
}

//---------------------------------------------------------------------------\\
// K1 dd — the double-double twin, DD primitives INLINED (bit-identical op order to the
// old ddAdd/ddMul/ddSq call sequences). (cr,ci) = hi limbs, (ax,ay) = lo limbs.
//---------------------------------------------------------------------------\\

function emitK1dd(usePeriod: boolean): string {
	const e = new Emit();
	// Loop body, emitted in the exact sequence of the old escapeSmoothDD.
	const [zr2h, zr2l] = e.ddSq("zrhi", "zrlo");
	const [zi2h, zi2l] = e.ddSq("zihi", "zilo");
	e.push(`const mag2 = ${zr2h} + ${zi2h};`);
	e.push(`if (mag2 > ${BAILOUT2}) {
	const zmag = Math.sqrt(mag2);
	const dmag = Math.sqrt(dzxhi * dzxhi + dzyhi * dzyhi);
	K.out[0] = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
	const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
	K.out[1] = n; K.out[2] = 0;
	return mu < 0 ? 0 : mu;
}`);
	// z' = 2·z·z' + 1 (all DD; uses the current z)
	const [zdxh, zdxl] = e.ddMul("zrhi", "zrlo", "dzxhi", "dzxlo");
	const [zdyh, zdyl] = e.ddMul("zihi", "zilo", "dzyhi", "dzylo");
	const [dxh1, dxl1] = e.ddAdd(zdxh, zdxl, `-${zdyh}`, `-${zdyl}`);
	e.push(`const ndzxh2 = 2 * ${dxh1}, ndzxl2 = 2 * ${dxl1};`);
	const [dxh2, dxl2] = e.ddAdd("ndzxh2", "ndzxl2", "1", "0");
	const [zeyh, zeyl] = e.ddMul("zrhi", "zrlo", "dzyhi", "dzylo");
	const [zexh, zexl] = e.ddMul("zihi", "zilo", "dzxhi", "dzxlo");
	const [dyh1, dyl1] = e.ddAdd(zeyh, zeyl, zexh, zexl);
	e.push(`const ndzyh = 2 * ${dyh1}, ndzyl = 2 * ${dyl1};`);
	// zr' = zr² − zi² + cr ; zi' = 2·zr·zi + ci
	const [rh1, rl1] = e.ddAdd(zr2h, zr2l, `-${zi2h}`, `-${zi2l}`);
	const [rh2, rl2] = e.ddAdd(rh1, rl1, "cr", "ax");
	const [mh, ml] = e.ddMul("zrhi", "zrlo", "zihi", "zilo");
	e.push(`const nih = 2 * ${mh}, nil = 2 * ${ml};`);
	const [ih2, il2] = e.ddAdd("nih", "nil", "ci", "ay");
	e.push(`zrhi = ${rh2}; zrlo = ${rl2}; zihi = ${ih2}; zilo = ${il2};`);
	e.push(`dzxhi = ${dxh2}; dzxlo = ${dxl2}; dzyhi = ndzyh; dzylo = ndzyl;`);
	e.push("n++;");
	if (usePeriod) {
		const p = new Emit();
		const [drh] = p.ddAdd("zrhi", "zrlo", "-refxhi", "-refxlo");
		const [dih] = p.ddAdd("zihi", "zilo", "-refyhi", "-refylo");
		e.push(`if (n >= ${PERIOD_WARMUP}) {`);
		e.push(p.lines.join("\n"));
		e.push(`if (${drh} * ${drh} + ${dih} * ${dih} < eps2) { K.out[0] = 0; K.out[1] = n; K.out[2] = 2; return Infinity; }`);
		e.push(`if (n === checkAt) { refxhi = zrhi; refxlo = zrlo; refyhi = zihi; refylo = zilo; checkAt *= 2; }`);
		e.push("}");
	}
	return wrap("k1dd", `
const eps2 = K.eps2;
${shortcuts("cr", "ci", "ax === 0 && ")}
let zrhi = 0, zrlo = 0, zihi = 0, zilo = 0;
let dzxhi = 0, dzxlo = 0, dzyhi = 0, dzylo = 0, n = 0;
let refxhi = 0, refxlo = 0, refyhi = 0, refylo = 0, checkAt = ${PERIOD_WARMUP};
while (n < maxIters) {
${e.lines.join("\n")}
}
K.out[0] = 0.5 * Math.log(dzxhi * dzxhi + dzyhi * dzyhi + 1e-300);
K.out[1] = n; K.out[2] = 3;
return -Infinity;`);
}

//---------------------------------------------------------------------------\\
// K2 — the generalized f64 kernel: explicit z₀/c, formula step inlined, optional filter
// observer, generic Brent (escape-time only), finite guard, |z|²≥4 bailout, no derivative.
// (cr,ci) = z₀, (ax,ay) = c.
//---------------------------------------------------------------------------\\

function emitK2(spec: KernelSpec): string {
	const filter = spec.filterId !== 0 ? FILTERS[spec.filterId] : null;
	// Step: inlined z²+c or the compiled formula body (assigns _cre/_cim locals).
	const step = spec.formulaBody == null
		? "const nzx = zx * zx - zy * zy + cx, nzy = 2 * zx * zy + cy;\nzx = nzx; zy = nzy;"
		: "{\n" + spec.formulaBody + "\nzx = _cre; zy = _cim;\n}";
	// Trap geometry: Julia hoists the frame-constant ctx values; Mandelbrot computes per
	// pixel from |c|. Observer skip: Mandelbrot skips n=1 (see FilterDef.observer).
	const trapInit = filter
		? (spec.juliaMode
			? "let tLimit = K.trapLimit, tLo = K.trapLo, tHi = K.trapHi; const dStrands = K.dStrands;"
			: "const dStrands = K.dStrands; let tLimit = 0, tLo = 0, tHi = 0;\n" + filter.pixelInit)
		: "";
	const observer = filter ? filter.observer(spec.juliaMode ? "" : "if (n > 1) ") : "";
	const per = (!filter && spec.usePeriod) ? `
	if (n >= ${PERIOD_WARMUP}) {
		const prx = zx - psx, pry = zy - psy;
		if (prx * prx + pry * pry < eps2) { K.out[0] = 0; K.out[1] = n; K.out[2] = 2; return Infinity; }
		if (n === pchk) { psx = zx; psy = zy; pchk *= 2; }
	}` : "";
	const epilogue = filter
		? `K.out[1] = n; K.out[2] = escaped ? 0 : 3;
${filter.complete}`
		: `K.out[1] = n;
if (escaped) {
	K.out[0] = 0; K.out[2] = 0;
	const mag2 = zx * zx + zy * zy;
	if (!isFinite(mag2)) return n;
	const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
	return mu < 0 ? 0 : mu;
}
K.out[0] = 0; K.out[2] = 3;
return -Infinity;`;
	return wrap("k2", `
const eps2 = K.eps2;
const cx = ax, cy = ay;
${trapInit}
let zx = cr, zy = ci, n = 0, escaped = false;
${filter ? filter.locals : ""}
let _cre = 0, _cim = 0;
let psx = cr, psy = ci, pchk = ${PERIOD_WARMUP};
while (n < maxIters) {
	const mag2 = zx * zx + zy * zy;
	if (!(mag2 < ${BAILOUT_CUSTOM2})) { escaped = true; break; }
	${step}
	n++;
	${observer}${per}
}
${epilogue}`);
}

// One-step seed probe: is f_c(0) finite? Backs the Mandelbrot z₀ decision.
function emitProbeStep(formulaBody: string | null): string {
	const step = formulaBody == null
		? "const _cre = cx, _cim = cy;"   // z²+c at z=0 → c
		: "let zx = 0, zy = 0;\nvoid zx; void zy;\nlet _cre = 0, _cim = 0;\n{\n" + formulaBody + "\n}";
	return wrap("probeStep", `${step}\nreturn (isFinite(_cre) && isFinite(_cim)) ? 1 : 0;`);
}

//---------------------------------------------------------------------------\\
// Entry: assemble every variant for a frame spec. Callers cache by `key` and only
// re-install (and re-send to workers) when the key changes — reusing the same hot,
// JIT-warmed function objects across renders with an unchanged config.
//---------------------------------------------------------------------------\\

function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16);
}

export function assembleAll(spec: KernelSpec): AssembledKernels {
	const key = "p" + (spec.usePeriod ? 1 : 0) +
		"|f" + (spec.formulaBody != null ? djb2(spec.formulaBody) : "-") +
		"|t" + spec.filterId + "|j" + (spec.juliaMode ? 1 : 0);
	return {
		key,
		srcs: {
			k1f64: emitK1f64(spec.usePeriod),
			k1dd: emitK1dd(spec.usePeriod),
			k1pert: emitK1pert(spec.usePeriod),
			k2: emitK2(spec),
			probeStep: emitProbeStep(spec.formulaBody),
		},
	};
}
