// Formula escape settings (z₀ + bailout radius) baked into the generated kernels: Fractint
// escape counting (conventions C3.2/C3.5/C4.4) against a literal port of calcmandfp, the
// DD/perturbation twins against it, Kernel 2's z₀ expression, the count = floor(mu)
// contract, and the translated goldenerror formula end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "../dist/node-lib.js";

// calcmandfp (C3.2), transcribed: z = c + p (p = 0) or z₀ = 0, then for k = 1..maxit−1 step
// and test |z|² ≥ rqlim; the count is k, maxit = inside.
function calcmandfp(cr, ci, maxit, rqlim, z0x, z0y) {
	let x = z0x, y = z0y;
	for (let k = 1; k < maxit; k++) {
		const x2 = x * x, y2 = y * y;
		y = 2 * x * y + ci; x = x2 - y2 + cr;
		if (x * x + y * y >= rqlim) return k;
	}
	return maxit;
}

// The count a kernel result carries: floor(mu) on escape, maxit for either in-set sentinel.
function countOf(mu, maxit) {
	assert.ok(!Number.isNaN(mu));
	return isFinite(mu) ? Math.floor(mu) : maxit;
}

const W = 48, H = 24;
function planeAt(view, px, py) {
	return [view.cx + ((px + 0.5) / W - 0.5) * view.spanX, view.cy + (0.5 - (py + 0.5) / H) * view.spanY];
}

// A 1-sample field through escapeAtPt (the golden-runner recipe), periodicity off so the
// comparison against the port is exact.
function field(view, esc, useDD, usePert, maxIters) {
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, ...esc }).srcs);
	M.setFrameState({ usePeriod: false, periodEps2: M.PERIOD_EPS2, useDD, usePert, bandMap: 0, ssaaOn: false });
	if (usePert) M.computeRef(view, maxIters);
	const mu = new Float32Array(W * H), de = new Float32Array(W * H);
	M.renderRegion(new Uint32Array(W * H), mu, de, W, 0, 0, W, H, W, H, view, maxIters, new Uint32Array(2), 0, 1, true, 0);
	return mu;
}

const FULL = { cx: -0.6, cxLo: 0, cy: 0, cyLo: 0, spanX: 3.2, spanY: 1.6 };
const SEAHORSE = { cx: -0.7453, cxLo: 0, cy: 0.1127, cyLo: 0, spanX: 0.01, spanY: 0.005 };

test("escapeSpec: defaults add no fields; z₀ routing and radii", () => {
	assert.deepEqual(M.escapeSpec("", null, false, false), {});
	assert.deepEqual(M.escapeSpec(" ", null, true, false), {});
	assert.deepEqual(M.escapeSpec("c", null, false, false), { bailR: 16, seedC: true });
	assert.deepEqual(M.escapeSpec("0", 2, false, false), { bailR: 2 });
	assert.deepEqual(M.escapeSpec("", 10, true, false), { bailR: 10 });
	assert.deepEqual(M.escapeSpec("C", null, true, false), { bailR: 2, z0Body: "_cre = cx; _cim = cy;" });
	assert.deepEqual(M.escapeSpec("0.5*c", 3, true, true), { bailR: 3 });   // Julia: z₀ is the pixel
	assert.equal(M.z0NeedsK2(""), false);
	assert.equal(M.z0NeedsK2(" 0 "), false);
	assert.equal(M.z0NeedsK2("c"), false);
	assert.equal(M.z0NeedsK2("0.5*c"), true);
	assert.equal(M.compileZ0("z + c").ok, false);
	assert.equal(M.compileZ0("0.5*c").body, M.compileFormula("0.5*c").body);
	const base = { usePeriod: true, formulaBody: null, filterId: 0, juliaMode: false };
	assert.equal(M.assembleAll({ ...base, ...M.escapeSpec("", null, false, false) }).key, M.assembleAll(base).key);
	assert.notEqual(M.assembleAll({ ...base, bailR: 2, seedC: true }).key, M.assembleAll({ ...base, bailR: 2 }).key);
});

test("Kernel 1 f64 counts equal calcmandfp exactly (z₀ = c and z₀ = 0, R = 2 and 10)", () => {
	const maxit = 1000;
	for (const view of [FULL, SEAHORSE]) {
		for (const [esc, rq, z0c] of [[{ bailR: 2, seedC: true }, 4, true], [{ bailR: 10 }, 100, false], [{ bailR: 10, seedC: true }, 100, true]]) {
			const mu = field(view, esc, false, false, maxit);
			let escaped = 0;
			for (let py = 0; py < H; py++) {
				for (let px = 0; px < W; px++) {
					const [cr, ci] = planeAt(view, px, py);
					const want = calcmandfp(cr, ci, maxit, rq, z0c ? cr : 0, z0c ? ci : 0);
					assert.equal(countOf(mu[py * W + px], maxit), want, JSON.stringify(esc) + " at " + cr + "," + ci);
					if (want < maxit) escaped++;
				}
			}
			assert.ok(escaped > W * H / 2, "escaped " + escaped);
		}
	}
});

test("Kernel 1 dd and perturbation agree with the port and each other", () => {
	const maxit = 1000;
	for (const view of [FULL, SEAHORSE]) {
		const esc = { bailR: 2, seedC: true };
		const dd = field(view, esc, true, false, maxit), pert = field(view, esc, true, true, maxit);
		let ddPort = 0, pertDD = 0;
		for (let py = 0; py < H; py++) {
			for (let px = 0; px < W; px++) {
				const [cr, ci] = planeAt(view, px, py), i = py * W + px;
				if (countOf(dd[i], maxit) === calcmandfp(cr, ci, maxit, 4, cr, ci)) ddPort++;
				if (countOf(pert[i], maxit) === countOf(dd[i], maxit)) pertDD++;
			}
		}
		assert.ok(ddPort >= 0.99 * W * H, "dd vs port " + ddPort + "/" + W * H);
		assert.ok(pertDD >= 0.99 * W * H, "pert vs dd " + pertDD + "/" + W * H);
	}
});

test("the cap: counts run 1..maxIters−1, then inside (C3.5)", () => {
	M.setFrameState({ usePeriod: false, periodEps2: M.PERIOD_EPS2, useDD: false, usePert: false, bandMap: 0, ssaaOn: false });
	for (const esc of [{ bailR: 2, seedC: true }, { bailR: 2 }]) {
		M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, ...esc }).srcs);
		const z0c = !!esc.seedC;
		// A slow escaper just outside the cusp: its count decides the cap boundary.
		const cr = 0.2501, ci = 0, n = calcmandfp(cr, ci, 100000, 4, z0c ? cr : 0, 0);
		assert.ok(n > 10 && n < 100000);
		assert.equal(Math.floor(M.escapeK1(cr, ci, n + 1)), n);    // maxit = n + 1: last countable step
		assert.equal(M.escapeK1(cr, ci, n), M.CAPPED);              // maxit = n: inside
		assert.equal(Math.floor(M.escapeK1(3, 0, 50)), 1);          // |c| ≥ R: count 1
	}
});

test("floor(mu) is the count, also after the Float32 store", () => {
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, bailR: 2, seedC: true }).srcs);
	M.setFrameState({ usePeriod: false, periodEps2: M.PERIOD_EPS2, useDD: false, usePert: false, bandMap: 0, ssaaOn: false });
	// |z| a hair above R: the smooth fraction is ~1 and would round up to the next count.
	for (const cr of [2 + 1e-12, 2 + 1e-9, 2.000001, 2.5, 3.9, 4, 1e6]) {
		const mu = M.escapeK1(cr, 0, 100);
		assert.equal(Math.floor(mu), 1, "c = " + cr);
		assert.equal(Math.floor(Math.fround(mu)), 1, "c = " + cr + " (f32)");
	}
	// Every stored Float32 of a field floors to the kernel's own f64 count.
	const mu = field(SEAHORSE, { bailR: 2, seedC: true }, false, false, 1000);
	for (let py = 0; py < H; py++) {
		for (let px = 0; px < W; px++) {
			const [cr, ci] = planeAt(SEAHORSE, px, py);
			assert.equal(countOf(mu[py * W + px], 1000), countOf(M.escapeK1(cr, ci, 1000), 1000));
		}
	}
});

test("Kernel 2: the z₀ expression, and z² + c from z₀ = c matching Kernel 1", () => {
	const maxit = 500;
	const frame = { usePeriod: false, periodEps2: M.PERIOD_EPS2, useDD: false, usePert: false, bandMap: 0, fractalMode: 1, ssaaOn: false };
	M.setFrameState(frame);
	const pts = [];
	for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) pts.push(planeAt(FULL, px, py));
	// The inlined z²+c step from z₀ = c/2 (the caller's z₀ args are ignored when baked).
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, ...M.escapeSpec("c*0.5", 3, true, false) }).srcs);
	for (const [cr, ci] of pts) assert.equal(countOf(M.escapeK2(7, 7, cr, ci, maxit), maxit), calcmandfp(cr, ci, maxit, 9, cr * 0.5, ci * 0.5));
	// A compiled z^2 + c from z₀ = c counts exactly like Kernel 1's shifted textbook orbit.
	const k2 = [];
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: M.compileFormula("z^2 + c").body, filterId: 0, juliaMode: false, ...M.escapeSpec("c", 2, true, false) }).srcs);
	for (const [cr, ci] of pts) k2.push(countOf(M.escapeK2(0, 0, cr, ci, maxit), maxit));
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, ...M.escapeSpec("c", 2, false, false) }).srcs);
	M.setFrameState({ ...frame, fractalMode: 0 });
	pts.forEach(([cr, ci], i) => assert.equal(countOf(M.escapeK1(cr, ci, maxit), maxit), k2[i], cr + "," + ci));
	// Julia keeps z₀ = the pixel, with the Fractint count.
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: true, ...M.escapeSpec("0.5*c", 2, true, true) }).srcs);
	M.setFrameState(frame);
	for (const [zx, zy] of pts) {
		let x = zx, y = zy, k = 1;
		for (; k < maxit; k++) { const x2 = x * x, y2 = y * y; y = 2 * x * y + 0.156; x = x2 - y2 - 0.8; if (x * x + y * y >= 4) break; }
		assert.equal(countOf(M.escapeK2(zx, zy, -0.8, 0.156, maxit), maxit), k);
	}
});

test("goldenerror: the translated MandAutoCritInZ renders with counts in 516..3199", () => {
	const text = readFileSync(fileURLToPath(new URL("../par/goldenerror.par", import.meta.url)), "utf8");
	const pf = M.parseParFile(text), e = pf.entries[0];
	const t = M.translateFrm(M.parBlock(pf, "frm", "MandAutoCritInZ").body, M.parGet(e, "params").split("/").map(Number), M.parGet(e, "function").split("/"));
	assert.ok(t.ok, JSON.stringify(t.report));
	const [cx, cy, mag, xmag, rot, skew] = M.parGet(e, "center-mag").split("/").map(Number);
	const GW = 16, GH = 12, maxit = Number(M.parGet(e, "maxiter"));
	const view = { cx, cxLo: 0, cy, cyLo: 0, spanX: (8 / 3) / mag, spanY: 2 / mag, rot, skew, xmag };
	M.installKernels(M.assembleAll({ usePeriod: true, formulaBody: M.compileFormula(t.formula).body, filterId: 0, juliaMode: false, ...M.escapeSpec(t.z0, t.bailout, true, false) }).srcs);
	M.setFrameState({ usePeriod: true, periodEps2: M.periodEps2For(view, false), useDD: false, usePert: false, bandMap: 0, fractalMode: 1, formulaId: M.FORMULA_CUSTOM, ssaaOn: false });
	const mu = new Float32Array(GW * GH), de = new Float32Array(GW * GH);
	M.renderRegion(new Uint32Array(GW * GH), mu, de, GW, 0, 0, GW, GH, GW, GH, view, maxit, new Uint32Array(2), 0, 1, true, 0);
	let escaped = 0;
	for (const m of mu) {
		assert.ok(!Number.isNaN(m));
		if (!isFinite(m)) continue;
		escaped++;
		assert.ok(Math.floor(m) >= 516 && Math.floor(m) <= 3199, "count " + m);
	}
	assert.ok(escaped >= GW * GH / 2, "escaped " + escaped + "/" + GW * GH);
});

test("z0 / bail URL rows: written only when set, read with validation", () => {
	const v = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 2 };
	const s = M.defaultState();
	assert.equal(M.urlFromState(v, s), "?cx=-1&cy=0&span=4");
	assert.equal(M.urlFromState(v, { ...s, z0: "c", bail: 2 }), "?cx=-1&cy=0&span=4&z0=c&bail=2");
	const r = M.stateFromUrl("?cx=-1&cy=0&span=4&z0=0.5*c&bail=10").state;
	assert.deepEqual([r.z0, r.bail], ["0.5*c", 10]);
	for (const b of ["0", "-3", "abc", ""]) assert.equal(M.stateFromUrl("?cx=-1&cy=0&span=4&bail=" + b).state.bail, null);
});
