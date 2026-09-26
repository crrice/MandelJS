// The view affine (math/frame.ts): the basis against Fractint's cvtcorners for both
// sample pars (conventions C2.2/C2.6), the axis-aligned view against the legacy mapping
// bit-for-bit, box-zoom composition, and a rotated deep view through perturbation.
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../dist/node-lib.js";

// Fractint cvtcorners (C2.2), transcribed: the three corners of a center-mag frame,
// relative to the centre. Returns the u (BL→BR) and v (BL→TL) edge vectors.
function cvtcorners(mag, xmag, rot, skew) {
	const h = 1 / mag, w = h / (0.75 * xmag);
	const t = Math.tan(skew * Math.PI / 180);
	const xmin = -w + h * t, xmax = w - h * t, x3 = -w - h * t, ymax = h, ymin = -h, y3 = -h;
	const R = rot * Math.PI / 180, cosR = Math.cos(R), sinR = Math.sin(R);
	const at = (x, y) => [x * cosR + y * sinR, -x * sinR + y * cosR];
	const TL = at(xmin, ymax), BR = at(xmax, ymin), BL = at(x3, y3);
	return { ux: BR[0] - BL[0], uy: BR[1] - BL[1], vx: TL[0] - BL[0], vy: TL[1] - BL[1] };
}

// The two par frames: center-mag Mag/Xmag/Rot/Skew, plus C2.6's M at the native grid
// (kx = N/(N-1), ky = Ny/(Ny-1)) as [[m00, m01], [m10, m11]].
const PARS = [
	{ name: "midget", mag: 4.017087e12, rot: -77.5, skew: 0.00994833980292832848, kx: 1600 / 1599, ky: 1200 / 1199,
		m: [[1.4376916958078537e-13, -4.864582985843738e-13], [6.485008157924808e-13, 1.07933827485486e-13]] },
	{ name: "golden", mag: 1.505545e10, rot: 72.5, skew: 0.00237908003330774415, kx: 1500 / 1499, ky: 1125 / 1124,
		m: [[5.32974488792573e-11, 1.2680829209659003e-10], [-1.690379118446715e-10, 3.997671210668109e-11]] },
];

function close(a, b, rel, msg) {
	assert.ok(Math.abs(a - b) <= rel * Math.abs(b), msg + ": " + a + " vs " + b);
}

test("frame basis matches cvtcorners and C2.6 for both pars", () => {
	for (const p of PARS) {
		const spanY = 2 / p.mag, spanX = spanY * 4 / 3;   // 4:3 frame, corners on the edges (kx = ky = 1)
		const f = M.viewFrame({ cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX, spanY, rot: p.rot, skew: p.skew, xmag: 1 });
		assert.equal(f.axis, false);
		const c = cvtcorners(p.mag, 1, p.rot, p.skew);
		for (const k of ["ux", "uy", "vx", "vy"]) close(f[k], c[k], 1e-12, p.name + " " + k);
		close(f.ux, p.m[0][0] / p.kx, 1e-12, p.name + " m00");
		close(f.uy, p.m[1][0] / p.kx, 1e-12, p.name + " m10");
		close(f.vx, p.m[0][1] / p.ky, 1e-12, p.name + " m01");
		close(f.vy, p.m[1][1] / p.ky, 1e-12, p.name + " m11");
	}
	// Xmag stretches the width only (w = h / (0.75·Xmag)).
	const f = M.viewFrame({ cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX: 4 / 3, spanY: 1, rot: 30, skew: 5, xmag: 2 });
	const c = cvtcorners(2, 2, 30, 5);
	for (const k of ["ux", "uy", "vx", "vy"]) close(f[k], c[k], 1e-12, "xmag " + k);
});

test("an axis-aligned view maps bit-for-bit like the legacy expressions", () => {
	const W = 640, H = 320, invW = 1 / W, invH = 1 / H;
	const base = { cx: -0.743643887037151, cxLo: 0, cy: 0.13182590420533, cyLo: 0, spanX: 0.000001, spanY: 0.000001 / 2 };
	for (const v of [base, { ...base, rot: 0, skew: 0, xmag: 1 }, { ...base, xmag: 0 }]) {
		assert.equal(M.isAxisView(v), true);
		const f = M.viewFrame(v);
		for (const px of [0.5, 17.25, 319.5, 320.5, 639.5]) {
			for (const py of [0.5, 100.75, 159.5, 160.5, 319.5]) {
				M.planeOffset(f, px * invW - 0.5, 0.5 - py * invH);
				assert.ok(Object.is(M._ox, (px * invW - 0.5) * v.spanX));
				assert.ok(Object.is(M._oy, (0.5 - py * invH) * v.spanY));
			}
		}
		assert.equal(M.fineSpan(v), v.spanX);
	}
	assert.equal(M.isAxisView({ ...base, rot: 1e-9 }), false);
});

// Render a small region of a permalink through the golden-runner recipe (1-sample pass).
function renderField(url, W, H, extra = {}, force = null) {
	const { state, rawView } = M.stateFromUrl(url);
	const view = { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: rawView.span / (W / H), rot: rawView.rot, skew: rawView.skew, xmag: rawView.xmag, ...extra };
	M.installKernels(M.assembleAll({ usePeriod: true, formulaBody: null, filterId: 0, juliaMode: state.juliaOn }).srcs);
	const useDD = force ? force.useDD : M.useDDFor(view, W), usePert = force ? force.usePert : useDD;
	M.setFrameState({ usePeriod: true, periodEps2: M.periodEps2For(view, useDD), useDD, usePert, bandMap: 2, ssaaOn: false });
	const maxIters = 3000;
	if (usePert) M.computeRef(view, maxIters);
	const mu = new Float32Array(W * H), de = new Float32Array(W * H);
	M.renderRegion(new Uint32Array(W * H), mu, de, W, 0, 0, W, H, W, H, view, maxIters, new Uint32Array(2), 0, 1 / 32, true, 0);
	return mu;
}

test("rot=0 renders identically to a view without the affine fields", () => {
	for (const url of ["?cx=-1&cy=0&span=4", "?cx=-1.415381481413331&cy=0.00122318048670787&span=6.6e-13"]) {
		const a = renderField(url, 64, 32), b = renderField(url, 64, 32, { rot: 0, skew: 0, xmag: 1 });
		assert.deepEqual(new Uint8Array(b.buffer), new Uint8Array(a.buffer), url);
	}
});

test("a rotated deep view agrees between perturbation and double-double", () => {
	const url = "?cx=-1.415381481413331&cy=0.00122318048670787&span=6.6e-13&rot=-77.5&skew=0.01";
	const W = 48, H = 24;
	const pert = renderField(url, W, H, {}, { useDD: true, usePert: true });
	const dd = renderField(url, W, H, {}, { useDD: true, usePert: false });
	const flat = renderField(url, W, H, { rot: 0, skew: 0 }, { useDD: true, usePert: false });
	let agree = 0, moved = 0;
	for (let i = 0; i < W * H; i++) {
		if (Math.abs(pert[i] - dd[i]) < 1e-3 || pert[i] === dd[i]) agree++;
		if (Math.abs(flat[i] - dd[i]) > 1e-3) moved++;
	}
	assert.ok(agree >= 0.99 * W * H, "pert/dd agreement " + agree + "/" + W * H);
	assert.ok(moved >= 0.5 * W * H, "rotation changed the image: " + moved + "/" + W * H);
});

test("a box zoom composes with the frame (rotation, skew, xmag persist)", () => {
	const v = { cx: -0.75, cxLo: 0, cy: 0.1, cyLo: 0, spanX: 0.5, spanY: 0.25, rot: 33, skew: 7, xmag: 1.5 };
	const r = [0.2, 0.3, 0.25, 0.25];   // box [x, y, w, h] as frame fractions (y from the top)
	// main.ts's zoom: recenter by the box-center offset, scale the spans, keep the affine.
	M.planeOffset(M.viewFrame(v), r[0] + r[2] / 2 - 0.5, 0.5 - (r[1] + r[3] / 2));
	const n = { ...v, cx: v.cx + M._ox, cy: v.cy + M._oy, spanX: v.spanX * r[2], spanY: v.spanY * r[3] };
	const fo = M.viewFrame(v), fn = M.viewFrame(n);
	for (const [u, w] of [[-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.13, -0.41], [0, 0]]) {
		M.planeOffset(fn, u, w); const nx = n.cx + M._ox, ny = n.cy + M._oy;
		M.planeOffset(fo, r[0] + r[2] * (u + 0.5) - 0.5, 0.5 - (r[1] + r[3] * (0.5 - w))); const ox = v.cx + M._ox, oy = v.cy + M._oy;
		assert.ok(Math.abs(nx - ox) < 1e-15 && Math.abs(ny - oy) < 1e-15, u + "," + w + ": " + nx + "," + ny + " vs " + ox + "," + oy);
	}
});

test("rot/skew/xmag URL rows: written only when non-default, read with defaults", () => {
	const s = M.defaultState();
	const v = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 2 };
	assert.equal(M.urlFromState(v, s), "?cx=-1&cy=0&span=4");
	assert.equal(M.urlFromState({ ...v, rot: 0, skew: 0, xmag: 1 }, s), "?cx=-1&cy=0&span=4");
	assert.equal(M.urlFromState({ ...v, cxLo: 1e-17, rot: -77.5, skew: 0.01, xmag: 2 }, s), "?cx=-1&cy=0&span=4&cxl=1e-17&rot=-77.5&skew=0.01&xmag=2");
	const plain = M.stateFromUrl("?cx=-1&cy=0&span=4").rawView;
	assert.deepEqual([plain.rot, plain.skew, plain.xmag], [0, 0, 1]);
	const odd = M.stateFromUrl("?cx=-1&cy=0&span=4&rot=abc&xmag=0").rawView;
	assert.deepEqual([odd.rot, odd.skew, odd.xmag], [0, 0, 1]);
});
