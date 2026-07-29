// render/pipeline.ts — the RenderPipeline: the facade the UI drives. Owns the view, cap
// sizing (dwell probe + budgets), the precision gates, kernel selection, and — the heart
// of P2 — the EXPLICIT phase machine: one Phase value + a pure decideNext() transition
// function (Node-testable), replacing the old sharpenStage/sharpenMode/ssaaPhase/ffActive
// flag interplay. Draws only through a RenderSink; computes only through the WorkerPool;
// never touches the DOM (Node-importable — the golden CLI uses the exported gates).
import {
	View, DEFAULT_VIEW, CAPPED, SS, EDGE_TH, FILTER_NONE, FORMULA_CUSTOM,
	PERIOD_EPS2, PERIOD_EPS2_FLOOR, PERIOD_EPS2_FLOOR_DD, PERIOD_EPS_ZOOM0,
	escapeK1, escapeK2, probeStepFinite,
	setFrameState, installKernels,
} from "../kernel/kernel";
import type { KernelFrameState } from "../kernel/kernel";
import { assembleAll } from "../kernel/assemble";
import type { KernelSpec } from "../kernel/assemble";
import type { Palette } from "../palette";
import type { TileMsg, DoneMsg } from "../protocol";
import { FieldStore, Levels, TileJob } from "./field";
import { Colorizer } from "./colorizer";
import { WorkerPool } from "./pool";
import { Telemetry, GenStats, RendererEvents } from "./telemetry";
import type { Emitter } from "./events";
import type { RenderSink } from "./sink";

//---------------------------------------------------------------------------\\
// Tuning — iteration budgets, probe, sharpening schedule, DD gate. (Unchanged from P0.)
//---------------------------------------------------------------------------\\

const ITER_BASE = 1000;
const ITER_SLOPE = 600;
const ITER_CAP = 20000;
const ITER_CAP_PERT = 60000;
const PERT_ITER_MULT = 2;

const FF_PROBE_NX = 20, FF_PROBE_NY = 10;
const FF_PROBE_PCT = 0.95;
const FF_PROBE_MARGIN = 1.3;
const FF_BUDGET_BASE = 2000;
const FF_BUDGET_SLOPE = 1200;
const FF_PROBE_CEIL_MULT = 6;

const SHARPEN_MULT = 10;
const SHARPEN_CEILING = 100_000_000;
const ITER_CAP_FORCED_MAX = 1_000_000;
const SHARPEN_MIN_YIELD = 0.01;
const SHARPEN_CHEAP_MS = 150;
const PERT_SHARPEN_CEIL = 1_000_000;

const DD_SWITCH_RATIO = 8;
const TILE_W = 20, TILE_H = 20;

//---------------------------------------------------------------------------\\
// Pure gates + the phase decision (exported: Node tests + the golden CLI use these).
//---------------------------------------------------------------------------\\

// Auto-gate double-double: engage once the pixel step nears the coordinate ULP (with a
// few octaves of margin so DD is already on before the artifacts).
export function useDDFor(v: View, canvasW: number): boolean {
	const step = v.spanX / canvasW;
	const ulp = Math.max(Math.abs(v.cx), Math.abs(v.cy)) * Number.EPSILON;
	return step < ulp * DD_SWITCH_RATIO;
}

// Cycle-detection ε² tightens with zoom; DD tightens faster to a much lower floor.
export function periodEps2For(v: View, useDD: boolean): number {
	const zoom = DEFAULT_VIEW.spanX / v.spanX;
	if (zoom <= PERIOD_EPS_ZOOM0) return PERIOD_EPS2;
	if (useDD) {
		const e2 = PERIOD_EPS2 * Math.pow(PERIOD_EPS_ZOOM0 / zoom, 1.3);
		return e2 < PERIOD_EPS2_FLOOR_DD ? PERIOD_EPS2_FLOOR_DD : e2;
	}
	const e2 = PERIOD_EPS2 * Math.pow(PERIOD_EPS_ZOOM0 / zoom, 0.8);
	return e2 < PERIOD_EPS2_FLOOR ? PERIOD_EPS2_FLOOR : e2;
}

// Mandelbrot seed decision (Kernel 2): probe f(0) on a few sample c; z₀=0 (canonical)
// if finite anywhere, z₀=c (heuristic parameter map) only on a universal singularity.
// Requires the generated kernels (probeStep) to be installed.
export function decideSeedAtC(view: View): boolean {
	const S = [[0, 0], [0.31, 0.19], [-0.29, 0.23], [0.27, -0.21], [-0.33, -0.17]];
	for (const [fx, fy] of S) {
		if (probeStepFinite(view.cx + fx * view.spanX, view.cy + fy * view.spanY)) return false;
	}
	return true;
}

// The render phases. The old implicit flags map onto the phase VALUE: sharpenStage/
// sharpenMode → sharpen.{stage,sub}; ssaaPhase → kind "ssaa"; ffActive → kind
// "firstFrame" (mirrored in telemetry for the ETA).
export type Phase =
	| { kind: "idle" }
	| { kind: "firstFrame" }
	| { kind: "sharpen"; sub: "pert" | "dd"; stage: number }
	| { kind: "ssaa"; savedMaxIters: number }
	| { kind: "done" };

export interface AdvanceInput {
	phase: Phase;              // the phase whose generation just completed
	capped: number;            // still-CAPPED pixels after it
	prev: number;              // capped count entering it
	stageMs: number;           // the generation's wall time (the "cheap" clause)
	maxIters: number;          // its cap
}
export type AdvanceDecision =
	| { action: "sharpen"; sub: "pert" | "dd"; cap: number; stage: number }
	| { action: "ssaa" };

// The pure transition decision (invariants preserved verbatim from P0):
//  - stage 0 (firstFrame) always runs at least one sharpening pass;
//  - pert escalates on PRODUCTIVITY ONLY (no "cheap" clause — pert is always cheap and
//    would escalate forever) and hands the remainder to dd at the same cap when it stops
//    helping or would outgrow the reference-orbit memory ceiling;
//  - dd continues while productive OR cheap, up to the precision ceiling, then → ssaa.
export function decideNext(inp: AdvanceInput): AdvanceDecision {
	if (inp.capped === 0) return { action: "ssaa" };
	const stage = inp.phase.kind === "sharpen" ? inp.phase.stage : 0;
	const resolved = stage === 0 ? 0 : inp.prev - inp.capped;
	const yielded = inp.prev > 0 ? resolved / inp.prev : 0;

	if (inp.phase.kind === "sharpen" && inp.phase.sub === "pert") {
		const productive = yielded >= SHARPEN_MIN_YIELD;   // stage ≥ 1 here by construction
		if (productive && inp.maxIters < PERT_SHARPEN_CEIL) {
			return { action: "sharpen", sub: "pert", cap: Math.min(PERT_SHARPEN_CEIL, Math.round(inp.maxIters * SHARPEN_MULT)), stage: stage + 1 };
		}
		return { action: "sharpen", sub: "dd", cap: inp.maxIters, stage };   // handoff: same cap, stage unchanged
	}

	// dd sub-phase (or the first frame deciding its first stage).
	if (stage === 0) {
		// Always run at least one sharpening pass; sub chosen by the caller (pert window → pert).
		return { action: "sharpen", sub: "dd", cap: Math.min(SHARPEN_CEILING, Math.round(inp.maxIters * SHARPEN_MULT)), stage: 1 };
	}
	if (inp.maxIters >= SHARPEN_CEILING) return { action: "ssaa" };
	const cheap = inp.stageMs < SHARPEN_CHEAP_MS;
	const productive = yielded >= SHARPEN_MIN_YIELD;
	if (cheap || productive) {
		return { action: "sharpen", sub: "dd", cap: Math.min(SHARPEN_CEILING, Math.round(inp.maxIters * SHARPEN_MULT)), stage: stage + 1 };
	}
	return { action: "ssaa" };
}

//---------------------------------------------------------------------------\\
// Patches — the two config intakes, split by cost class (the P1 schema's taxonomy).
//---------------------------------------------------------------------------\\

export interface RecolorPatch {
	theme?: true;                                   // re-read the page theme (light/dark flip) + rebake
	palette?: Palette;                              // resets wrap/density to its defaults
	density?: number;
	coloring?: { mode: number; bandMap: number };   // the coloring dropdown
	bandMap?: number;                               // dev A/B: transfer only
	filterExposure?: number;
	filterBlend?: number;
	prov?: boolean;
}
export interface ComputePatch {
	formula?: { id: number } | { body: string };
	setType?: { julia: boolean; cx?: number; cy?: number };
	filter?: { id: number; dStrands: number; dFactor: number };
	iterCap?: number | null;
	pert?: boolean | null;
	dd?: boolean | null;
	period?: boolean;
	sharpen?: boolean;
}

export class RenderPipeline {
	private readonly field = new FieldStore();
	private readonly colorizer: Colorizer;
	private readonly pool: WorkerPool;
	private readonly telemetry = new Telemetry();

	private view: View = { ...DEFAULT_VIEW };
	private maxIters = ITER_BASE;
	private phase: Phase = { kind: "idle" };
	private levels: Levels = { muLo: 0, muHi: 1, p50: 0, p90: 0, esc: 0, ins: 0, cap: 0, muMax: 0 };
	private provLevels = { lo: 0, hi: 1 };
	private undetermined = 0;

	// ---- Compute configuration (single home until P3). ----
	private fractalMode = 0;
	private formulaId = 0;
	private juliaMode = false;
	private juliaCx = 0;
	private juliaCy = 0;
	private customStepBody = "";
	private mSeedAtC = false;
	private filterId = 0;
	private dStrands = 0.08;
	private dFactor = 1;
	private filterBlend = 0;
	private iterCapForced: number | null = null;
	private usePeriod = true;
	private periodEps2 = PERIOD_EPS2;
	private useDD = false;
	private ddOverride: boolean | null = null;
	private usePert = false;
	private pertOverride: boolean | null = null;
	private provOn = true;
	private sharpenOn = true;
	private ssaaRefine = true;

	private renderStart = 0;
	private lastMs = 0;
	private ffEstIters = 0;
	private onComplete: (() => void) | null = null;

	private kernelKey = "";

	public constructor(private sink: RenderSink, palette: Palette, private opts: { debug?: boolean } = {}) {
		this.colorizer = new Colorizer(palette, this.filterId);
		this.pool = new WorkerPool({
			result: (m) => this.onResult(m),
			drained: () => this.onGenerationComplete(),
		});
		this.pool.setPalette(this.colorizer.paletteMsg());
		this.ensureKernels();   // assemble + install the default kernel set (main + workers)
	}

	// (Re)assemble the generated kernels for the current spec. Cached by assembly key:
	// unchanged config → the SAME hot function objects keep running (JIT warmth); a config
	// change installs locally and broadcasts the sources to the pool.
	private ensureKernels(): void {
		const spec: KernelSpec = {
			usePeriod: this.usePeriod,
			formulaBody: this.formulaId === FORMULA_CUSTOM ? this.customStepBody : null,
			filterId: this.filterId,
			juliaMode: this.juliaMode,
		};
		const asm = assembleAll(spec);
		if (asm.key === this.kernelKey) return;
		this.kernelKey = asm.key;
		installKernels(asm.srcs);
		this.pool.setKernels({ type: "kernels", key: asm.key, srcs: asm.srcs });
	}

	public get events(): Emitter<RendererEvents> { return this.telemetry.events; }

	// Read-only field access (mandelDump and friends — no more private-field casts).
	public get fields(): { mu: Float32Array; de: Float32Array } {
		return { mu: this.field.mu, de: this.field.de };
	}

	//------------------------------------------------------------------------\\
	// Config intake, split by cost class.
	//------------------------------------------------------------------------\\

	// Recolor-class changes: apply, then ONE instant repaint from the stored field.
	public recolor(p: RecolorPatch): void {
		if (p.theme) {
			this.colorizer.rebuild(this.filterId);
			this.pool.setPalette(this.colorizer.paletteMsg());
		}
		if (p.palette !== undefined) {
			this.colorizer.setPalette(p.palette, this.filterId);
			this.pool.setPalette(this.colorizer.paletteMsg());
		}
		if (p.density !== undefined) this.colorizer.densityBase = p.density;
		if (p.coloring !== undefined) { this.colorizer.mode = p.coloring.mode; this.colorizer.bandMap = p.coloring.bandMap; }
		if (p.bandMap !== undefined) this.colorizer.bandMap = p.bandMap;
		if (p.filterExposure !== undefined) this.dFactor = p.filterExposure;
		if (p.filterBlend !== undefined) this.filterBlend = p.filterBlend;
		if (p.prov !== undefined) {
			this.provOn = p.prov;
			if (p.prov) this.provLevels = this.field.computeProvLevels();
		}
		this.colorizer.densityMul = this.colorizer.densityMulFor(this.view, DEFAULT_VIEW.spanX);
		this.repaint();
	}

	// Compute-class changes: apply + re-derive the kernel; the CALLER re-renders (matching
	// the old setter contract — a config change and the render it needs stay separate).
	public configure(p: ComputePatch): void {
		let formulaChanged = false;
		if (p.formula !== undefined) {
			if ("body" in p.formula) {
				formulaChanged = this.customStepBody !== p.formula.body || this.formulaId !== FORMULA_CUSTOM;
				this.customStepBody = p.formula.body;
				this.formulaId = FORMULA_CUSTOM;
			} else {
				this.formulaId = p.formula.id;
			}
		}
		if (p.setType !== undefined) {
			this.juliaMode = p.setType.julia;
			if (p.setType.julia) { this.juliaCx = p.setType.cx ?? 0; this.juliaCy = p.setType.cy ?? 0; }
		}
		if (p.filter !== undefined) {
			this.filterId = p.filter.id;
			this.dStrands = p.filter.dStrands;
			this.dFactor = p.filter.dFactor;
			// The filter's LUT treatment may differ (x-ray forces non-cyclic) → rebuild + resend.
			this.colorizer.rebuild(this.filterId);
			this.pool.setPalette(this.colorizer.paletteMsg());
		}
		if (p.iterCap !== undefined) {
			this.iterCapForced = p.iterCap != null && p.iterCap > 0 ? Math.min(Math.round(p.iterCap), ITER_CAP_FORCED_MAX) : null;
		}
		if (p.pert !== undefined) this.pertOverride = p.pert;
		if (p.dd !== undefined) this.ddOverride = p.dd;
		if (p.period !== undefined) this.usePeriod = p.period;
		if (p.sharpen !== undefined) this.sharpenOn = p.sharpen;
		this.deriveKernel();
		this.ensureKernels();
		// A changed formula body warrants a clean-slate pool (hang recovery for pathological
		// inputs — the kernels message is re-sent to every respawn).
		if (formulaChanged) this.pool.respawnAll();
	}

	// Kernel dispatch: Kernel 1 (optimized z²+c M-engine with DD/pert) ONLY when nothing
	// general is needed; anything else → Kernel 2 (f64), which forces DD/pert off.
	private deriveKernel(): void {
		const k2 = this.formulaId !== 0 || this.juliaMode || this.filterId !== 0;
		this.fractalMode = k2 ? 1 : 0;
		if (k2) { this.ddOverride = false; this.pertOverride = false; }
		else { this.ddOverride = null; this.pertOverride = null; }
	}

	//------------------------------------------------------------------------\\
	// State builders — the ONE frame-state shape (worker messages + main-thread paths).
	//------------------------------------------------------------------------\\

	private frameState(over: Partial<KernelFrameState> = {}): KernelFrameState {
		return {
			usePeriod: this.usePeriod, periodEps2: this.periodEps2, useDD: this.useDD, usePert: this.usePert,
			bandMap: this.colorizer.bandMap,
			fractalMode: this.fractalMode, formulaId: this.formulaId, juliaMode: this.juliaMode, mSeedAtC: this.mSeedAtC,
			juliaCx: this.juliaCx, juliaCy: this.juliaCy,
			filterId: this.filterId, trapDStrands: this.dStrands, filterDFactor: this.dFactor, filterBlend: this.filterBlend,
			filterDensity: this.colorizer.densityBase / 32,
			ssaaOn: true,
			...over,
		};
	}

	// Push the color-pass state (before every main-thread color path).
	private pushColorState(): void {
		this.colorizer.pushColorState({
			provOn: this.provOn && this.iterCapForced == null,
			provLo: this.provLevels.lo, provHi: this.provLevels.hi,
			filterId: this.filterId, filterDFactor: this.dFactor, filterBlend: this.filterBlend,
			filterDensity: this.colorizer.densityBase / 32,
		});
	}

	private repaint(): void {
		this.pushColorState();
		this.colorizer.repaintFrame(this.field, this.sink, this.view, this.levels);
	}

	//------------------------------------------------------------------------\\
	// Cap sizing (dwell probe + budgets) — unchanged logic.
	//------------------------------------------------------------------------\\

	private itersForView(v: View, usePert: boolean): number {
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		if (zoom <= 1) return ITER_BASE;
		const budget = Math.round(ITER_BASE + ITER_SLOPE * Math.log2(zoom));
		return usePert ? Math.min(ITER_CAP_PERT, budget * PERT_ITER_MULT) : Math.min(ITER_CAP, budget);
	}

	private probeCap(view: View): number {
		const floor = this.itersForView(view, false);
		const zoom = DEFAULT_VIEW.spanX / view.spanX;
		const budgetPerPx = FF_BUDGET_BASE + FF_BUDGET_SLOPE * Math.max(0, Math.log2(zoom));
		const probeCeil = Math.max(floor, Math.round(budgetPerPx * FF_PROBE_CEIL_MULT));
		// Probe the ACTIVE fractal, but measure escape DWELL (filter off) to size the cap.
		setFrameState(this.frameState({ filterId: FILTER_NONE }));
		const dwells: number[] = [];
		for (let j = 0; j < FF_PROBE_NY; j++) {
			const offY = (0.5 - (j + 0.5) / FF_PROBE_NY) * view.spanY;
			for (let i = 0; i < FF_PROBE_NX; i++) {
				const offX = ((i + 0.5) / FF_PROBE_NX - 0.5) * view.spanX;
				const pxc = view.cx + offX, pyc = view.cy + offY;
				const mu = !this.fractalMode
					? escapeK1(pxc, pyc, probeCeil)
					: this.juliaMode ? escapeK2(pxc, pyc, this.juliaCx, this.juliaCy, probeCeil)
						: this.mSeedAtC ? escapeK2(pxc, pyc, pxc, pyc, probeCeil)
							: escapeK2(0, 0, pxc, pyc, probeCeil);
				if (mu === CAPPED) dwells.push(probeCeil);
				else if (isFinite(mu)) dwells.push(mu);
			}
		}
		const W = this.sink.width, H = this.sink.height;
		if (dwells.length === 0) { this.ffEstIters = floor * W * H; return floor; }
		dwells.sort((a, b) => a - b);
		const pct = dwells[Math.min(dwells.length - 1, Math.floor(dwells.length * FF_PROBE_PCT))];
		const target = Math.ceil(pct * FF_PROBE_MARGIN);
		const budgetCap = this.capForBudget(dwells, budgetPerPx, probeCeil);
		const cap = Math.max(floor, Math.min(target, budgetCap, probeCeil));
		let sum = 0; for (const d of dwells) sum += d < cap ? d : cap;
		this.ffEstIters = (sum / dwells.length) * W * H;
		return cap;
	}

	private capForBudget(sortedDwells: number[], budgetPerPx: number, hi: number): number {
		const n = sortedDwells.length;
		const meanAt = (C: number): number => {
			let s = 0; for (let i = 0; i < n; i++) s += Math.min(sortedDwells[i], C); return s / n;
		};
		if (meanAt(hi) <= budgetPerPx) return hi;
		let lo = 0, h = hi;
		for (let it = 0; it < 40; it++) {
			const mid = (lo + h) / 2;
			if (meanAt(mid) <= budgetPerPx) lo = mid; else h = mid;
		}
		return Math.floor(lo);
	}

	//------------------------------------------------------------------------\\
	// The render entry + the phase machine.
	//------------------------------------------------------------------------\\

	public render(view: View, maxItersArg?: number): void {
		if (this.pool.size === 0) { console.error("MandelJS: Web Workers unavailable — cannot render."); return; }
		this.ensureKernels();   // no-op when the specialization key is unchanged
		// A new user frame supersedes any in-flight one: free (and clean-slate) busy
		// workers now. ONLY here — internal sharpen/SSAA generations never respawn.
		this.pool.supersede();
		this.view = view;
		this.field.resize(this.sink.width, this.sink.height);
		// Mandelbrot seed choice (Kernel 2 only): probe f(0); heuristic map on universal
		// singularity. Uses the generated probeStep (installed by ensureKernels above).
		this.mSeedAtC = false;
		let heuristic = false;
		if (this.fractalMode && !this.juliaMode) {
			setFrameState(this.frameState());
			if (decideSeedAtC(view)) { this.mSeedAtC = true; heuristic = true; }
		}
		this.telemetry.events.emit("mapmode", heuristic);
		this.colorizer.densityMul = this.colorizer.densityMulFor(view, DEFAULT_VIEW.spanX);
		this.useDD = this.ddOverride !== null ? this.ddOverride : useDDFor(view, this.sink.width);
		this.usePert = this.pertOverride !== null ? this.pertOverride : this.useDD;
		this.periodEps2 = periodEps2For(view, this.useDD);
		this.telemetry.events.emit("precision", this.useDD ? 128 : 64);
		this.field.beginFrame();
		this.provLevels = { lo: 0, hi: 1 };
		this.undetermined = 0;
		this.telemetry.progress({ working: 0, abandoned: 0, sharpening: false, done: false, phase: "first frame" });

		// Wash the stale frame toward grey so a new render is visibly "working".
		this.sink.wash();

		// Size the initial cap: probe (f64) / budget formula (DD & pert) / forced.
		this.ffEstIters = 0;
		const maxIters = maxItersArg ?? this.iterCapForced ?? (this.useDD || this.usePert ? this.itersForView(view, this.usePert) : this.probeCap(view));

		// Full-canvas tile queue, dispatch-order dispersed (deterministic Fisher–Yates) so
		// the FF-ETA's in-flight sample stays spatially representative.
		const W = this.sink.width, H = this.sink.height;
		const tiles: TileJob[] = [];
		for (let oy = 0; oy < H; oy += TILE_H)
			for (let ox = 0; ox < W; ox += TILE_W)
				tiles.push({ ox, oy, tw: Math.min(TILE_W, W - ox), th: Math.min(TILE_H, H - oy) });
		for (let i = tiles.length - 1, seed = 0x9e3779b9; i > 0; i--) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			const j = seed % (i + 1), t = tiles[i]; tiles[i] = tiles[j]; tiles[j] = t;
		}

		this.telemetry.beginFrame(DEFAULT_VIEW.spanX / view.spanX, this.useDD ? 128 : 64, this.ffEstIters, tiles.length);
		this.phase = { kind: "firstFrame" };
		this.beginGeneration(maxIters, tiles);
	}

	public renderAndWait(view: View): Promise<{ ms: number; stats: GenStats; maxIters: number }> {
		return new Promise((resolve) => {
			this.onComplete = () => resolve({ ms: this.lastMs, stats: this.telemetry.genStats, maxIters: this.maxIters });
			this.render(view);
		});
	}

	private beginGeneration(maxIters: number, tiles: TileJob[]): void {
		this.maxIters = maxIters;
		this.telemetry.maxIters = maxIters;
		this.renderStart = performance.now();
		this.telemetry.beginGeneration();
		const gen = this.pool.gen + 1;
		this.pool.begin(tiles, (job) => this.tileMsg(job, gen));
	}

	private tileMsg(job: TileJob, gen: number): TileMsg {
		const msg: TileMsg = {
			type: "tile", gen,
			ox: job.ox, oy: job.oy, tw: job.tw, th: job.th,
			canvasW: this.sink.width, canvasH: this.sink.height,
			view: this.view, maxIters: this.maxIters, densityMul: this.colorizer.densityMul, mode: this.colorizer.mode,
			...this.frameState({
				// Sharpen point jobs force the DD path ONLY in the dd sub-phase; the pert
				// sub-phase (and full renders + SSAA jobs) keep the view's path.
				usePert: (job.idx && !job.ssaaJob && this.phase.kind === "sharpen" && this.phase.sub === "dd") ? false : this.usePert,
				ssaaOn: false,   // initial full render is 1-sample; point jobs ignore this
			}),
		};
		if (job.idx) {
			msg.idx = job.idx;
			if (job.ssaaJob) { msg.ssaaJob = true; msg.lvlLo = this.levels.muLo; msg.lvlHi = this.levels.muHi; }
		}
		return msg;
	}

	private onResult(m: DoneMsg): void {
		if (m.gen !== this.pool.gen) return;   // stale tile from a superseded generation
		const sharpenKind = !!m.idx && !m.ssaaJob;
		const pertActive = sharpenKind ? (this.phase.kind === "sharpen" && this.phase.sub === "pert") : this.usePert;
		const method = pertActive ? "pert" as const : this.useDD ? "dd" as const : "direct" as const;
		if (m.ssaaJob) this.applySSAA(m);
		else if (m.idx) this.applySharpen(m);
		else this.applyTile(m);
		this.telemetry.tileLanded(m, m.ssaaJob ? "ssaa" : sharpenKind ? "sharpen" : "ff", method);
	}

	// Initial/full tile: stash the field, overlay the provisional heat on CAPPED pixels
	// (running per-frame range — finalizeColors snaps the global range later), then blit.
	private applyTile(m: DoneMsg): void {
		const mu = new Float32Array(m.mu!), de = new Float32Array(m.de!);
		this.field.storeTile(m.ox, m.oy, m.tw, m.th, mu, de);
		this.telemetry.noteMuMax(this.field.muMax);
		if (this.provOn) {
			const buf = new Uint32Array(m.buf!);
			for (let p = 0; p < mu.length; p++) {
				if (mu[p] === CAPPED) buf[p] = this.colorizer.provColor(de[p], this.field.provLo, this.field.provHi);
			}
		}
		this.sink.blitTile(m.buf!, m.ox, m.oy, m.tw, m.th);
	}

	// Sharpen result: update the field cells, recolor just the resolved pixels (still-
	// capped ones keep their color), tick the live countdown.
	private applySharpen(m: DoneMsg): void {
		const idx = m.idx!, mu = new Float32Array(m.mu!), de = new Float32Array(m.de!);
		this.pushColorState();
		const { resolvedIdx } = this.field.updatePoints(m.ox, m.oy, m.tw, idx, mu, de);
		if (resolvedIdx.length > 0) {
			const edit = this.sink.editTile(m.ox, m.oy, m.tw, m.th);
			for (const k of resolvedIdx) {
				edit.data32[idx[k]] = this.colorizer.sampleColor(mu[k], de[k], this.view, this.levels, this.field.width);
			}
			edit.commit();
		}
		this.telemetry.noteMuMax(this.field.muMax);
		this.telemetry.sharpenTick(resolvedIdx.length);
	}

	// SSAA result: cache the raw subsamples (recolors re-average them later) and blit the
	// averaged colors for just the edge pixels. The field itself is unchanged.
	private applySSAA(m: DoneMsg): void {
		const idx = m.idx!, mu = new Float32Array(m.mu!), de = new Float32Array(m.de!);
		const nSub = SS * SS, W = this.field.width;
		this.pushColorState();
		const edit = this.sink.editTile(m.ox, m.oy, m.tw, m.th);
		for (let k = 0; k < idx.length; k++) {
			const p = idx[k], off = k * nSub;
			this.field.ssaaStore((m.oy + ((p / m.tw) | 0)) * W + m.ox + (p % m.tw), mu, de, off, nSub);
			edit.data32[p] = this.colorizer.ssaaAverage(mu, de, off, nSub, this.view, this.levels, W);
		}
		edit.commit();
	}

	// A generation fully landed (the pool is drained — a POOL fact; see pool.ts).
	private onGenerationComplete(): void {
		this.telemetry.ffActive = false;
		this.finalizeColors();
		this.lastMs = performance.now() - this.renderStart;
		if (this.opts.debug) console.log("[mandel] " + this.statLine());
		const cb = this.onComplete; this.onComplete = null;
		if (cb) cb();
		this.advance();
	}

	// Refresh the auto-level range; on the initial frame also level the provisional
	// underlay; repaint when the workers' progressive coloring needs the level snap.
	private finalizeColors(): void {
		this.levels = this.filterId !== 0 ? this.field.computeFilterStats() : this.field.computeLevels();
		this.telemetry.reconcile(this.levels);
		const stage0 = this.phase.kind === "firstFrame";
		if (this.provOn && stage0 && this.iterCapForced == null) this.provLevels = this.field.computeProvLevels();
		if (this.phase.kind !== "ssaa" && ((this.provOn && stage0) || (!this.colorizer.wrap && this.colorizer.mode === 0))) this.repaint();
	}

	// The phase machine step, on each drained generation.
	private advance(): void {
		if (this.phase.kind === "ssaa") {
			// AA ran at a bounded cap; restore the real one for the telemetry.
			this.maxIters = this.phase.savedMaxIters;
			this.telemetry.maxIters = this.maxIters;
			this.phase = { kind: "done" };
			this.telemetry.progress({ working: 0, abandoned: this.undetermined, sharpening: false, done: true, phase: "done" });
			this.telemetry.emitStats(true);
			return;
		}
		if (!this.sharpenOn) return;   // bench mode: freeze at the initial frame
		// Forced cap: no sharpening ladder — still-capped pixels ARE the interior; jump to AA.
		if (this.iterCapForced != null) {
			this.undetermined = this.field.scanCapped(TILE_W, TILE_H).count;
			this.telemetry.emitStats(true);
			this.startSSAAOrSettle();
			return;
		}
		const prev = this.undetermined;
		const { count, tiles } = this.field.scanCapped(TILE_W, TILE_H);
		this.undetermined = count;
		const decision = decideNext({ phase: this.phase, capped: count, prev, stageMs: this.lastMs, maxIters: this.maxIters });
		if (decision.action === "ssaa") {
			this.telemetry.emitStats(true);
			this.startSSAAOrSettle();
			return;
		}
		// First-frame entry picks the sub-phase from the window: pert windows sharpen in
		// cheap perturbation first, then dd takes the glitchy remainder.
		const sub = this.phase.kind === "firstFrame" && this.usePert ? "pert" : decision.sub;
		this.telemetry.workingLive = count;
		this.telemetry.progress({ working: count, abandoned: 0, sharpening: true, done: false, phase: "refining" });
		this.telemetry.emitStats(false);
		const cap = this.phase.kind === "firstFrame" && sub === "pert"
			? Math.min(PERT_SHARPEN_CEIL, Math.round(this.maxIters * SHARPEN_MULT))
			: decision.cap;
		this.phase = { kind: "sharpen", sub, stage: decision.stage };
		this.beginGeneration(cap, tiles);
	}

	// One-shot background anti-aliasing over the resolved frame's edge pixels — or settle
	// straight to done when there's nothing to refine.
	private startSSAAOrSettle(): void {
		const settle = (): void => {
			this.phase = { kind: "done" };
			this.telemetry.progress({ working: 0, abandoned: this.undetermined, sharpening: false, done: true, phase: "done" });
		};
		if (!this.ssaaRefine || this.phase.kind === "ssaa") { settle(); return; }
		this.pushColorState();
		const colorOf = (mu: number, de: number): number => this.colorizer.sampleColor(mu, de, this.view, this.levels, this.field.width);
		const { count, tiles } = this.field.scanEdges(colorOf, EDGE_TH, TILE_W, TILE_H);
		if (count === 0) { settle(); return; }
		this.field.ssaaBegin(count, SS * SS);
		this.telemetry.progress({ working: 0, abandoned: this.undetermined, sharpening: false, done: false, phase: "anti-aliasing" });
		// Bound the AA pass to the perturbation regime (a DD-escalated cap would make the
		// per-worker reference orbit enormous); keep the real cap for the telemetry.
		this.phase = { kind: "ssaa", savedMaxIters: this.maxIters };
		this.beginGeneration(Math.min(this.maxIters, PERT_SHARPEN_CEIL), tiles);
	}

	private statLine(): string {
		const s = this.telemetry.genStats;
		const pts = s.esc + s.ins + s.per + s.cap || 1;
		const px = this.sink.width * this.sink.height;
		const cappedIterPct = s.iters ? (100 * s.cap * this.maxIters / s.iters) : 0;
		return "zoom " + (DEFAULT_VIEW.spanX / this.view.spanX).toExponential(2) + "x · " +
			this.lastMs.toFixed(1) + " ms · " + (s.iters / 1e6).toFixed(2) + "M iters (" +
			(s.iters / px).toFixed(0) + "/px) · pts " + (100 * s.esc / pts).toFixed(0) + "% esc / " +
			(100 * s.ins / pts).toFixed(0) + "% in / " + (100 * s.per / pts).toFixed(0) + "% period / " +
			(100 * s.cap / pts).toFixed(0) + "% capped · capped burns " + cappedIterPct.toFixed(0) +
			"% of iters · period=" + (this.usePeriod ? "on" : "off") +
			" · prec=" + (this.useDD ? "dd" : "f64");
	}
}
