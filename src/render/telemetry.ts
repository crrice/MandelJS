// render/telemetry.ts — the Telemetry: whole-frame counters (composition, method,
// deepest), the first-frame ETA estimator, all emit throttles, and the typed event
// emitter that replaces the old nullable callbacks. Consumes DoneMsg tallies + Levels
// reconciliations from the pipeline; emits progress/stats/precision/mapmode.
import { Emitter } from "./events";
import type { DoneMsg } from "../protocol";
import type { Levels } from "./field";

// Headline per-frame telemetry for the UI stats line. `deepest` is the honest maximum
// iterations any single pixel actually performed.
export interface FrameStats {
	zoom: number; bits: number; maxIters: number; deepest: number;
	escaped: number; inSet: number; capped: number;
	xPert: number; xDD: number; xDirect: number;
	itersPerSec: number; p50: number; p90: number; done: boolean;
}

export interface ProgressEvent {
	working: number; abandoned: number; sharpening: boolean; done: boolean; phase: string; etaMs?: number;
}

export interface RendererEvents extends Record<string, unknown> {
	progress: ProgressEvent;
	stats: FrameStats;
	precision: number;      // working precision in bits (64 f64 / 128 double-double)
	mapmode: boolean;       // true = heuristic z₀=c parameter map (not a true M-set)
}

// Per-generation instrumentation: total iterations + outcome tallies.
export interface GenStats { iters: number; esc: number; ins: number; per: number; cap: number; }

export class Telemetry {
	public readonly events = new Emitter<RendererEvents>();
	// Whole-frame live tallies (incremented per FF tile, reclassified per sharpen resolve,
	// reconciled to the authoritative full-field scan each generation).
	public wfEsc = 0; public wfCap = 0; public wfIns = 0;
	public xPert = 0; public xDD = 0; public xDirect = 0;
	public p50 = 0; public p90 = 0;
	public muMax = -Infinity;
	public genStats: GenStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 };
	private frameStart = 0;
	private frameIters = 0;
	private lastStatsEmit = 0;
	private lastWorkingEmit = 0;
	public workingLive = 0;
	// First-frame ETA: probe-estimated total iterations + live tile extrapolation.
	private ffEstIters = 0;
	private ffStartMs = 0;
	private ffTiles = 0;
	private ffDoneTiles = 0;
	private ffDoneIters = 0;
	public ffActive = false;
	private lastEtaEmit = 0;
	// Frame identity for the stats emit (owned by the pipeline, mirrored here).
	public zoom = 1; public bits = 64; public maxIters = 0;

	// Reset everything for a new user frame.
	public beginFrame(zoom: number, bits: number, ffEstIters: number, ffTiles: number): void {
		this.muMax = -Infinity; this.wfEsc = 0; this.wfCap = 0; this.wfIns = 0;
		this.xPert = 0; this.xDD = 0; this.xDirect = 0; this.p50 = 0; this.p90 = 0;
		this.frameStart = performance.now(); this.frameIters = 0; this.lastStatsEmit = 0;
		this.zoom = zoom; this.bits = bits;
		this.ffEstIters = ffEstIters; this.ffTiles = ffTiles;
		this.ffActive = true; this.ffStartMs = performance.now(); this.ffDoneTiles = 0; this.ffDoneIters = 0; this.lastEtaEmit = 0;
	}

	public beginGeneration(): void {
		this.genStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 };
	}

	// Fold one tile result in. kind decides the composition bookkeeping: FF tiles classify
	// fresh pixels; sharpen tiles reclassify capped ones. method credits exterior pixels.
	public tileLanded(m: DoneMsg, kind: "ff" | "sharpen" | "ssaa", method: "pert" | "dd" | "direct"): void {
		const s = this.genStats;
		s.iters += m.iters; s.esc += m.esc; s.ins += m.ins; s.per += m.per; s.cap += m.cap;
		this.frameIters += m.iters;
		if (kind === "ssaa") return;   // SSAA jobs don't change the field/composition
		if (kind === "sharpen") {
			this.wfEsc += m.esc; this.wfIns += m.ins; this.wfCap -= m.esc + m.ins;
		} else {
			this.wfEsc += m.esc; this.wfIns += m.ins; this.wfCap += m.cap;
			if (this.ffActive) { this.ffDoneTiles++; this.ffDoneIters += m.iters; this.emitEta(); }
		}
		if (method === "pert") this.xPert += m.esc;
		else if (method === "dd") this.xDD += m.esc;
		else this.xDirect += m.esc;
		const now = performance.now();   // throttled live emit so the grid ticks, not floods
		if (now - this.lastStatsEmit > 60) { this.lastStatsEmit = now; this.emitStats(false); }
	}

	// Live sharpen countdown (throttled ~25 Hz) as points resolve within a stage.
	public sharpenTick(resolved: number): void {
		this.workingLive -= resolved;
		const now = performance.now();
		if (now - this.lastWorkingEmit > 40) {
			this.lastWorkingEmit = now;
			this.events.emit("progress", { working: this.workingLive, abandoned: 0, sharpening: true, done: false, phase: "refining" });
			this.emitStats(false);
		}
	}

	// Reconcile to the authoritative full-field scan once a generation lands.
	public reconcile(levels: Levels): void {
		this.wfEsc = levels.esc; this.wfIns = levels.ins; this.wfCap = levels.cap;
		this.p50 = levels.p50; this.p90 = levels.p90; this.muMax = levels.muMax;
	}

	public noteMuMax(v: number): void { if (v > this.muMax) this.muMax = v; }

	// Emit the headline stats. `deepest` climbs through the escape-time distribution as
	// tiles land; only once done do still-capped pixels count via max with the cap.
	public emitStats(done: boolean): void {
		const dm = this.muMax > 0 ? Math.floor(this.muMax) : 0;
		const deepest = done && this.wfCap > 0 ? Math.max(dm, this.maxIters) : (dm || this.maxIters);
		const elapsed = (performance.now() - this.frameStart) / 1000;
		this.events.emit("stats", {
			zoom: this.zoom, bits: this.bits, maxIters: this.maxIters, deepest,
			escaped: this.wfEsc, inSet: this.wfIns, capped: this.wfCap,
			xPert: this.xPert, xDD: this.xDD, xDirect: this.xDirect,
			itersPerSec: elapsed > 0 ? this.frameIters / elapsed : 0,
			p50: this.p50, p90: this.p90, done,
		});
	}

	public progress(p: ProgressEvent): void { this.events.emit("progress", p); }

	// First-frame ETA: remaining = elapsed·(estTotal/doneIters − 1), from the live tile
	// extrapolation × a 10% over-estimate cushion. Gated to the f64 probe path
	// (ffEstIters > 0) and to a representative sample of the dispersed tiles.
	private emitEta(): void {
		if (this.ffEstIters <= 0 || this.ffDoneIters <= 0) return;
		if (this.ffDoneTiles < 6 || this.ffDoneTiles < this.ffTiles * 0.05) return;
		const now = performance.now();
		if (now - this.lastEtaEmit < 200) return;
		this.lastEtaEmit = now;
		const elapsed = now - this.ffStartMs;
		const est = this.ffDoneIters * this.ffTiles / this.ffDoneTiles * 1.1;
		const etaMs = Math.max(0, elapsed * (est / this.ffDoneIters - 1));
		this.events.emit("progress", { working: 0, abandoned: 0, sharpening: false, done: false, phase: "first frame", etaMs });
	}
}
