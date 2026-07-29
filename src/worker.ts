// worker.ts — the Web Worker entry: a thin message loop around the SAME kernel module the
// main thread imports (one definition by construction — the old stringified-source build
// is gone). Holds the current palette + the per-generation reference-orbit cache; renders
// whatever tile it's handed and transfers the buffers straight back. Workers keep
// provisional coloring OFF (CAPPED → black per tile); the main thread overlays the heat.
import {
	SS, setFrameState, resetTallies, installKernels,
	computeRef, renderRegion, sharpenPoints, ssaaPoints,
	iterAcc, escAcc, inAcc, perAcc, capAcc,
} from "./kernel/kernel";
import type { WorkerInMsg, PaletteMsg, DoneMsg } from "./protocol";

// The shared tsconfig uses lib.dom (whose postMessage signature is the window's); the
// runtime function here is the worker's (message, transfer). One typed wrapper.
const post = (m: DoneMsg, transfer: Transferable[]): void => {
	(self as unknown as { postMessage(msg: unknown, t?: Transferable[]): void }).postMessage(m, transfer);
};

let PAL: PaletteMsg | null = null;
let refGen = -1;   // generation the cached perturbation reference orbit was computed for

self.onmessage = (e: MessageEvent): void => {
	const m = e.data as WorkerInMsg;
	if (m.type === "palette") { PAL = m; return; }
	if (m.type === "kernels") { installKernels(m.srcs); return; }

	// Tile job. The message IS the kernel frame state (TileMsg extends KernelFrameState),
	// so one call applies it — the defaults inside setFrameState mirror the old prelude.
	setFrameState(m);
	resetTallies();
	if (m.usePert && m.gen !== refGen) { computeRef(m.view, m.maxIters); refGen = m.gen; }   // reference once per gen (covers full + ssaa jobs)

	if (m.idx && m.ssaaJob) {   // background SSAA: supersample edge points, return raw subsample mu/de
		const nSub = SS * SS;
		const muS = new Float32Array(m.idx.length * nSub), deS = new Float32Array(m.idx.length * nSub);
		ssaaPoints(muS, deS, m.idx, m.ox, m.oy, m.tw, m.canvasW, m.canvasH, m.view, m.maxIters);
		post({
			type: "done", gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th, idx: m.idx, ssaaJob: true,
			iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,
			mu: muS.buffer, de: deS.buffer,
		}, [muS.buffer, deS.buffer]);
		return;
	}
	if (m.idx) {   // sharpen: re-iterate only the listed capped points, packed results
		const muS = new Float32Array(m.idx.length), deS = new Float32Array(m.idx.length);
		sharpenPoints(muS, deS, m.idx, m.ox, m.oy, m.tw, m.canvasW, m.canvasH, m.view, m.maxIters);
		post({
			type: "done", gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th, idx: m.idx,
			iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,
			mu: muS.buffer, de: deS.buffer,
		}, [muS.buffer, deS.buffer]);
		return;
	}
	// Full tile render.
	const n = m.tw * m.th;
	const out = new Uint32Array(n), muF = new Float32Array(n), deF = new Float32Array(n);
	renderRegion(out, muF, deF, m.tw, m.ox, m.oy, m.tw, m.th, m.canvasW, m.canvasH,
		m.view, m.maxIters, PAL!.lut, PAL!.inSet, m.densityMul, PAL!.cyclic, m.mode);
	post({
		type: "done", gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th,
		iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,
		buf: out.buffer, mu: muF.buffer, de: deF.buffer,
	}, [out.buffer, muF.buffer, deF.buffer]);
};
