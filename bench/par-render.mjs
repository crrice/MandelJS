// bench/par-render.mjs — the par runners' shared renderer: import a .par entry through the
// app's importer (config.stateFromPar), then point-sample a pixel grid of a W×H frame
// through the headless engine (src/render/headless.ts), spread across worker_threads.
// Each worker configures the SAME frame (setupHeadless is deterministic, incl. the pert
// reference) and renders whole sample rows, interleaved for load balance; the results are
// reassembled in row-major grid order, so fields and tallies are worker-count-independent.
//
// A sample at pixel (x, y) is renderRegion's 1-sample pixel center — with AA off, a
// stride-1 grid is bit-identical to renderHeadless of the whole frame.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import * as M from "../dist/node-lib.js";

// Import one entry (the first by default). Throws on a refused entry.
export function loadPar(path, entry) {
	const imp = M.stateFromPar(readFileSync(path, "utf8"), entry);
	if (imp.error) throw new Error(path + ": par refused: " + imp.error);
	return imp;
}

// Render the grid xs × ys (pixel indices) of the frame {state, rawView, W, H}.
// → { mu: Float32Array, de: Float32Array, out: Uint32Array (packed RGBA), maxIters, iters,
//     esc, ins, per, cap, ms }, row-major over the grid.
export async function renderGrid(state, rawView, W, H, xs, ys, opts = {}) {
	const n = Math.max(1, Math.min(opts.workers || availableParallelism(), ys.length));
	const nx = xs.length;
	const mu = new Float32Array(nx * ys.length), de = new Float32Array(nx * ys.length), out = new Uint32Array(nx * ys.length);
	const t0 = performance.now();
	const parts = await Promise.all(Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), { workerData: { state, rawView, W, H, xs, ys, first: w, step: n, noperiod: !!opts.noperiod } });
		worker.once("message", resolve);
		worker.once("error", reject);
	})));
	const res = { mu, de, out, maxIters: parts[0].maxIters, iters: 0, esc: 0, ins: 0, per: 0, cap: 0, ms: 0 };
	for (const p of parts) {
		for (let k = 0; k < p.rows.length; k++) {
			const at = p.rows[k] * nx;
			mu.set(p.mu.subarray(k * nx, (k + 1) * nx), at);
			de.set(p.de.subarray(k * nx, (k + 1) * nx), at);
			out.set(p.out.subarray(k * nx, (k + 1) * nx), at);
		}
		res.iters += p.iters; res.esc += p.esc; res.ins += p.ins; res.per += p.per; res.cap += p.cap;
	}
	res.ms = performance.now() - t0;
	return res;
}

// Worker: rows first, first+step, … of the grid, 1 sample per pixel.
if (!isMainThread) {
	const { state, rawView, W, H, xs, ys, first, step, noperiod } = workerData;
	const f = M.setupHeadless(state, rawView, W, H, { noaa: true, noperiod });
	const rows = [];
	for (let r = first; r < ys.length; r += step) rows.push(r);
	const nx = xs.length;
	const mu = new Float32Array(nx * rows.length), de = new Float32Array(nx * rows.length), out = new Uint32Array(nx * rows.length);
	M.resetTallies();
	for (let k = 0; k < rows.length; k++) {
		const y = ys[rows[k]];
		for (let i = 0; i < nx; i++) {
			const p = k * nx + i;
			M.renderRegion(out.subarray(p, p + 1), mu.subarray(p, p + 1), de.subarray(p, p + 1), 1, xs[i], y, 1, 1, W, H, f.view, f.maxIters, f.lut, f.inSet, f.densityMul, f.cyclic, f.mode);
		}
	}
	parentPort.postMessage({ rows, mu, de, out, maxIters: f.maxIters, iters: M.iterAcc, esc: M.escAcc, ins: M.inAcc, per: M.perAcc, cap: M.capAcc });
}
