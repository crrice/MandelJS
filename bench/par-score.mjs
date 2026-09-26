// bench/par-score.mjs — the Fractint reference score (conventions C6.5 Tier 1): import each
// par/*.par through the app's importer, render it with AA off at its JPEG's size, point-
// sample a stride grid of pixel centers, and score the render against the committed JPEG
// (Fractint output, rendered at 3x and downscaled — C6.1 — so pixel-exact is not the bar):
//
//   idx       idx-exact: the fraction of UNAMBIGUOUS samples (nearest palette distance ≤ 25,
//             the nearest differently-colored entry ≥ 1.5× as far) whose nearest palette
//             entry is the rendered index. Compared by entry COLOR, so duplicate entries
//             count as equal.
//   idx1      the same within ±1 index.
//   flat      flat-region palette agreement: samples whose index equals their 4 grid
//             neighbors', grouped by index (groups of ≥ 20); the sample-weighted fraction
//             in groups whose mean JPEG color is within ±2 levels of the entry per channel.
//   rawMed / rawMean  Euclidean RGB distance, rendered vs JPEG, over all samples.
//   Negative controls (idx-exact, must fall below the ceiling): count +1, count −1 (the
//   same render re-indexed), and the rotation sign flipped (a re-render on the controls'
//   coarser grid).
//
// The JPEGs are decoded libjpeg-style (decodeJpeg), matching the decoder the thresholds
// were measured with. Gates and the last recorded numbers live in goldens/par-scores.json. Stride grids keep
// runtimes sensible: goldenerror is Kernel 2 with two complex pow per iteration (counts
// 541..3199), so it samples every 3rd pixel; the rotation control every 2×stride-th.
//
//   npm run score                    score + gate
//   PAR_SCORE_UPDATE=1 npm run score also record the measured numbers
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import * as M from "../dist/node-lib.js";
import { loadPar, renderGrid } from "./par-render.mjs";

const scoresPath = fileURLToPath(new URL("../goldens/par-scores.json", import.meta.url));
const scores = JSON.parse(readFileSync(scoresPath, "utf8"));
const UPDATE = !!process.env.PAR_SCORE_UPDATE;
const root = new URL("../", import.meta.url);

// Decode a 4:2:0 JPEG the way the metrics' reference decoder (libjpeg, PIL) does: jpeg-js's
// raw Y/Cb/Cr planes (its nearest-neighbor chroma, sampled back at the even pixels), then
// libjpeg's h2v2 "fancy" triangle upsampling and fixed-point YCbCr → RGB. Within 3 levels
// of libjpeg everywhere (IDCT rounding); jpeg-js's own nearest chroma costs ~2% idx-exact.
function decodeJpeg(buf) {
	const { width: W, height: H, data: ycc } = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, colorTransform: false });
	const cw = (W + 1) >> 1, ch = (H + 1) >> 1;
	function upsample(c) {
		const plane = new Int32Array(cw * ch);
		for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) plane[j * cw + i] = ycc[(2 * j * W + 2 * i) * 3 + c];
		const up = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			const j = y >> 1, jn = y & 1 ? Math.min(j + 1, ch - 1) : Math.max(j - 1, 0);   // the nearer neighbor row
			const col = i => plane[j * cw + i] * 3 + plane[jn * cw + i];
			for (let i = 0; i < cw; i++) {
				const t = col(i);
				const a = i > 0 ? (t * 3 + col(i - 1) + 8) >> 4 : (t * 4 + 8) >> 4;
				const b = i < cw - 1 ? (t * 3 + col(i + 1) + 7) >> 4 : (t * 4 + 7) >> 4;
				up[y * W + 2 * i] = a;
				if (2 * i + 1 < W) up[y * W + 2 * i + 1] = b;
			}
		}
		return up;
	}
	const cb = upsample(1), cr = upsample(2);
	const FIX = v => Math.round(v * 65536), HALF = 1 << 15;
	const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
	const rgb = new Uint8Array(W * H * 3);
	for (let p = 0; p < W * H; p++) {
		const y = ycc[p * 3], b = cb[p] - 128, r = cr[p] - 128;
		rgb[p * 3] = clamp(y + ((FIX(1.402) * r + HALF) >> 16));
		rgb[p * 3 + 1] = clamp(y + ((-FIX(0.34414) * b - FIX(0.71414) * r + HALF) >> 16));
		rgb[p * 3 + 2] = clamp(y + ((FIX(1.772) * b + HALF) >> 16));
	}
	return { width: W, height: H, data: rgb };
}

function grid(n, stride) {
	const g = [];
	for (let p = stride >> 1; p < n; p += stride) g.push(p);
	return g;
}

// The Fractint palette index a sample rendered with (colorSample's discrete map path):
// inside → the inside entry; else wrap(logmap(count)), count = floor(mu) (≥ 1) + delta.
function indexOf(mu, delta, state, logTable, maxIters) {
	if (!isFinite(mu)) return state.mapInside;
	const k = Math.max(1, Math.max(1, Math.floor(mu)) + delta);
	return M.colorWrap(logTable ? logTable[Math.min(k, maxIters)] : k);
}

// Nearest palette entry per JPEG sample (-1 = ambiguous).
function nearestEntries(img, W, xs, ys, pal8) {
	const near = new Int16Array(xs.length * ys.length);
	for (let j = 0; j < ys.length; j++) {
		for (let i = 0; i < xs.length; i++) {
			const o = (ys[j] * W + xs[i]) * 3;
			const r = img[o], g = img[o + 1], b = img[o + 2];
			let d1 = Infinity, e1 = -1;
			const d = new Float64Array(256);
			for (let e = 0; e < 256; e++) {
				const dr = r - pal8[e * 3], dg = g - pal8[e * 3 + 1], db = b - pal8[e * 3 + 2];
				d[e] = Math.sqrt(dr * dr + dg * dg + db * db);
				if (d[e] < d1) { d1 = d[e]; e1 = e; }
			}
			let d2 = Infinity;
			for (let e = 0; e < 256; e++) if (d[e] < d2 && !sameEntry(pal8, e, e1)) d2 = d[e];
			near[j * xs.length + i] = d1 <= 25 && d2 >= 1.5 * d1 ? e1 : -1;
		}
	}
	return near;
}

function sameEntry(pal8, a, b) {
	return pal8[a * 3] === pal8[b * 3] && pal8[a * 3 + 1] === pal8[b * 3 + 1] && pal8[a * 3 + 2] === pal8[b * 3 + 2];
}

// idx-exact (and within ±1) of the indices idx against the nearest entries near.
function idxExact(idx, near, pal8) {
	let n = 0, hit = 0, hit1 = 0;
	for (let p = 0; p < idx.length; p++) {
		const e = near[p];
		if (e < 0) continue;
		n++;
		if (sameEntry(pal8, idx[p], e)) hit++;
		if (sameEntry(pal8, idx[p], e) || sameEntry(pal8, (idx[p] + 1) & 255, e) || sameEntry(pal8, (idx[p] + 255) & 255, e)) hit1++;
	}
	return { n, idx: hit / n, idx1: hit1 / n };
}

function round4(x) {
	return Math.round(x * 1e4) / 1e4;
}

let failures = 0;
for (const s of scores.pars) {
	const t0 = performance.now();
	const { state, rawView } = loadPar(fileURLToPath(new URL(s.par, root)), s.entry);
	const img = decodeJpeg(readFileSync(fileURLToPath(new URL(s.jpg, root))));
	const W = img.width, H = img.height;
	const pal8 = M.pal8FromPal6(M.decodeColors(state.map).pal6);
	const xs = grid(W, s.stride), ys = grid(H, s.stride);
	const r = await renderGrid(state, rawView, W, H, xs, ys);
	const logTable = M.logmapTable(state.logmap, r.maxIters);
	const near = nearestEntries(img.data, W, xs, ys, pal8);
	const N = xs.length * ys.length;

	// The render's own indices (checked against its colors: the index path must be exact).
	const idx = new Uint8Array(N), plus = new Uint8Array(N), minus = new Uint8Array(N);
	const dist = new Float64Array(N);
	let badColor = 0;
	for (let p = 0; p < N; p++) {
		idx[p] = indexOf(r.mu[p], 0, state, logTable, r.maxIters);
		plus[p] = indexOf(r.mu[p], 1, state, logTable, r.maxIters);
		minus[p] = indexOf(r.mu[p], -1, state, logTable, r.maxIters);
		const c = r.out[p];
		if ((c & 255) !== pal8[idx[p] * 3] || ((c >> 8) & 255) !== pal8[idx[p] * 3 + 1] || ((c >> 16) & 255) !== pal8[idx[p] * 3 + 2]) badColor++;
		const j = Math.floor(p / xs.length), o = (ys[j] * W + xs[p - j * xs.length]) * 3;
		const dr = (c & 255) - img.data[o], dg = ((c >> 8) & 255) - img.data[o + 1], db = ((c >> 16) & 255) - img.data[o + 2];
		dist[p] = Math.sqrt(dr * dr + dg * dg + db * db);
	}
	const main = idxExact(idx, near, pal8);
	const sorted = dist.slice().sort();
	let sum = 0;
	for (let p = 0; p < N; p++) sum += dist[p];

	// Flat regions: the index agrees with the 4 grid neighbors.
	const groups = new Map();
	for (let j = 1; j < ys.length - 1; j++) {
		for (let i = 1; i < xs.length - 1; i++) {
			const p = j * xs.length + i, e = idx[p];
			if (idx[p - 1] !== e || idx[p + 1] !== e || idx[p - xs.length] !== e || idx[p + xs.length] !== e) continue;
			const o = (ys[j] * W + xs[i]) * 3;
			const g = groups.get(e) || [0, 0, 0, 0];
			g[0]++; g[1] += img.data[o]; g[2] += img.data[o + 1]; g[3] += img.data[o + 2];
			groups.set(e, g);
		}
	}
	let flatN = 0, flatOk = 0;
	for (const [e, g] of groups) {
		if (g[0] < 20) continue;
		flatN += g[0];
		if ([1, 2, 3].every(c => Math.abs(g[c] / g[0] - pal8[e * 3 + c - 1]) <= 2)) flatOk += g[0];
	}

	// Negative controls.
	const cPlus = idxExact(plus, near, pal8).idx, cMinus = idxExact(minus, near, pal8).idx;
	const cxs = grid(W, 2 * s.stride), cys = grid(H, 2 * s.stride);
	const rr = await renderGrid(state, { ...rawView, rot: -rawView.rot }, W, H, cxs, cys);
	const cIdx = new Uint8Array(cxs.length * cys.length);
	for (let p = 0; p < cIdx.length; p++) cIdx[p] = indexOf(rr.mu[p], 0, state, logTable, r.maxIters);
	const cRot = idxExact(cIdx, nearestEntries(img.data, W, cxs, cys, pal8), pal8).idx;

	const got = {
		samples: N, unambiguous: main.n, idx: round4(main.idx), idx1: round4(main.idx1),
		flat: round4(flatOk / flatN), flatSamples: flatN,
		rawMed: round4(sorted[N >> 1]), rawMean: round4(sum / N),
		ctlPlus: round4(cPlus), ctlMinus: round4(cMinus), ctlRot: round4(cRot),
	};
	const bad = [];
	if (badColor) bad.push(badColor + " sample(s) colored off their index");
	if (got.idx < s.min.idx) bad.push("idx " + got.idx + " < " + s.min.idx);
	for (const k of ["ctlPlus", "ctlMinus", "ctlRot"]) if (got[k] >= s.max.controls) bad.push(k + " " + got[k] + " >= " + s.max.controls);
	if (UPDATE) s.recorded = got;
	const line = s.par + "  " + W + "x" + H + " /" + s.stride + "  idx " + got.idx + "  ±1 " + got.idx1 + "  flat " + got.flat +
		"  raw " + got.rawMed + "/" + got.rawMean + "  controls +1 " + got.ctlPlus + " −1 " + got.ctlMinus + " rot " + got.ctlRot +
		"  (" + ((performance.now() - t0) / 1000).toFixed(1) + "s)";
	if (bad.length) { failures++; console.error("FAIL  " + line + "\n      " + bad.join(", ")); }
	else console.log("ok    " + line);
}
if (UPDATE) {
	writeFileSync(scoresPath, "{\n\t\"note\": " + JSON.stringify(scores.note) + ",\n\t\"pars\": [\n" + scores.pars.map(p => "\t\t" + JSON.stringify(p)).join(",\n") + "\n\t]\n}\n");   // one row per par
	console.log("recorded the measured numbers in goldens/par-scores.json");
}
if (failures) { console.error(failures + " par(s) FAILED"); process.exit(1); }
console.log("all " + scores.pars.length + " pars score within their gates");
