// kernel/kernel.ts — the compute core's runtime half. Since P3 the ESCAPE KERNELS ARE
// GENERATED (kernel/assemble.ts): specialized source is compiled via new Function and
// installed here (installKernels), on the main thread and in every worker — one template,
// zero per-iteration config branches, DD primitives inlined. This module keeps what is
// NOT generated: the frame/color state + grouped setters, the pixel→plane dispatch
// (escapeAtPt — still the ONE mapping), the region/point primitives, the single coloring
// transfer (colorSample, filter readouts via the registry), and the perturbation
// reference builder. DOM-free; Node-importable.
import { ddAdd, ddMul, ddSq, _dhi, _dlo } from "../math/dd";
import { FILTERS } from "../filters/index";
import type { FilterColorFn } from "../filters/index";

//---------------------------------------------------------------------------\\
// Types + shared constants
//---------------------------------------------------------------------------\\

export interface View {
	cx: number;    // center real axis — HI limb of a double-double
	cxLo: number;  // center real axis — LO limb (center carried in DD; span stays f64)
	cy: number;    // center imaginary axis — HI limb
	cyLo: number;  // center imaginary axis — LO limb
	spanX: number;
	spanY: number;
}

export const DEFAULT_VIEW: View = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 2 };

export const DIST_SCALE = 1.5;   // distance-mode band rate
export const SS = 2;             // adaptive supersampling: SS×SS on edge pixels
export const EDGE_TH = 30;       // |dR|+|dG|+|dB| edge trigger
const BAILOUT2 = 256;            // z²+c escape radius² (wide, for smooth bands)

// Periodicity ε² calibration (consumed by the renderer's periodEps2For; the live value
// travels in the frame state and is read by the generated kernels via ctx).
export const PERIOD_EPS2 = 1e-20;
export const PERIOD_EPS2_FLOOR = 1e-28;
export const PERIOD_EPS2_FLOOR_DD = 1e-56;
export const PERIOD_EPS_ZOOM0 = 1e5;

// Sentinel for points that hit the iteration cap UNRESOLVED (in-set is +Infinity;
// -Infinity so isFinite rejects both sentinels at once).
export const CAPPED = -Infinity;

export const FORMULA_MANDEL = 0;
export const FORMULA_CUSTOM = 1;
export const FILTER_NONE = 0;

// Side-channel from the most recent escape call (distance estimate / capped log|z'| /
// filter parity). Defined 0 on in-set returns since P3 (the old kernels left it stale).
let deDist = 0;

// Deterministic instrumentation: total iterations + outcome tallies since resetTallies().
export let iterAcc = 0;
export let escAcc = 0, inAcc = 0, perAcc = 0, capAcc = 0;

//---------------------------------------------------------------------------\\
// Installed generated kernels (see assemble.ts for the ABI).
//---------------------------------------------------------------------------\\

export type GenKernel = (cr: number, ci: number, ax: number, ay: number, maxIters: number, K: KernelCtx) => number;

export interface KernelCtx {
	eps2: number;
	refZx: Float64Array; refZy: Float64Array; refLen: number;
	trapLimit: number; trapLo: number; trapHi: number; dStrands: number;
	out: Float64Array;   // [deDist-channel, iterations, outcome 0 esc/1 in/2 period/3 cap]
}

const KCTX: KernelCtx = {
	eps2: PERIOD_EPS2,
	refZx: new Float64Array(1), refZy: new Float64Array(1), refLen: 0,
	trapLimit: 0, trapLo: 0, trapHi: 0, dStrands: 0.08,
	out: new Float64Array(3),
};

let kF64: GenKernel | null = null;
let kDD: GenKernel | null = null;
let kPert: GenKernel | null = null;
let kK2: GenKernel | null = null;
let kProbe: ((cx: number, cy: number) => number) | null = null;

// Compile + install a generated kernel set (from assembleAll). Called on the main thread
// by the pipeline and in each worker from the {type:"kernels"} message. Callers cache by
// the assembly key — an unchanged config re-uses the SAME hot (JIT-warmed) functions.
export function installKernels(srcs: { k1f64: string; k1dd: string; k1pert: string; k2: string; probeStep: string }): void {
	// eslint-disable-next-line no-new-func
	kF64 = new Function("cr", "ci", "ax", "ay", "maxIters", "K", srcs.k1f64) as GenKernel;
	kDD = new Function("cr", "ci", "ax", "ay", "maxIters", "K", srcs.k1dd) as GenKernel;
	kPert = new Function("cr", "ci", "ax", "ay", "maxIters", "K", srcs.k1pert) as GenKernel;
	kK2 = new Function("cr", "ci", "ax", "ay", "maxIters", "K", srcs.k2) as GenKernel;
	kProbe = new Function("cx", "cy", srcs.probeStep) as (cx: number, cy: number) => number;
}

// Fold a kernel call's exit side-channels into the module tallies + deDist.
function fold(mu: number): number {
	const o = KCTX.out;
	deDist = o[0];
	iterAcc += o[1];
	const code = o[2];
	if (code === 0) escAcc++;
	else if (code === 1) inAcc++;
	else if (code === 2) perAcc++;
	else capAcc++;
	return mu;
}

// Direct entries for the renderer's dwell probe (explicit wiring, no pixel mapping).
export function escapeK1(cr: number, ci: number, maxIters: number): number {
	return fold(kF64!(cr, ci, 0, 0, maxIters, KCTX));
}
export function escapeK2(z0x: number, z0y: number, cx: number, cy: number, maxIters: number): number {
	return fold(kK2!(z0x, z0y, cx, cy, maxIters, KCTX));
}
// One-step seed probe: is f_c(0) finite? (Backs the Mandelbrot z₀=0 vs z₀=c decision.)
export function probeStepFinite(cx: number, cy: number): boolean {
	return kProbe!(cx, cy) === 1;
}

//---------------------------------------------------------------------------\\
// Per-frame configuration (module-private; written via the grouped setters).
//---------------------------------------------------------------------------\\

let fractalMode = 0;            // 0 = Kernel 1 (z²+c engine), 1 = Kernel 2 (generalized)
let juliaMode = false;
let juliaCx = 0, juliaCy = 0;
let mSeedAtC = false;
let filterId = 0;
let activeColor: FilterColorFn | null = null;   // registry readout for the active filter
let filterDFactor = 1, filterBlend = 0, filterDensity = 1;
let useDD = false;
let usePert = false;
let bandMap = 0;
let provOn = false, provLo = 0, provHi = 1;
let provLut: Uint32Array | null = null;
let ssaaOn = true;

// Perturbation reference (built once per generation by computeRef; consumed via KCTX).
let refZx = new Float64Array(1), refZy = new Float64Array(1), refLen = 0;
let refOffX = 0, refOffY = 0;

export interface KernelFrameState {
	usePeriod: boolean; periodEps2: number; useDD: boolean; usePert: boolean;
	bandMap: number;
	fractalMode?: number; formulaId?: number; juliaMode?: boolean; mSeedAtC?: boolean;
	juliaCx?: number; juliaCy?: number;
	filterId?: number; trapDStrands?: number; filterDFactor?: number; filterBlend?: number; filterDensity?: number;
	ssaaOn?: boolean;
}

// Apply a frame's compute configuration (defaults mirror the worker-message conventions),
// then run the per-frame filter init (the Julia-case trap geometry). NOTE: usePeriod and
// the formula are BAKED into the generated kernels — here they only shape the ctx.
export function setFrameState(s: KernelFrameState): void {
	KCTX.eps2 = s.periodEps2;
	useDD = s.useDD;
	usePert = s.usePert;
	bandMap = s.bandMap;
	fractalMode = s.fractalMode || 0;
	juliaMode = !!s.juliaMode;
	mSeedAtC = !!s.mSeedAtC;
	juliaCx = s.juliaCx || 0;
	juliaCy = s.juliaCy || 0;
	filterId = s.filterId || 0;
	activeColor = filterId !== 0 && FILTERS[filterId] ? FILTERS[filterId].color : null;
	KCTX.dStrands = s.trapDStrands || 0.08;
	filterDFactor = s.filterDFactor || 1;
	filterBlend = s.filterBlend || 0;
	filterDensity = s.filterDensity || 1;
	ssaaOn = s.ssaaOn !== false;
	// Julia-case (frame-constant) trap geometry; Mandelbrot recomputes per pixel in-kernel.
	KCTX.trapLimit = Math.hypot(juliaCx, juliaCy);
	KCTX.trapLo = KCTX.trapLimit - KCTX.dStrands;
	KCTX.trapHi = KCTX.trapLimit + KCTX.dStrands;
}

export interface KernelColorState {
	provOn: boolean; provLo: number; provHi: number; provLut: Uint32Array | null;
	filterId: number; filterDFactor: number; filterBlend: number; filterDensity: number;
}

// Apply the color-pass configuration colorSample reads. Called before every main-thread
// color pass so none can run on stale state.
export function setColorState(s: KernelColorState): void {
	provOn = s.provOn;
	provLo = s.provLo;
	provHi = s.provHi;
	provLut = s.provLut;
	filterId = s.filterId;
	activeColor = s.filterId !== 0 && FILTERS[s.filterId] ? FILTERS[s.filterId].color : null;
	filterDFactor = s.filterDFactor;
	filterBlend = s.filterBlend;
	filterDensity = s.filterDensity;
}

export function resetTallies(): void {
	iterAcc = 0; escAcc = 0; inAcc = 0; perAcc = 0; capAcc = 0;
}

//---------------------------------------------------------------------------\\
// Perturbation reference — a coarse probe finds a deep (non-escaping) point, then its DD
// orbit is stored as f64 hi-limbs. Handwritten (setup code, once per generation — not
// hot-loop duplication); the DD step here mirrors the generated dd kernel's math.
//---------------------------------------------------------------------------\\

function refOrbitLen(crhi: number, crlo: number, cihi: number, cilo: number, maxIters: number): number {
	let zxh = 0, zxl = 0, zyh = 0, zyl = 0;
	for (let n = 0; n < maxIters; n++) {
		if (zxh * zxh + zyh * zyh > BAILOUT2) return n;
		ddSq(zxh, zxl); const x2h = _dhi, x2l = _dlo;
		ddSq(zyh, zyl); const y2h = _dhi, y2l = _dlo;
		ddAdd(x2h, x2l, -y2h, -y2l); let rh = _dhi, rl = _dlo; ddAdd(rh, rl, crhi, crlo); rh = _dhi; rl = _dlo;
		ddMul(zxh, zxl, zyh, zyl); let ih = 2 * _dhi, il = 2 * _dlo; ddAdd(ih, il, cihi, cilo); ih = _dhi; il = _dlo;
		zxh = rh; zxl = rl; zyh = ih; zyl = il;
	}
	return maxIters;
}

export function computeRef(view: View, maxIters: number): void {
	const PW = 8, PH = 8;
	let bx = 0, by = 0, best = -1;
	for (let j = 0; j < PH && best < maxIters; j++) {
		for (let i = 0; i < PW; i++) {
			const ox = ((i + 0.5) / PW - 0.5) * view.spanX, oy = (0.5 - (j + 0.5) / PH) * view.spanY;   // Im up (matches escapeAtPt)
			ddAdd(view.cx, view.cxLo, ox, 0); const crhi = _dhi, crlo = _dlo;
			ddAdd(view.cy, view.cyLo, oy, 0); const cihi = _dhi, cilo = _dlo;
			const len = refOrbitLen(crhi, crlo, cihi, cilo, maxIters);
			if (len > best) { best = len; bx = ox; by = oy; }
			if (len >= maxIters) break;
		}
	}
	refOffX = bx; refOffY = by;
	if (refZx.length < maxIters + 1) { refZx = new Float64Array(maxIters + 1); refZy = new Float64Array(maxIters + 1); }
	ddAdd(view.cx, view.cxLo, bx, 0); const crhi = _dhi, crlo = _dlo;
	ddAdd(view.cy, view.cyLo, by, 0); const cihi = _dhi, cilo = _dlo;
	let zxh = 0, zxl = 0, zyh = 0, zyl = 0; refLen = maxIters;
	for (let n = 0; n < maxIters; n++) {
		refZx[n] = zxh; refZy[n] = zyh;
		if (zxh * zxh + zyh * zyh > BAILOUT2) { refLen = n; break; }
		ddSq(zxh, zxl); const x2h = _dhi, x2l = _dlo;
		ddSq(zyh, zyl); const y2h = _dhi, y2l = _dlo;
		ddAdd(x2h, x2l, -y2h, -y2l); let rh = _dhi, rl = _dlo; ddAdd(rh, rl, crhi, crlo); rh = _dhi; rl = _dlo;
		ddMul(zxh, zxl, zyh, zyl); let ih = 2 * _dhi, il = 2 * _dlo; ddAdd(ih, il, cihi, cilo); ih = _dhi; il = _dlo;
		zxh = rh; zxl = rl; zyh = ih; zyl = il;
	}
	refZx[refLen] = zxh; refZy[refLen] = zyh;
	// Refresh the ctx views (computeRef may have reallocated the arrays).
	KCTX.refZx = refZx; KCTX.refZy = refZy; KCTX.refLen = refLen;
}

// Read access to the reference state (harness + wiring).
export function refState(): { zx: Float64Array; zy: Float64Array; len: number; offX: number; offY: number } {
	return { zx: refZx, zy: refZy, len: refLen, offX: refOffX, offY: refOffY };
}

//---------------------------------------------------------------------------\\
// Coloring transfer — colorSample stays the ONE (mu, de) → RGBA function.
//---------------------------------------------------------------------------\\

function bandTransform(mu: number, bandMapN: number): number {
	if (bandMapN === 1) return Math.sqrt(mu);
	if (bandMapN === 2) return Math.log2(1 + mu);
	return mu;
}

export function colorSample(
	mu: number, de: number, lut: Uint32Array, inSet: number,
	mode: number, cyclic: boolean, densityMul: number,
	pixelSize: number, bandMapN: number, lvlLo: number, lvlHi: number,
): number {
	if (activeColor) return activeColor(mu, de, lut, inSet, filterDFactor, filterBlend, filterDensity);   // filter mode: (mu,de) = (intensity, parity)
	if (mu === -Infinity) {                                 // CAPPED (unresolved this pass)
		if (!provOn || !provLut) return inSet;
		let tp = (de - provLo) / (provHi > provLo ? provHi - provLo : 1);   // de carries log|z'|
		tp = tp < 0 ? 0 : tp > 1 ? 1 : tp;
		return provLut[(tp * (provLut.length - 1)) | 0];
	}
	if (!isFinite(mu)) return inSet;                        // IN_SET (+inf) or NaN
	const lastIdx = lut.length - 1;
	if (mode === 1) {                                        // distance estimate
		let td = Math.log(1 + de / pixelSize) * DIST_SCALE;
		td -= (td | 0);
		return lut[(td * lastIdx) | 0];
	}
	const g = bandTransform(mu, bandMapN);
	if (cyclic) {
		let t = g * densityMul;
		t -= (t | 0);
		return lut[(t * lastIdx) | 0];
	}
	const glo = bandTransform(lvlLo, bandMapN);
	const ghi = bandTransform(lvlHi, bandMapN);
	let t = (g - glo) / (ghi > glo ? ghi - glo : 1);
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return lut[(t * lastIdx) | 0];
}

//---------------------------------------------------------------------------\\
// escapeAtPt — the ONE pixel→plane mapping (imaginary axis UP) + the per-frame dispatch
// to the installed kernels. Shared by renderRegion / sharpenPoints / ssaaPoints.
//---------------------------------------------------------------------------\\

export function escapeAtPt(px: number, py: number, view: View, maxIters: number, invW: number, invH: number): number {
	const offX = (px * invW - 0.5) * view.spanX;
	const offY = (0.5 - py * invH) * view.spanY;   // screen row 0 = MAX Im (standard math convention)
	if (fractalMode) {
		const pxc = view.cx + offX, pyc = view.cy + offY;
		if (juliaMode) return fold(kK2!(pxc, pyc, juliaCx, juliaCy, maxIters, KCTX));   // z₀ = pixel, c = seed
		return mSeedAtC
			? fold(kK2!(pxc, pyc, pxc, pyc, maxIters, KCTX))    // heuristic parameter map: z₀ = c
			: fold(kK2!(0, 0, pxc, pyc, maxIters, KCTX));       // canonical: z₀ = 0
	}
	if (usePert) {
		return fold(kPert!(view.cx + offX, view.cy + offY, offX - refOffX, offY - refOffY, maxIters, KCTX));
	}
	if (useDD) {
		ddAdd(view.cx, view.cxLo, offX, 0); const crhi = _dhi, crlo = _dlo;
		ddAdd(view.cy, view.cyLo, offY, 0); const cihi = _dhi, cilo = _dlo;
		return fold(kDD!(crhi, cihi, crlo, cilo, maxIters, KCTX));
	}
	return fold(kF64!(view.cx + offX, view.cy + offY, 0, 0, maxIters, KCTX));
}

//---------------------------------------------------------------------------\\
// Region + point primitives (unchanged from P0 — they consume escapeAtPt + colorSample).
//---------------------------------------------------------------------------\\

export function renderRegion(
	out: Uint32Array, muOut: Float32Array, deOut: Float32Array, outStride: number,
	ox: number, oy: number, tw: number, th: number,
	canvasW: number, canvasH: number,
	view: View, maxIters: number,
	lut: Uint32Array, inSet: number, densityMul: number, cyclic: boolean, mode: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH;
	const pixelSize = view.spanX * invW;
	const invSS = 1 / SS, nSub = SS * SS;

	function colorOf(mu: number, de: number): number {
		return colorSample(mu, de, lut, inSet, mode, cyclic, densityMul, pixelSize, bandMap, 0, 1 / densityMul);
	}
	function escapeAt(px: number, py: number): number {
		return escapeAtPt(px, py, view, maxIters, invW, invH);
	}
	function colorAt(fx: number, fy: number): number {
		const mu = escapeAt(fx, fy);
		return colorOf(mu, deDist);
	}
	function colorDiff(a: number, b: number): number {
		return Math.abs((a & 255) - (b & 255)) +
			Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
			Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
	}

	// 1-sample fast path (initial frame): no border, no supersampling.
	if (!ssaaOn) {
		for (let ly = 0; ly < th; ly++) {
			let off = ly * outStride;
			for (let lx = 0; lx < tw; lx++, off++) {
				const mu = escapeAt(ox + lx + 0.5, oy + ly + 0.5);
				const de = deDist;
				out[off] = colorOf(mu, de);
				const p = ly * tw + lx; muOut[p] = mu; deOut[p] = de;
			}
		}
		return;
	}

	// Pass 1: one CENTERED sample per pixel + a 1px border (edge detection only).
	const sw = tw + 2;
	const s1 = new Uint32Array(sw * (th + 2));
	for (let j = -1; j <= th; j++) {
		const row = (j + 1) * sw;
		const inY = j >= 0 && j < th;
		for (let i = -1; i <= tw; i++) {
			const mu = escapeAt(ox + i + 0.5, oy + j + 0.5);
			const de = deDist;
			s1[row + i + 1] = colorOf(mu, de);
			if (inY && i >= 0 && i < tw) { const p = j * tw + i; muOut[p] = mu; deOut[p] = de; }
		}
	}

	// Pass 2: supersample only edges.
	const doSS = SS > 1;
	for (let ly = 0; ly < th; ly++) {
		let off = ly * outStride;
		const srow = (ly + 1) * sw;
		for (let lx = 0; lx < tw; lx++, off++) {
			const si = srow + lx + 1;
			const c = s1[si];
			if (doSS && (
				colorDiff(c, s1[si + 1]) > EDGE_TH ||
				colorDiff(c, s1[si - 1]) > EDGE_TH ||
				colorDiff(c, s1[si + sw]) > EDGE_TH ||
				colorDiff(c, s1[si - sw]) > EDGE_TH)) {
				let ar = 0, ag = 0, ab = 0;
				for (let sy = 0; sy < SS; sy++) {
					const fy = oy + ly + (sy + 0.5) * invSS;
					for (let sx = 0; sx < SS; sx++) {
						const cc = colorAt(ox + lx + (sx + 0.5) * invSS, fy);
						ar += cc & 255; ag += (cc >> 8) & 255; ab += (cc >> 16) & 255;
					}
				}
				out[off] = ((255 << 24) | (((ab / nSub) | 0) << 16) | (((ag / nSub) | 0) << 8) | ((ar / nSub) | 0)) >>> 0;
			} else {
				out[off] = c;
			}
		}
	}
}

// Re-iterate ONLY the still-CAPPED points of a tile at a higher cap (packed to idx).
export function sharpenPoints(
	muOut: Float32Array, deOut: Float32Array, idx: Int32Array,
	ox: number, oy: number, tw: number, canvasW: number, canvasH: number,
	view: View, maxIters: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH;
	for (let k = 0; k < idx.length; k++) {
		const p = idx[k], lx = p % tw, ly = (p / tw) | 0;
		muOut[k] = escapeAtPt(ox + lx + 0.5, oy + ly + 0.5, view, maxIters, invW, invH);
		deOut[k] = deDist;
	}
}

// Background anti-aliasing: raw SS² subsamples per listed edge pixel (packed to idx).
export function ssaaPoints(
	muOut: Float32Array, deOut: Float32Array, idx: Int32Array,
	ox: number, oy: number, tw: number, canvasW: number, canvasH: number,
	view: View, maxIters: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH, invSS = 1 / SS, nSub = SS * SS;
	for (let k = 0; k < idx.length; k++) {
		const p = idx[k], lx = p % tw, ly = (p / tw) | 0;
		let o = k * nSub;
		for (let sy = 0; sy < SS; sy++) {
			const fy = oy + ly + (sy + 0.5) * invSS;
			for (let sx = 0; sx < SS; sx++) {
				muOut[o] = escapeAtPt(ox + lx + (sx + 0.5) * invSS, fy, view, maxIters, invW, invH);
				deOut[o] = deDist;
				o++;
			}
		}
	}
}
