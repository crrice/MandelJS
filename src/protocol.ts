// protocol.ts — the message shapes shared by the pipeline (main thread) and the worker
// entry. TileMsg extends the kernel's frame-state shape, so the pipeline's dispatch, the
// worker's setFrameState(m), and the main-thread probe paths all speak ONE shape — a
// single source of truth for "everything a tile render needs to know".
import type { View, KernelFrameState } from "./kernel/kernel";

export interface TileMsg extends KernelFrameState {
	type: "tile"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	canvasW: number; canvasH: number; view: View; maxIters: number; densityMul: number; mode: number;
	idx?: Int32Array;   // present => point job (sharpen or ssaa) over these tile-local pixels
	ssaaJob?: boolean;  // with idx => background SSAA (supersample edges → colors) instead of sharpen (re-iterate → mu/de)
	lvlLo?: number; lvlHi?: number;   // ssaa job: the main thread's auto-level window, so AA colors match the resting frame
}

export interface DoneMsg {
	type: "done"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	iters: number; esc: number; ins: number; per: number; cap: number;
	mu?: ArrayBuffer; de?: ArrayBuffer;
	buf?: ArrayBuffer;   // full-tile pixels (absent for point-job results)
	idx?: Int32Array;    // point-job results: packed per-point, aligned to idx
	ssaaJob?: boolean;   // true => the mu/de buffers hold raw SS² subsamples per edge pixel
}

// Palette hand-off: each worker gets its own copy of the baked LUT (structured clone, ~4KB).
export interface PaletteMsg { type: "palette"; lut: Uint32Array; inSet: number; cyclic: boolean; }

// Generated-kernel install: the assembled sources for the current specialization key
// (kernel/assemble.ts). Workers compile via installKernels — the same sources the main
// thread installed, so the two sides cannot drift. Sent only when the key changes, so an
// unchanged config keeps the workers' hot (JIT-warmed) kernel functions.
export interface KernelsMsg {
	type: "kernels"; key: string;
	srcs: { k1f64: string; k1dd: string; k1pert: string; k2: string; probeStep: string };
}

export type WorkerInMsg = TileMsg | PaletteMsg | KernelsMsg;
