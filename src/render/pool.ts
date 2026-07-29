// render/pool.ts — the WorkerPool: owns the Worker instances, idle tracking, the job
// queue, and the generation counter. Knows jobs and messages, not fractals. Two distinct
// respawn semantics (both preserved from P0):
//   supersede()  — terminate+respawn only the BUSY workers, when a user render abandons
//                  the in-flight frame (fast free + hang recovery). Never used by the
//                  pipeline's internal sharpen/SSAA generations.
//   respawnAll() — every worker, when the compiled kernels change semantically (formula
//                  edits — hang recovery for pathological inputs).
// Stored palette/kernels messages are re-sent to every (re)spawned worker.
import type { TileJob } from "./field";
import type { TileMsg, DoneMsg, PaletteMsg, KernelsMsg } from "../protocol";

const WORKER_CAP = 32;   // safety ceiling; actual count = min(this, hardwareConcurrency)

export interface PoolHandlers {
	result(m: DoneMsg): void;
	// The pool is DRAINED: queue empty + every worker idle. This is a fact about the POOL,
	// not about any message's generation — the last tile to land can be a stale one from a
	// superseded generation, and completion must still fire (see the P0 onDone note).
	drained(): void;
}

export class WorkerPool {
	private workers: Worker[] = [];
	private idle: boolean[] = [];
	private queue: TileJob[] = [];
	private makeMsg: ((job: TileJob) => TileMsg) | null = null;
	private paletteMsg: PaletteMsg | null = null;
	private kernelsMsg: KernelsMsg | null = null;
	public gen = 0;

	public constructor(private handlers: PoolHandlers) {
		try {
			const n = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, WORKER_CAP));
			for (let i = 0; i < n; i++) this.spawn(i);
		} catch {
			this.workers = [];   // no Worker support — the pipeline reports and refuses to render
		}
	}

	public get size(): number { return this.workers.length; }
	public get busy(): boolean { return this.queue.length > 0 || this.idle.some((x) => !x); }

	private spawn(i: number): void {
		const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
		w.onmessage = (e: MessageEvent) => this.onDone(i, e.data as DoneMsg);
		w.onerror = (e: ErrorEvent) => console.error("MandelJS worker error:", e.message);
		this.workers[i] = w;
		this.idle[i] = true;
		if (this.paletteMsg) w.postMessage(this.paletteMsg);
		if (this.kernelsMsg) w.postMessage(this.kernelsMsg);
	}

	// Install (and broadcast) the palette every worker colors with.
	public setPalette(msg: PaletteMsg): void {
		this.paletteMsg = msg;
		for (const w of this.workers) w.postMessage(msg);
	}

	// Install (and broadcast) the generated kernel set for the current specialization key.
	public setKernels(msg: KernelsMsg): void {
		this.kernelsMsg = msg;
		for (const w of this.workers) w.postMessage(msg);
	}

	public respawnAll(): void {
		for (let i = 0; i < this.workers.length; i++) { this.workers[i].terminate(); this.spawn(i); }
	}

	// Free workers still busy on a superseded frame's discarded tiles (no-op when idle).
	public supersede(): void {
		for (let i = 0; i < this.workers.length; i++) {
			if (!this.idle[i]) { this.workers[i].terminate(); this.spawn(i); }
		}
	}

	// Start a new generation over a job queue; returns the generation id (stamped into
	// messages by the caller's makeMsg). Busy workers pull from the new queue as they
	// finish; idle ones are kicked now.
	public begin(jobs: TileJob[], makeMsg: (job: TileJob) => TileMsg): number {
		this.gen++;
		this.queue = jobs;
		this.makeMsg = makeMsg;
		for (let i = 0; i < this.workers.length; i++) if (this.idle[i]) this.dispatch(i);
		return this.gen;
	}

	private dispatch(i: number): void {
		const job = this.queue.shift();
		if (!job || !this.makeMsg) { this.idle[i] = true; return; }
		this.idle[i] = false;
		this.workers[i].postMessage(this.makeMsg(job));
	}

	private onDone(i: number, m: DoneMsg): void {
		this.handlers.result(m);
		this.dispatch(i);   // keep the worker fed from the current queue
		if (this.queue.length === 0 && this.idle.every((x) => x)) this.handlers.drained();
	}
}
