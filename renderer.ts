// renderer.ts — the orchestration layer that runs on the main thread: the Web
// Worker pool (built at runtime by stringifying kernel.ts via buildWorkerSource)
// and the FractalRenderer class driving progressive tiled render, sharpening,
// palette/precision/period scheduling, and recolor. Depends on kernel.ts (compute)
// and palette.ts (LUTs); reads the canvas/ctx handles defined in index.ts.

//---------------------------------------------------------------------------\\
// Renderer tuning — iteration budget, sharpening schedule, color density, DD gate.
//---------------------------------------------------------------------------\\

// Iteration budget scales with zoom: deeper views need more iterations or the
// boundary filaments blob into solid "fuzz" (points that would escape just
// later get mislabeled in-set). Grows per octave of zoom, capped so very deep
// views stay tolerable — the worker pool absorbs the extra cost.
const ITER_BASE = 1000;   // full-view budget
const ITER_SLOPE = 600;   // extra iterations per octave (2x) of zoom
const ITER_CAP = 20000;   // ceiling for the INITIAL pass (fast time-to-first-frame)
const ITER_CAP_PERT = 60000;   // higher initial ceiling when the pass is perturbation — its iters are
const PERT_ITER_MULT = 2;      // ~30x cheaper, so we afford budget = MULT × the depth formula (capped
                               // here), resolving more filament detail up front instead of via idle DD.

// Probe-based initial cap (f64 path). The zoom-only budget above is blind to a region's LOCAL
// dwell: near a minibrot the escape time runs far past the formula's guess, so the first frame
// caps out ~100% unresolved → all black, and sharpening then redoes it from scratch (the low
// pass is pure waste). Instead, sample the view's actual escape-time distribution and size the
// first pass to resolve ~FF_PROBE_PCT of it in ONE pass — a good first frame AND less total work.
// Adaptive: an easy window probes low → the same fast first frame as before. Measured (minibrot
// window): current FF@20k+IS = 56k iters/px, 0% first frame; a single probed pass ≈ 37k iters/px,
// ~99% first frame. Clamped to FF_SUPER_CAP so a very deep window still lands a bounded first
// frame and leaves the tail to sharpening (where the provisional heat underlay carries it).
const FF_PROBE_NX = 20, FF_PROBE_NY = 10;   // sparse dwell-probe grid (200 pts, 2:1 canvas aspect)
const FF_PROBE_PCT = 0.95;                   // target percentile of the sampled dwell distribution
const FF_PROBE_MARGIN = 1.3;                 // bump above p95 to catch the near-tail (~98–99% resolved)
// First-frame COMPUTE BUDGET (mean iters/px) — the ceiling on the probed cap, in place of a hardcoded
// iteration count. It scales with zoom depth so deeper dives are allowed proportionally more first-frame
// work ("more time for deeper zooms", in deterministic form). When the budget can't cover the dwell (a
// very deep / high-dwell window), the cap lands where the budget runs out and the tail falls to
// sharpening + the provisional heat. The probe measures dwell to a multiple of the budget so both the
// percentile target and the budget are estimated accurately; that ceiling scales with depth too.
const FF_BUDGET_BASE = 2000;       // budget at zoom 1 (iters/px)
const FF_BUDGET_SLOPE = 1200;      // + iters/px per octave (log2) of zoom
const FF_PROBE_CEIL_MULT = 6;      // probe iterates to this × the budget (dwell measurement ceiling)

// Progressive sharpening. The initial pass caps at ITER_CAP so the first frame
// lands fast; points that hit the cap unresolved (CAPPED) are then re-iterated on
// the idle worker pool at a cap that escalates ×SHARPEN_MULT per stage. Rather
// than stop at a fixed cap, each stage decides whether the next is worth running:
// keep going while it stays PRODUCTIVE (resolves a meaningful share of what
// remained) OR CHEAP (a stage this fast is a free tickle — carry on even if it
// resolved little); stop only when a stage is both unproductive and not cheap, or
// when the cap reaches the precision ceiling. That ceiling is real, not arbitrary:
// past it a point's float64 orbit error (~ε·|z'|) has grown to O(1), so more
// iterations track a neighboring c, not this one — the point can't be decided
// without more precision, only "abandoned". Re-runs whole capped tiles from
// scratch (the wasted low-cap iters are a few %, not worth a resume-state buffer).
const SHARPEN_MULT = 10;              // cap multiplier per sharpening stage
const SHARPEN_CEILING = 100_000_000;  // past this, points are precision-limited, not iteration-limited
const SHARPEN_MIN_YIELD = 0.01;       // a stage resolving < this share of what remained is "unproductive"
const SHARPEN_CHEAP_MS = 150;         // ...but a stage faster than this is a free tickle — keep going anyway
// Perturbation-first sharpening ceiling. A pert window sharpens its CAPPED pixels in the cheap f64
// perturbation path FIRST (cap-limited pixels escape as the cap rises; only true glitches stay capped),
// then hands the glitchy remainder to exact DD. Perturbation stores the reference orbit as arrays
// (~32 B/iter × workers), so we stop escalating the pert cap here and switch to DD (which needs no
// stored reference) for anything deeper. Cap-limited pixels almost always resolve well below this.
const PERT_SHARPEN_CEIL = 1_000_000;

// Color-frequency control. Deep in, the smooth count changes so fast per pixel
// that a fixed color cycle wraps many times between neighbors — chromatic
// static. Stretch the cycle with zoom (identity at the full view) to hold the
// color gradient's per-pixel rate roughly constant. The exponent ~matches how
// fast the per-pixel delta grows with zoom.
const COLOR_STRETCH_EXP = 0.3;

// Double-double (DD) precision gate. Past a certain depth f64 runs out of mantissa
// — the pixel step drops below the ULP of the coordinate (adjacent pixels collide)
// AND the orbit's rounding error, Lyapunov-amplified, swamps the boundary test. The
// orbit is then run in ~106-bit double-double arithmetic (a pair of f64s). DD costs
// ~15-20x/op (no hardware FMA in JS -> Dekker two-product), so it's gated to only
// the views that need it: engage when the pixel step falls within this factor of the
// coordinate ULP — a few octaves before the hard wall, so the crossover is seamless.
// Tunable; mandelDD() forces on/off/auto for A/B.
const DD_SWITCH_RATIO = 8;

//---------------------------------------------------------------------------\\
// Worker pool
//---------------------------------------------------------------------------\\

const TILE_W = 20, TILE_H = 20;   // 20px square → 32×16 divisions (both powers of 2) = 512 tiles (2^9)
                                  // on the 640×320 canvas (exact division, no ragged edges). ~21% SSAA-
                                  // border recompute (~perimeter/area) — near the ~16px floor below which
                                  // that overhead starts to dominate. Finer than 32×16 for the tail.
const WORKER_CAP = 32;  // safety ceiling on the pool; actual count = min(this, hardwareConcurrency)

interface TileMsg {
	type: "tile"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	canvasW: number; canvasH: number; view: View; maxIters: number; densityMul: number; mode: number;
	usePeriod: boolean; periodEps2: number; useDD: boolean; usePert: boolean; pertRhoThresh: number; bandMap: number;
	ssaaOn?: boolean;   // full-render only: false => 1-sample fast frame (initial pass); default true (sync path)
	idx?: Int32Array;   // present => point job (sharpen or ssaa) over these tile-local pixels
	ssaaJob?: boolean;  // with idx => background SSAA (supersample edges → colors) instead of sharpen (re-iterate → mu/de)
	lvlLo?: number; lvlHi?: number;   // ssaa job: the main thread's auto-level window, so AA colors match the resting frame
}
interface DoneMsg {
	type: "done"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	iters: number; esc: number; ins: number; per: number; cap: number;
	mu?: ArrayBuffer; de?: ArrayBuffer;
	buf?: ArrayBuffer;   // full-tile pixels (absent for point-job results)
	idx?: Int32Array;    // point-job results: packed per-point, aligned to idx
	ssaaJob?: boolean;   // true => `col` holds packed averaged colors (SSAA); else mu/de (sharpen)
	col?: ArrayBuffer;   // ssaa results: averaged packed colors, aligned to idx
}

// Per-generation instrumentation: total iterations + outcome tallies.
interface GenStats { iters: number; esc: number; ins: number; per: number; cap: number; }

// Headline per-frame telemetry for the UI stats line — the numbers that convey how deep this
// view digs. `deepest` is the honest maximum iterations any single pixel actually performed:
// the deepest escaper's dwell, or (while pixels are still capped) the current cap they reached.
interface FrameStats {
	zoom: number;         // magnification vs the default view
	bits: number;         // working precision (64 f64 / 128 double-double)
	maxIters: number;     // the current iteration cap
	deepest: number;      // deepest iterations reached by any pixel
	escaped: number;      // pixels that escaped (exterior)
	inSet: number;        // pixels proven in-set (interior)
	capped: number;       // pixels still undetermined at the cap
	xPert: number;        // exterior pixels resolved via perturbation
	xDD: number;          // exterior pixels resolved via exact double-double
	xDirect: number;      // exterior pixels resolved via direct f64 iteration
	itersPerSec: number;  // throughput: cumulative frame iterations / elapsed wall-time
	p50: number;          // dwell threshold: half the escapers escaped within this many iters
	p90: number;          // dwell threshold: 90% of escapers escaped within this many iters
	done: boolean;        // frame fully resolved (drives the deepest label)
}

// A unit of render work: a tile rectangle. With `idx` it's a point job over those tile-local
// pixels — sharpen (re-iterate capped) by default, or SSAA (supersample edges) when ssaaJob.
interface TileJob { ox: number; oy: number; tw: number; th: number; idx?: Int32Array; ssaaJob?: boolean; }

// The worker body: the kernel + primitive (stringified from above) plus a tiny
// message loop. It holds the current palette and renders whatever tile it's
// handed, transferring the pixels straight back. NOTE: this relies on the build
// not minifying/renaming these functions (plain tsc + cp — it doesn't).
function buildWorkerSource(): string {
	return [
		'"use strict";',
		"const BAILOUT2 = " + BAILOUT2 + ";",
		"const DIST_SCALE = " + DIST_SCALE + ";",
		"const SS = " + SS + ";",
		"const EDGE_TH = " + EDGE_TH + ";",
		"const PERIOD_WARMUP = " + PERIOD_WARMUP + ";",
		"const PERT_GATE2 = " + PERT_GATE2 + ";",
		"const IN_SET = Infinity;",
			"const CAPPED = -Infinity;",
		"let deDist = 0;",
		"let periodOn = true;",
		"let periodEps2 = " + PERIOD_EPS2 + ";",   // zoom-scaled, set per tile
		"let useDD = false;",                       // deep-view precision, set per tile
		"let _dhi = 0, _dlo = 0;",                  // DD op scratch
		"const DD_SPLIT = " + DD_SPLIT + ";",
		"let bandMap = 0;",
		"let provOn = false, provLo = 0, provHi = 1, provLut = null;",   // provisional CAPPED coloring: workers keep it OFF (→black per tile); main thread recolors
		"let ssaaOn = true;",   // SSAA toggle; initial tiles send false (1-sample fast frame), SSAA runs as a background pass
		"let usePert = false;",
		"let refZx = new Float64Array(1), refZy = new Float64Array(1), refLen = 0;",
		"let refZxl = new Float64Array(1), refZyl = new Float64Array(1);",
		"let refOffX = 0, refOffY = 0;",
		"let pertRhoThresh = 0.1;",
		"let _refGen = -1;",   // gen the cached reference orbit was computed for
		"let iterAcc = 0, escAcc = 0, inAcc = 0, perAcc = 0, capAcc = 0;",
		escapeSmooth.toString(),
		ddAdd.toString(),
		ddMul.toString(),
		ddSq.toString(),
		escapeSmoothDD.toString(),
		refOrbitLen.toString(),
		computeRef.toString(),
		escapeSmoothPert.toString(),
		escapeAtPt.toString(),
		bandTransform.toString(),
		colorSample.toString(),
		renderRegion.toString(),
		sharpenPoints.toString(),
		ssaaPoints.toString(),
		"let PAL = null;",
		"onmessage = function (e) {",
		"  var m = e.data;",
		"  if (m.type === 'palette') { PAL = m; return; }",
		"  periodOn = m.usePeriod;",
		"  periodEps2 = m.periodEps2;",
		"  useDD = m.useDD;",
		"  usePert = m.usePert;",
		"  pertRhoThresh = m.pertRhoThresh;",
		"  bandMap = m.bandMap;",
		"  ssaaOn = m.ssaaOn !== false;",   // default true; initial full-render sends false
		"  iterAcc = 0; escAcc = 0; inAcc = 0; perAcc = 0; capAcc = 0;",
		"  if (usePert && m.gen !== _refGen) { computeRef(m.view, m.maxIters); _refGen = m.gen; }",   // reference once per gen (covers full + ssaa jobs)
		"  if (m.idx && m.ssaaJob) {",   // background SSAA: supersample only the listed edge points, packed colors
		"    var colS = new Uint32Array(m.idx.length);",
		"    ssaaPoints(colS, m.idx, m.ox, m.oy, m.tw, m.canvasW, m.canvasH, m.view, m.maxIters,",
		"               PAL.lut, PAL.inSet, m.densityMul, PAL.cyclic, m.mode, m.lvlLo, m.lvlHi);",
		"    postMessage({ type: 'done', gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th, idx: m.idx, ssaaJob: true,",
		"                  iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,",
		"                  col: colS.buffer }, [colS.buffer]);",
		"    return;",
		"  }",
		"  if (m.idx) {",   // sharpen: re-iterate only the listed capped points, packed results
		"    var muS = new Float32Array(m.idx.length), deS = new Float32Array(m.idx.length);",
		"    sharpenPoints(muS, deS, m.idx, m.ox, m.oy, m.tw, m.canvasW, m.canvasH, m.view, m.maxIters);",
		"    postMessage({ type: 'done', gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th, idx: m.idx,",
		"                  iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,",
		"                  mu: muS.buffer, de: deS.buffer }, [muS.buffer, deS.buffer]);",
		"    return;",
		"  }",
		"  var n = m.tw * m.th;",
		"  var out = new Uint32Array(n), muF = new Float32Array(n), deF = new Float32Array(n);",
		"  renderRegion(out, muF, deF, m.tw, m.ox, m.oy, m.tw, m.th, m.canvasW, m.canvasH,",
		"               m.view, m.maxIters, PAL.lut, PAL.inSet, m.densityMul, PAL.cyclic, m.mode);",
		"  postMessage({ type: 'done', gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th,",
		"                iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc,",
		"                buf: out.buffer, mu: muF.buffer, de: deF.buffer }, [out.buffer, muF.buffer, deF.buffer]);",
		"};",
	].join("\n");
}

class FractalRenderer {
	private workers: Worker[] = [];
	private idle: boolean[] = [];
	private queue: TileJob[] = [];
	private gen = 0;
	private view: View = { ...DEFAULT_VIEW };
	private maxIters = ITER_BASE;
	private palette: Palette;
	private wrap: boolean;         // effective wrap (palette default; user-overridable)
	private densityBase: number;   // effective density (palette default; user-overridable)
	private lut!: Uint32Array;
	private inSet = 0;
	private densityMul = 1 / 32;
	private bandMap = 0;           // escape-time band transfer (0 linear / 1 sqrt / 2 log)
	private mode = 0; // 0 = escape-time, 1 = distance
	// Escape-count range of the current view, for the auto-leveled (non-cyclic)
	// ramp. Recomputed from the field when each render completes; a monotonic
	// ramp needs this or it clamps to one end once escape counts get large (which
	// they do everywhere at deep zoom), collapsing to a flat fill.
	private muLo = 0;
	private muHi = 1;
	// Whole-frame tallies for the telemetry grid. The status counts (wf*) are maintained LIVE as
	// tiles land — incremented per FF tile, reclassified per IS resolve — then reconciled to the
	// authoritative full-field scan in computeLevels each generation. muMax also grows live.
	private muMax = -Infinity;   // deepest escaper's smooth iteration value (grows live)
	private wfEsc = 0;           // escaped (exterior) pixels
	private wfCap = 0;           // still-CAPPED pixels
	private wfIns = 0;           // proven in-set (interior) pixels
	// Exterior pixels credited to each resolution path (cumulative over the frame; sums to wfEsc).
	private xPert = 0;
	private xDD = 0;
	private xDirect = 0;
	private p50 = 0;             // dwell thresholds (smooth iters), from computeLevels' histogram
	private p90 = 0;
	private frameStart = 0;      // performance.now() at render() — throughput spans the whole frame
	private frameIters = 0;      // cumulative iterations across every generation of this frame
	private lastStatsEmit = 0;   // throttle for live per-tile stats emits
	// Stored per-pixel fields (1 sample) so coloring can be redone on the main
	// thread instantly, without re-iterating.
	private muField: Float32Array;
	private deField: Float32Array;
	// Provisional coloring of CAPPED pixels (see kernel.ts): shade the first frame's
	// unresolved points by their log|z'| structure signal (stored in deField) through a
	// paper→ink ramp, instead of leaving them black. On by default; mandelProv() A/Bs it.
	// provLo/provHi is the auto-leveled range over the current frame's CAPPED pixels.
	private provOn = true;
	private provLut!: Uint32Array;
	private provLo = 0;
	private provHi = 1;
	// Instrumentation for the current generation: wall-clock + iteration totals +
	// outcome tallies (escaped / proven in-set / capped).
	private renderStart = 0;
	private genStats: GenStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 };
	private lastMs = 0;
	private onComplete: (() => void) | null = null;
	private usePeriod = true; // periodicity checking (A/B toggle via mandelPeriod())
	private periodEps2 = PERIOD_EPS2; // zoom-scaled cycle-detection threshold (set per render)
	private useDD = false; // double-double orbit precision (auto per view; set per render)
	private ddOverride: boolean | null = null; // mandelDD() force on/off; null = auto-gate
	private usePert = false; // perturbation fast path (deep zoom; follows useDD unless overridden)
	private pertOverride: boolean | null = null; // mandelPert() force on/off; null = follow useDD
	private pertRhoThresh = 0.1; // error-bound glitch-flag threshold (higher = fewer flags → less idle DD)
	// Progressive sharpening. After the initial (fast, low-cap) frame lands, the
	// idle worker pool re-iterates the CAPPED tiles at an escalating cap. `stage`
	// is the escalation step (0 = initial frame); `undetermined` is the live count
	// of still-CAPPED pixels entering a stage. onProgress fires after every
	// generation so the UI can split the undetermined count into two buckets:
	// `working` (still being iterated) and `abandoned` (left capped once escalation
	// stops — points the cost/precision policy gave up on). sharpenOn gates the
	// whole feature (off for clean A/B benchmarking of the initial-frame path).
	private sharpenOn = true;
	private sharpenStage = 0;
	private undetermined = 0;
	// Sharpening sub-phase for a perturbation window: 'pert' re-iterates CAPPED pixels in the cheap
	// perturbation path (resolving cap-limited pixels), then switches to 'dd' for the glitchy remainder
	// that perturbation can't decide. Non-pert windows stay 'dd' (their sharpen is plain f64/DD).
	private sharpenMode: "pert" | "dd" = "dd";
	// Background anti-aliasing. The initial pass renders 1-sample (fast); once sharpening
	// settles, a single generation supersamples only the edge pixels (ssaaPoints) to anti-alias
	// the resting frame — off the critical path, so the first frame stays fast. ssaaPhase marks
	// that the in-flight generation is that SSAA pass; ssaaRefine gates the feature (A/B).
	private ssaaRefine = true;
	private ssaaPhase = false;
	public onProgress: ((p: { working: number; abandoned: number; sharpening: boolean; done: boolean; phase: string }) => void) | null = null;
	// Fired alongside onProgress as a generation lands, carrying the frame's headline telemetry
	// (zoom, precision, deepest iterations reached) for the UI stats line.
	public onStats: ((s: FrameStats) => void) | null = null;
	// Fired each render with the working precision in BITS (64 = f64, 128 = double-double,
	// 192 = triple-double, …), so the UI can show it and explain the slower deep renders.
	// Bits, not a bool, so it generalizes to future multi-double levels.
	public onPrecision: ((bits: number) => void) | null = null;
	// Live working count during a sharpening stage: seeded with the entering capped
	// count, then decremented per tile in onDone so a long high-cap stage keeps the
	// readout ticking instead of frozen until the whole stage finishes. lastEmit
	// throttles those per-tile emits to ~25 Hz.
	private workingLive = 0;
	private lastEmit = 0;

	public constructor(palette: Palette) {
		this.palette = palette;
		this.wrap = palette.cyclic;
		this.densityBase = palette.density;
		this.rebuildPalette();
		this.densityMul = 1 / this.densityBase;
		this.muField = new Float32Array(canvas.width * canvas.height);
		this.deField = new Float32Array(canvas.width * canvas.height);
		try {
			const url = URL.createObjectURL(
				new Blob([buildWorkerSource()], { type: "application/javascript" }),
			);
			const n = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, WORKER_CAP));
			for (let i = 0; i < n; i++) {
				const w = new Worker(url);
				const idx = i;
				w.onmessage = (e: MessageEvent) => this.onDone(idx, e.data as DoneMsg);
				w.onerror = (e: ErrorEvent) => console.error("MandelJS worker error:", e.message);
				this.workers.push(w);
				this.idle.push(true);
			}
			URL.revokeObjectURL(url);
			this.sendPalette();
		} catch {
			this.workers = []; // no workers available -> synchronous fallback
		}
	}

	private rebuildPalette(): void {
		const { ink, paper } = themeColors();
		const built = this.palette.build(ink, paper, this.wrap);
		this.lut = built.lut;
		this.inSet = built.inSet;
		// Provisional CAPPED ramp: a theme-aware paper→ink gradient (the `subtle` palette),
		// so the developing first frame reads as a quiet monochrome underlay under any palette.
		this.provLut = PALETTES.subtle.build(ink, paper, false).lut;
	}

	// Each worker gets its own copy of the LUT (structured clone, ~4KB).
	private sendPalette(): void {
		const msg = {
			type: "palette", lut: this.lut, inSet: this.inSet, cyclic: this.wrap,
		};
		for (const w of this.workers) w.postMessage(msg);
	}

	// Re-read the theme and recolor from the stored field — instant, no re-iterate.
	public recolor(): void {
		this.rebuildPalette();
		this.sendPalette();
		this.colorizeField();
	}

	// Switch coloring mode (0 = escape-time, 1 = distance) — instant recolor from
	// the stored field (1-sample; SSAA returns on the next render/zoom).
	public setColorMode(mode: number): void {
		this.mode = mode;
		this.colorizeField();
	}

	// Toggle periodicity checking and re-render — for A/B benchmarking.
	public setPeriod(on: boolean): void {
		this.usePeriod = on;
	}

	// Force double-double precision on/off, or null to restore auto-gating by zoom.
	// For A/B on the wall window (mandelDD(false) vs mandelDD(true)).
	public setDD(on: boolean | null): void {
		this.ddOverride = on;
	}

	// Force the perturbation fast path on/off for A/B (null = follow the DD auto-gate).
	public setPert(on: boolean | null): void {
		this.pertOverride = on;
	}

	// Toggle provisional CAPPED coloring on/off and recolor instantly from the stored field
	// — the live A/B of the developing-underlay vs the old all-black first frame. Freeze the
	// frame first (mandelSharpen(false)) to hold CAPPED pixels for a clean comparison.
	public setProv(on: boolean): void {
		this.provOn = on;
		if (on) this.computeProvLevels();
		this.colorizeField();
	}

	// Switch to a different palette. Resets wrap/density to the palette's own
	// defaults, then recolors instantly from the stored field.
	public setPalette(palette: Palette): void {
		this.palette = palette;
		this.wrap = palette.cyclic;
		this.densityBase = palette.density;
		this.rebuildPalette();
		this.sendPalette();
		this.densityMul = this.densityMulFor(this.view);
		this.colorizeField();
	}

	// Toggle wrap (cyclic bands vs. a single clamped ramp). Rebuilds the LUT so
	// wrapping stays seamless, re-sends it to the workers, and recolors instantly.
	public setWrap(wrap: boolean): void {
		this.wrap = wrap;
		this.rebuildPalette();
		this.sendPalette();
		this.densityMul = this.densityMulFor(this.view);
		this.colorizeField();
	}

	// Set the base color density (band width, escape-time mode). Recolors
	// instantly; the worker path picks it up on the next render.
	public setDensity(density: number): void {
		this.densityBase = density;
		this.densityMul = this.densityMulFor(this.view);
		this.colorizeField();
	}

	// Set the escape-time band transfer (0 linear / 1 sqrt / 2 log). sqrt/log give
	// zoom-consistent, zoom-stable banding and drop the zoom density stretch (see
	// densityMulFor). A pure recolor from the stored field — instant, no re-iterate.
	public setBandMap(n: number): void {
		this.bandMap = n;
		this.densityMul = this.densityMulFor(this.view);
		this.colorizeField();
	}

	// Repaint the whole canvas from the stored 1-sample field with the current
	// palette/mode — the coloring pass, run on the main thread, no iteration.
	private colorizeField(): void {
		const W = canvas.width, H = canvas.height, N = W * H;
		const image = ctx.getImageData(0, 0, W, H);
		const data32 = new Uint32Array(image.data.buffer);
		const lut = this.lut, inSet = this.inSet;
		const densityMul = this.densityMul, cyclic = this.wrap, mode = this.mode, bandMap = this.bandMap;
		const pixelSize = this.view.spanX / W;
		const mu = this.muField, de = this.deField;
		// Push provisional-coloring state into the kernel globals colorSample reads, so CAPPED
		// pixels shade via the paper→ink ramp (or stay in-set when provOn is off).
		provOn = this.provOn; provLo = this.provLo; provHi = this.provHi; provLut = this.provLut;
		// Auto-leveled range for the non-cyclic escape-time ramp — normalizes mu to the
		// view's escape-count range so the gradient spans the visible structure at any
		// depth; cyclic and distance modes ignore it (see colorSample).
		const lo = this.muLo, hi = this.muHi;
		for (let i = 0; i < N; i++) {
			data32[i] = colorSample(mu[i], de[i], lut, inSet, mode, cyclic, densityMul, pixelSize, bandMap, lo, hi);
		}
		ctx.putImageData(image, 0, 0);
	}

	// After a render completes, measure the escape-count range so the non-cyclic
	// ramp can auto-level against it. Uses a histogram with 1%/99% clipping so a
	// few near-boundary outliers (mu ~ maxIters right against the set) don't
	// compress the whole gradient. Cheap: a couple of O(N) passes.
	private computeLevels(): void {
		const mu = this.muField, N = mu.length;
		let mn = Infinity, mx = -Infinity, cnt = 0, capped = 0, inset = 0;
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (isFinite(m)) { cnt++; if (m < mn) mn = m; if (m > mx) mx = m; }
			else if (m === CAPPED) capped++;   // -Infinity: still undetermined
			else inset++;                      // +Infinity (IN_SET) or NaN: interior
		}
		// Reconcile the live status tallies to this authoritative full-field scan, and stash muMax.
		this.muMax = mx; this.wfEsc = cnt; this.wfCap = capped; this.wfIns = inset;
		if (cnt === 0 || mx <= mn) { this.muLo = 0; this.muHi = 1; this.p50 = this.p90 = 0; return; }
		const BINS = 512;
		const linHist = new Uint32Array(BINS);   // linear: color-clip window
		const logHist = new Uint32Array(BINS);   // log: dwell percentiles
		const scale = (BINS - 1) / (mx - mn);
		// Dwell is heavy-tailed — nearly every exterior pixel escapes fast, a rare few near the boundary
		// take vastly longer. A linear histogram lets one deep outlier stretch the range until the whole
		// bulk collapses into bin 0 (p50 == p90). Bin the percentiles in LOG space so resolution stays
		// fine across the bulk regardless of the tail; the color clip keeps its linear binning.
		const lmn = Math.log(Math.max(mn, 1)), lmx = Math.log(Math.max(mx, mn + 1));
		const lscale = (BINS - 1) / Math.max(lmx - lmn, 1e-9);
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (!isFinite(m)) continue;
			linHist[((m - mn) * scale) | 0]++;
			const lb = ((Math.log(Math.max(m, 1)) - lmn) * lscale) | 0;
			logHist[lb < 0 ? 0 : lb >= BINS ? BINS - 1 : lb]++;
		}
		// Color window: 1%/99% clip on the linear histogram so a few boundary outliers don't flatten the ramp.
		const loTarget = cnt * 0.01, hiTarget = cnt * 0.99;
		let acc = 0, loBin = 0, hiBin = BINS - 1;
		for (let b = 0; b < BINS; b++) {
			acc += linHist[b];
			if (loBin === 0 && acc >= loTarget) loBin = b;
			if (acc >= hiTarget) { hiBin = b; break; }
		}
		this.muLo = mn + loBin / scale;
		this.muHi = mn + hiBin / scale;
		if (this.muHi <= this.muLo) this.muHi = this.muLo + 1;
		// Dwell thresholds: 50%/90% percentiles from the log histogram, mapped back to iteration counts.
		const p50Target = cnt * 0.5, p90Target = cnt * 0.9;
		let accL = 0, p50Bin = -1, p90Bin = -1;
		for (let b = 0; b < BINS; b++) {
			accL += logHist[b];
			if (p50Bin < 0 && accL >= p50Target) p50Bin = b;
			if (accL >= p90Target) { p90Bin = b; break; }
		}
		this.p50 = Math.exp(lmn + (p50Bin < 0 ? 0 : p50Bin) / lscale);
		this.p90 = Math.exp(lmn + (p90Bin < 0 ? 0 : p90Bin) / lscale);
	}

	// Pack a provisional heat color for one CAPPED pixel's structure signal (log|z'|),
	// leveled to the current [provLo, provHi]. Used to paint each tile as it lands.
	private provColor(logDz: number): number {
		const span = this.provHi > this.provLo ? this.provHi - this.provLo : 1;
		let t = (logDz - this.provLo) / span;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return this.provLut[(t * (this.provLut.length - 1)) | 0];
	}

	// Grow this frame's running provisional range to cover a tile's CAPPED pixels, so tiles
	// can paint their heat as they arrive — before the whole frame (hence a global level) exists.
	// computeProvLevels replaces this with the clipped global range once the pass completes.
	private updateProvRange(mu: Float32Array, de: Float32Array): void {
		let lo = this.provLo, hi = this.provHi;
		for (let p = 0; p < mu.length; p++) {
			if (mu[p] === CAPPED) { const v = de[p]; if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
		}
		this.provLo = lo; this.provHi = hi;
	}

	// Auto-level the provisional structure signal (log|z'|, stored in deField) over just
	// the CAPPED pixels, so the paper→ink underlay spans their range — 1%/99% clipped like
	// computeLevels so a few near-boundary outliers don't flatten it. No-op if nothing capped.
	private computeProvLevels(): void {
		const mu = this.muField, de = this.deField, N = mu.length;
		let mn = Infinity, mx = -Infinity, cnt = 0;
		for (let i = 0; i < N; i++) {
			if (mu[i] === CAPPED) { const v = de[i]; if (isFinite(v)) { cnt++; if (v < mn) mn = v; if (v > mx) mx = v; } }
		}
		if (cnt === 0 || mx <= mn) { this.provLo = 0; this.provHi = 1; return; }
		const BINS = 256;
		const hist = new Uint32Array(BINS);
		const scale = (BINS - 1) / (mx - mn);
		for (let i = 0; i < N; i++) {
			if (mu[i] === CAPPED) { const v = de[i]; if (isFinite(v)) hist[((v - mn) * scale) | 0]++; }
		}
		const loTarget = cnt * 0.01, hiTarget = cnt * 0.99;
		let acc = 0, loBin = 0, hiBin = BINS - 1;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= loTarget) { loBin = b; break; } }
		acc = 0;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= hiTarget) { hiBin = b; break; } }
		this.provLo = mn + loBin / scale;
		this.provHi = mn + hiBin / scale;
		if (this.provHi <= this.provLo) this.provHi = this.provLo + 1;
	}

	// Called once a render generation fully lands. Refresh the auto-level range
	// (kept current so a later wrap-off switch has it), and for a non-cyclic
	// escape-time view, repaint from the field so the ramp spans the structure —
	// the workers colored progressively with a flat clamp; this snaps it right.
	// On the initial frame, also level + paint the provisional CAPPED underlay (workers
	// left those pixels black), so a high-dwell all-CAPPED frame develops instead of blacking out.
	private finalizeColors(): void {
		this.computeLevels();
		if (this.provOn && this.sharpenStage === 0) this.computeProvLevels();
		// Skip the recolor after the SSAA generation — colorizeField repaints from the 1-sample
		// field and would clobber the just-blitted anti-aliased edge pixels (matters for non-cyclic).
		if (!this.ssaaPhase && ((this.provOn && this.sharpenStage === 0) || (!this.wrap && this.mode === 0))) this.colorizeField();
	}

	// Fired once a render generation fully lands (worker or sync path): auto-level
	// the ramp, record timing, log stats when debugging, and resolve any waiter.
	private onGenerationComplete(): void {
		this.finalizeColors();
		this.lastMs = performance.now() - this.renderStart;
		if (DEBUG) this.logStats();
		const cb = this.onComplete; this.onComplete = null;
		if (cb) cb();
		this.afterGeneration();
	}

	// Emit the frame's headline telemetry to the UI. `deepest` is the honest maximum iterations a
	// single pixel actually ran: while anything is still capped, those pixels reached the current
	// cap (maxIters); once nothing is capped, it's the deepest escaper's dwell (floor of muMax).
	private emitStats(done: boolean): void {
		if (!this.onStats) return;
		const deepest = this.wfCap > 0 ? this.maxIters
			: this.muMax > 0 ? Math.floor(this.muMax) : this.maxIters;
		const elapsed = (performance.now() - this.frameStart) / 1000;
		this.onStats({
			zoom: DEFAULT_VIEW.spanX / this.view.spanX,
			bits: this.useDD ? 128 : 64,
			maxIters: this.maxIters,
			deepest,
			escaped: this.wfEsc,
			inSet: this.wfIns,
			capped: this.wfCap,
			xPert: this.xPert,
			xDD: this.xDD,
			xDirect: this.xDirect,
			itersPerSec: elapsed > 0 ? this.frameIters / elapsed : 0,
			p50: this.p50,
			p90: this.p90,
			done,
		});
	}

	// Credit n exterior pixels to the compute path that resolved them. `pertActive` is true for the
	// perturbation path; otherwise it's exact DD when the view runs double-double, else direct f64.
	private addMethod(pertActive: boolean, n: number): void {
		if (pertActive) this.xPert += n;
		else if (this.useDD) this.xDD += n;
		else this.xDirect += n;
	}

	// Scan the stored field for still-undetermined (CAPPED) pixels: the total count
	// (for the UI countdown) and the tiles containing any, ordered hardest-first
	// (most capped pixels). That ordering makes the sharpening queue run
	// longest-processing-time-first, which a scheduling sim showed erases the
	// ~19% worker-idle tail a naive row-major order leaves on deep views.
	private scanCapped(): { count: number; tiles: TileJob[] } {
		const W = canvas.width, H = canvas.height, mu = this.muField;
		const tiles: TileJob[] = [];
		let total = 0;
		for (let oy = 0; oy < H; oy += TILE_H) {
			const th = Math.min(TILE_H, H - oy);
			for (let ox = 0; ox < W; ox += TILE_W) {
				const tw = Math.min(TILE_W, W - ox);
				const idxArr: number[] = [];
				for (let r = 0; r < th; r++) {
					const row = (oy + r) * W + ox;
					for (let k = 0; k < tw; k++) if (mu[row + k] === CAPPED) idxArr.push(r * tw + k);
				}
				if (idxArr.length > 0) { tiles.push({ ox, oy, tw, th, idx: Int32Array.from(idxArr) }); total += idxArr.length; }
			}
		}
		tiles.sort((a, b) => b.idx!.length - a.idx!.length); // LPT: hardest tiles first
		return { count: total, tiles };
	}

	// Scan the resolved 1-sample field for EDGE pixels (colour differs from a 4-neighbour by
	// > EDGE_TH), grouped into tiles, for the background SSAA pass. Colours are recomputed from
	// the stored (mu, de) field — the same coloring the resting frame uses — so cross-tile edges
	// are found correctly with no per-tile border. Same edge criterion as the old inline
	// renderRegion SSAA, so the deferred pass anti-aliases exactly the pixels it would have.
	private scanEdges(): { count: number; tiles: TileJob[] } {
		const W = canvas.width, H = canvas.height, N = W * H;
		provOn = this.provOn; provLo = this.provLo; provHi = this.provHi; provLut = this.provLut;
		const mu = this.muField, de = this.deField, lut = this.lut, inSet = this.inSet;
		const densityMul = this.densityMul, cyclic = this.wrap, mode = this.mode, bandMap = this.bandMap;
		const pixelSize = this.view.spanX / W, lo = this.muLo, hi = this.muHi;
		const col = new Uint32Array(N);
		for (let i = 0; i < N; i++) col[i] = colorSample(mu[i], de[i], lut, inSet, mode, cyclic, densityMul, pixelSize, bandMap, lo, hi);
		const cd = (a: number, b: number): number =>
			Math.abs((a & 255) - (b & 255)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
		const tiles: TileJob[] = [];
		let total = 0;
		for (let oy = 0; oy < H; oy += TILE_H) {
			const th = Math.min(TILE_H, H - oy);
			for (let ox = 0; ox < W; ox += TILE_W) {
				const tw = Math.min(TILE_W, W - ox);
				const idxArr: number[] = [];
				for (let r = 0; r < th; r++) {
					const gy = oy + r;
					for (let k = 0; k < tw; k++) {
						const gx = ox + k, gi = gy * W + gx, c = col[gi];
						if ((gx > 0 && cd(c, col[gi - 1]) > EDGE_TH) ||
							(gx < W - 1 && cd(c, col[gi + 1]) > EDGE_TH) ||
							(gy > 0 && cd(c, col[gi - W]) > EDGE_TH) ||
							(gy < H - 1 && cd(c, col[gi + W]) > EDGE_TH)) idxArr.push(r * tw + k);
					}
				}
				if (idxArr.length > 0) { tiles.push({ ox, oy, tw, th, idx: Int32Array.from(idxArr), ssaaJob: true }); total += idxArr.length; }
			}
		}
		tiles.sort((a, b) => b.idx!.length - a.idx!.length); // LPT: heaviest tiles first
		return { count: total, tiles };
	}

	// Post-generation hook: refresh the undetermined count, drive the UI, and — if
	// anything is still capped and we haven't reached the target cap — kick the next
	// sharpening stage on the (now idle) pool at a higher cap over just those tiles.
	// A superseding view bumps the generation, so a stage scheduled here is
	// abandoned before it paints if the user has moved on.
	private afterGeneration(): void {
		if (this.workers.length === 0) return;
		// The just-completed generation WAS the background SSAA pass → the frame is fully
		// resolved and anti-aliased. Nothing more to schedule.
		if (this.ssaaPhase) {
			this.ssaaPhase = false;
			if (this.onProgress) this.onProgress({ working: 0, abandoned: this.undetermined, sharpening: false, done: true, phase: "done" });
			this.emitStats(true);
			return;
		}
		if (!this.sharpenOn) return;   // clean initial-frame path (bench): no sharpen, no AA
		const prev = this.undetermined;                       // capped count entering this stage
		const { count, tiles } = this.scanCapped();           // capped count after it
		const resolved = this.sharpenStage === 0 ? 0 : prev - count;
		this.undetermined = count;

		// Perturbation-first sharpening (pert windows). Re-iterate the CAPPED pixels in the cheap f64
		// perturbation path: cap-limited pixels escape as the cap rises; only genuine glitches stay
		// CAPPED (perturbation never resolves them). Keep escalating while it's still RESOLVING pixels
		// — productivity only, NOT the "cheap" clause, since pert is always cheap and would otherwise
		// escalate forever. When pert stops helping (or its reference orbit would grow past
		// PERT_SHARPEN_CEIL), hand the glitchy remainder to exact DD instead of dumping every capped
		// pixel there up front. This is what keeps perturbation working as long as it actually helps.
		if (this.sharpenMode === "pert" && count > 0) {
			const yielded = prev > 0 ? resolved / prev : 1;
			const productive = this.sharpenStage === 0 || yielded >= SHARPEN_MIN_YIELD;
			this.workingLive = count;
			if (this.onProgress) this.onProgress({ working: count, abandoned: 0, sharpening: true, done: false, phase: "refining" });
			this.emitStats(false);
			if (productive && this.maxIters < PERT_SHARPEN_CEIL) {
				this.sharpenStage++;
				this.beginGeneration(Math.min(PERT_SHARPEN_CEIL, Math.round(this.maxIters * SHARPEN_MULT)), tiles);
			} else {
				this.sharpenMode = "dd";   // perturbation exhausted → DD the remainder (same cap; DD escalates from here)
				this.beginGeneration(this.maxIters, tiles);
			}
			return;
		}

		const done = this.sharpenDone(count, prev, tiles.length, resolved);
		if (done) {
			// The mu-field is fully resolved. Emit the final numbers now; maybeStartSSAA reports the
			// terminal phase (anti-aliasing if there are edges to refine, else done).
			this.emitStats(true);
			this.maybeStartSSAA();
			return;
		}
		// Still sharpening: the survivors are "working" and the grid keeps digging.
		if (this.onProgress) this.onProgress({ working: count, abandoned: 0, sharpening: true, done: false, phase: "refining" });
		this.emitStats(false);
		this.sharpenStage++;
		this.workingLive = count;   // entering capped count; onDone ticks it down live per tile
		const nextCap = Math.min(SHARPEN_CEILING, Math.round(this.maxIters * SHARPEN_MULT));
		this.beginGeneration(nextCap, tiles);   // each tile carries its capped-point idx
	}

	// One-shot background anti-aliasing: supersample only the edge pixels of the now-resolved
	// frame (ssaaPoints), so the resting image is crisp without the initial pass ever paying the
	// SSAA cost. Started once, after sharpening settles; ssaaPhase marks the in-flight generation.
	private maybeStartSSAA(): void {
		// Terminal report when nothing will be anti-aliased: the frame is fully done.
		const settle = () => {
			if (this.onProgress) this.onProgress({ working: 0, abandoned: this.undetermined, sharpening: false, done: true, phase: "done" });
		};
		if (!this.ssaaRefine || this.ssaaPhase) { settle(); return; }
		const { count, tiles } = this.scanEdges();
		if (count === 0) { settle(); return; }
		this.ssaaPhase = true;
		// The image is resolved but still refining its edges — report the anti-aliasing phase.
		if (this.onProgress) this.onProgress({ working: 0, abandoned: this.undetermined, sharpening: false, done: false, phase: "anti-aliasing" });
		this.beginGeneration(this.maxIters, tiles);   // maxIters carries through; tiles hold edge idx + ssaaJob
	}

	// Whether to stop escalating. Continue while the last stage stayed worth it —
	// it resolved a meaningful share of what remained (productive) OR was fast
	// enough to be a free tickle (cheap). Stop only when a stage is both
	// unproductive and not cheap, or when the cap hits the precision ceiling (past
	// which more float64 iterations can't decide a point), or nothing is left.
	// Always run at least one sharpening pass.
	private sharpenDone(count: number, prev: number, tileCount: number, resolved: number): boolean {
		if (count === 0 || tileCount === 0) return true;
		if (this.sharpenStage === 0) return false;
		if (this.maxIters >= SHARPEN_CEILING) return true;
		const yielded = prev > 0 ? resolved / prev : 0;
		const cheap = this.lastMs < SHARPEN_CHEAP_MS;
		const productive = yielded >= SHARPEN_MIN_YIELD;
		return !(cheap || productive);
	}

	// Toggle progressive sharpening (default on). Off = the initial pass only —
	// for clean A/B benchmarking of the first-frame path.
	public setSharpen(on: boolean): void { this.sharpenOn = on; }

	private logStats(): void {
		console.log("[mandel] " + this.statLine());
	}

	// Human-readable one-liner of the current generation's stats. Shared by the
	// ?debug per-render log and the bench summary. "capped % of iters" is the
	// theoretical headroom for periodicity checking — the share of all iteration
	// work spent on points that hit maxIters without resolving.
	private statLine(): string {
		const s = this.genStats;
		const pts = s.esc + s.ins + s.per + s.cap || 1;
		const px = canvas.width * canvas.height;
		const cappedIterPct = s.iters ? (100 * s.cap * this.maxIters / s.iters) : 0;
		return "zoom " + (DEFAULT_VIEW.spanX / this.view.spanX).toExponential(2) + "x · " +
			this.lastMs.toFixed(1) + " ms · " + (s.iters / 1e6).toFixed(2) + "M iters (" +
			(s.iters / px).toFixed(0) + "/px) · pts " + (100 * s.esc / pts).toFixed(0) + "% esc / " +
			(100 * s.ins / pts).toFixed(0) + "% in / " + (100 * s.per / pts).toFixed(0) + "% period / " +
			(100 * s.cap / pts).toFixed(0) + "% capped · capped burns " + cappedIterPct.toFixed(0) +
			"% of iters · period=" + (this.usePeriod ? "on" : "off") +
			" · prec=" + (this.useDD ? "dd" : "f64");
	}

	// Render the current view and resolve when it fully lands — for benchmarking.
	public renderAndWait(view: View): Promise<{ ms: number; stats: GenStats; maxIters: number }> {
		return new Promise((resolve) => {
			this.onComplete = () => resolve({ ms: this.lastMs, stats: this.genStats, maxIters: this.maxIters });
			this.render(view);
		});
	}

	// Iterations grow with zoom depth (deeper => more, capped) unless overridden.
	private itersForView(v: View, usePert: boolean): number {
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		if (zoom <= 1) return ITER_BASE;
		const budget = Math.round(ITER_BASE + ITER_SLOPE * Math.log2(zoom));
		return usePert ? Math.min(ITER_CAP_PERT, budget * PERT_ITER_MULT) : Math.min(ITER_CAP, budget);
	}

	// Probe the view's actual dwell (escape-time) distribution on a sparse grid, then size the
	// first-pass cap to resolve ~FF_PROBE_PCT of it in ONE pass. Replaces the zoom-only formula's
	// blind clamp for the f64 path: a high-dwell (e.g. near-minibrot) window escapes far later than
	// the formula guesses, so the formula's cap yields an all-black first frame that sharpening then
	// redoes. Runs the same f64 kernel the render uses, with periodicity on (so interior probe points
	// resolve early and don't drive the cap). Clamped to [formula floor, FF_SUPER_CAP]; the residual
	// beyond the cap falls to sharpening. Cost: FF_PROBE_NX·NY points × their dwell (≈tens of ms).
	private probeCap(view: View): number {
		const floor = this.itersForView(view, false);   // never below the current formula/clamp
		const zoom = DEFAULT_VIEW.spanX / view.spanX;
		const budgetPerPx = FF_BUDGET_BASE + FF_BUDGET_SLOPE * Math.max(0, Math.log2(zoom));   // scales with depth
		const probeCeil = Math.max(floor, Math.round(budgetPerPx * FF_PROBE_CEIL_MULT));       // dwell measurement ceiling
		periodOn = this.usePeriod;                        // kernel globals escapeSmooth reads
		periodEps2 = this.periodEps2;
		const dwells: number[] = [];
		for (let j = 0; j < FF_PROBE_NY; j++) {
			const offY = ((j + 0.5) / FF_PROBE_NY - 0.5) * view.spanY;
			for (let i = 0; i < FF_PROBE_NX; i++) {
				const offX = ((i + 0.5) / FF_PROBE_NX - 0.5) * view.spanX;
				const mu = escapeSmooth(view.cx + offX, view.cy + offY, probeCeil);
				if (mu === CAPPED) dwells.push(probeCeil);   // unresolved by the ceiling → drives cap up
				else if (isFinite(mu)) dwells.push(mu);        // escaped at ~mu → its dwell
				// IN_SET (+∞): interior, resolves via periodicity regardless of cap → ignore
			}
		}
		if (dwells.length === 0) return floor;               // all-interior view → nothing to size against
		dwells.sort((a, b) => a - b);
		// Quality target: the cap that resolves ~FF_PROBE_PCT of the escaping pixels this pass.
		const pct = dwells[Math.min(dwells.length - 1, Math.floor(dwells.length * FF_PROBE_PCT))];
		const target = Math.ceil(pct * FF_PROBE_MARGIN);
		// Budget ceiling: the largest cap whose mean iters/px stays within the depth-scaled budget.
		const budgetCap = this.capForBudget(dwells, budgetPerPx, probeCeil);
		return Math.max(floor, Math.min(target, budgetCap, probeCeil));
	}

	// Largest cap C such that the sampled mean of min(dwell, C) stays within budgetPerPx. Mean-iters
	// is monotonic in C, so binary-search between 0 and `hi`; returns `hi` if the budget already
	// covers the whole probe range (i.e. the budget doesn't bind and the percentile target wins).
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

	// Cycle-detection ε² tightens with zoom. Longer deep-zoom orbits let a chaotic
	// exterior orbit brush within the loose threshold by recurrence (false in-set),
	// so above ZOOM0 we shrink ε² ∝ (zoom)^-0.8 (ε ∝ zoom^-0.4), floored at the f64
	// noise level. Calibrated so the loose base holds until ~1e5 and reaches ~1e-13
	// (ε) near 1e12 — which drove a zoom-7e11 window's false-black from 4.5% to 0.04%
	// with zero true cycles lost.
	//
	// Under DD the f64 floor (1e-28) is too loose — measured 12.7% false-black at
	// zoom ~1e16 — because false-black from exterior orbits shadowing a nearby cycle
	// demands ε tighten FASTER with depth than the f64 0.8-rate. So DD views use a
	// steeper 1.3-rate to a much lower floor; the orbit difference is DD-accurate, so
	// this stays above the noise (a sweep confirmed 0% false-black and 0 dropped cycles).
	private periodEps2For(v: View, useDD: boolean): number {
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		if (zoom <= PERIOD_EPS_ZOOM0) return PERIOD_EPS2;
		if (useDD) {
			const e2 = PERIOD_EPS2 * Math.pow(PERIOD_EPS_ZOOM0 / zoom, 1.3);
			return e2 < PERIOD_EPS2_FLOOR_DD ? PERIOD_EPS2_FLOOR_DD : e2;
		}
		const e2 = PERIOD_EPS2 * Math.pow(PERIOD_EPS_ZOOM0 / zoom, 0.8);
		return e2 < PERIOD_EPS2_FLOOR ? PERIOD_EPS2_FLOOR : e2;
	}

	// Auto-gate double-double: engage once the pixel step nears the coordinate ULP —
	// i.e. f64 is running out of resolution to tell adjacent pixels apart. Uses the
	// larger-magnitude axis (its ULP is coarser, so it hits the wall first). A few
	// octaves of margin (DD_SWITCH_RATIO) so DD is already on before the artifacts.
	private useDDFor(v: View): boolean {
		const step = v.spanX / canvas.width;
		const ulp = Math.max(Math.abs(v.cx), Math.abs(v.cy)) * Number.EPSILON;
		return step < ulp * DD_SWITCH_RATIO;
	}

	// Stretch a cyclic palette's period with zoom so color stops wrapping many
	// times per pixel deep in. Ramp (non-cyclic) palettes clamp, so leave them be.
	private densityMulFor(v: View): number {
		// No zoom stretch for a ramp (clamped) or a compressed band-map — sqrt/log already
		// hold the band rate roughly constant across depth, and the stretch would make them
		// view-DEPENDENT (breaking zoom-stability). Only linear cyclic bands need it.
		if (!this.wrap || this.bandMap !== 0) return 1 / this.densityBase;
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		const stretch = zoom > 1 ? Math.pow(zoom, COLOR_STRETCH_EXP) : 1;
		return 1 / (this.densityBase * stretch);
	}

	public render(view: View, maxItersArg?: number): void {
		this.view = view;
		this.densityMul = this.densityMulFor(view);
		this.useDD = this.ddOverride !== null ? this.ddOverride : this.useDDFor(view);
		this.usePert = this.pertOverride !== null ? this.pertOverride : this.useDD;   // perturbation where DD would engage
		this.periodEps2 = this.periodEps2For(view, this.useDD);   // DD lets ε tighten further (probe below needs it set)
		if (this.onPrecision) this.onPrecision(this.useDD ? 128 : 64);   // 64×limbs
		this.sharpenStage = 0;
		this.undetermined = 0;
		this.ssaaPhase = false;
		this.sharpenMode = this.usePert ? "pert" : "dd";   // pert windows sharpen in perturbation first, then DD
		this.provLo = Infinity; this.provHi = -Infinity;   // reset the per-frame running provisional range
		// Reset the telemetry accumulators for the new frame (counts rebuild as tiles land).
		this.muMax = -Infinity; this.wfEsc = 0; this.wfCap = 0; this.wfIns = 0;
		this.xPert = 0; this.xDD = 0; this.xDirect = 0; this.p50 = 0; this.p90 = 0;
		this.frameStart = performance.now(); this.frameIters = 0; this.lastStatsEmit = 0;
		// Fresh view: clear any leftover sharpening readout until the first frame lands.
		if (this.onProgress) this.onProgress({ working: 0, abandoned: 0, sharpening: false, done: false, phase: "first frame" });

		// Wash the previous frame toward grey so a new render is visibly "working" even when the fresh
		// tiles match the old ones (a homogeneous region reads as frozen otherwise). Grey stays visible
		// over any content (in-set black included); tiles paint back to full colour as they land.
		ctx.fillStyle = "rgba(128, 128, 128, 0.5)";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// Size the initial cap. f64 path: probe the view's actual dwell so a high-dwell window gets a
		// cap that resolves its first frame (not the zoom-only formula's blind guess → all-black). Runs
		// after the wash so the wash is instant. DD/pert keep the formula/pert budget for now.
		const maxIters = maxItersArg ?? (this.useDD || this.usePert ? this.itersForView(view, this.usePert) : this.probeCap(view));

		if (this.workers.length === 0) {
			this.maxIters = maxIters;
			this.gen++;
			this.renderStart = performance.now();
			this.genStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 };
			this.renderSync();
			return;
		}

		// Full-canvas tile queue for the initial pass (no idx => full render).
		const W = canvas.width, H = canvas.height;
		const tiles: TileJob[] = [];
		for (let oy = 0; oy < H; oy += TILE_H)
			for (let ox = 0; ox < W; ox += TILE_W)
				tiles.push({ ox, oy, tw: Math.min(TILE_W, W - ox), th: Math.min(TILE_H, H - oy) });
		this.beginGeneration(maxIters, tiles);
	}

	// Start a new render generation over a given tile queue at a given cap. Shared
	// by the initial full-canvas render and each sharpening pass. Bumping the
	// generation id is what makes a superseding view (or the next stage) abandon
	// any stale in-flight tiles automatically.
	private beginGeneration(maxIters: number, tiles: TileJob[]): void {
		this.maxIters = maxIters;
		this.gen++;
		this.renderStart = performance.now();
		this.genStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 };
		this.queue = tiles;
		// Kick the idle workers; busy ones pull from the new queue as they finish.
		for (let i = 0; i < this.workers.length; i++) if (this.idle[i]) this.dispatch(i);
	}

	private dispatch(i: number): void {
		const tile = this.queue.shift();
		if (!tile) { this.idle[i] = true; return; }
		this.idle[i] = false;
		const msg: TileMsg = {
			type: "tile", gen: this.gen,
			ox: tile.ox, oy: tile.oy, tw: tile.tw, th: tile.th,
			canvasW: canvas.width, canvasH: canvas.height,
			view: this.view, maxIters: this.maxIters, densityMul: this.densityMul, mode: this.mode,
			usePeriod: this.usePeriod, periodEps2: this.periodEps2, useDD: this.useDD,
			// A sharpen job forces the DD path ONLY in the 'dd' sub-phase; the 'pert' sub-phase (and the
			// initial full render + SSAA jobs) keep the view's perturbation path.
			usePert: (tile.idx && !tile.ssaaJob && this.sharpenMode === "dd") ? false : this.usePert, pertRhoThresh: this.pertRhoThresh, bandMap: this.bandMap,
			ssaaOn: false,   // initial full render is 1-sample (fast frame); point jobs ignore this
		};
		if (tile.idx) {
			msg.idx = tile.idx;
			if (tile.ssaaJob) { msg.ssaaJob = true; msg.lvlLo = this.muLo; msg.lvlHi = this.muHi; }
		}
		this.workers[i].postMessage(msg);
	}

	private onDone(i: number, m: DoneMsg): void {
		if (m.gen === this.gen) { // drop stale tiles from a superseded view
			if (m.ssaaJob) this.applySSAA(m);
			else if (m.idx) this.applySharpen(m);
			else this.applyTile(m);
			const s = this.genStats;
			s.iters += m.iters; s.esc += m.esc; s.ins += m.ins; s.per += m.per; s.cap += m.cap;
			this.frameIters += m.iters;
			// Live composition + method, updated as each tile lands (SSAA jobs don't change the field).
			if (!m.ssaaJob) {
				if (m.idx) {                          // IS: capped pixels reclassified
					this.wfEsc += m.esc; this.wfIns += m.ins; this.wfCap -= m.esc + m.ins;
					this.addMethod(this.sharpenMode === "pert", m.esc);
				} else {                              // FF: fresh classification
					this.wfEsc += m.esc; this.wfIns += m.ins; this.wfCap += m.cap;
					this.addMethod(this.usePert, m.esc);
				}
				const now = performance.now();       // throttled live emit so the grid ticks, not floods
				if (now - this.lastStatsEmit > 60) { this.lastStatsEmit = now; this.emitStats(false); }
			}
		}
		this.dispatch(i); // keep the worker fed from the current queue
		// Generation done = the POOL is drained (queue empty + every worker idle), NOT a fact about this
		// tile's gen. With many workers + rapid re-renders the last tile to land can be a STALE one from a
		// superseded gen; gating this on m.gen would then skip completion entirely and strand the current
		// gen — no sharpening, field full of CAPPED points, badge stuck at 0. (Apply above stays gen-guarded.)
		if (this.queue.length === 0 && this.idle.every((x) => x)) {
			this.onGenerationComplete();
		}
	}

	// Initial/full render of a tile: blit its pixels and stash its (mu, deDist) field.
	// The worker paints CAPPED pixels black; before blitting, overwrite them with the
	// provisional heat so each tile lands already-developed (not black) as it arrives —
	// the range grows across tiles, then finalizeColors snaps it to the clipped global
	// range for a consistent frame once the whole pass lands.
	private applyTile(m: DoneMsg): void {
		const mu = new Float32Array(m.mu!), de = new Float32Array(m.de!);
		let mx = this.muMax;   // grow the live deepest-escaper as tiles land
		for (let p = 0; p < mu.length; p++) { const v = mu[p]; if (v > mx && isFinite(v)) mx = v; }
		this.muMax = mx;
		if (this.provOn) {
			this.updateProvRange(mu, de);
			const buf = new Uint32Array(m.buf!);
			for (let p = 0; p < mu.length; p++) if (mu[p] === CAPPED) buf[p] = this.provColor(de[p]);
		}
		ctx.putImageData(new ImageData(new Uint8ClampedArray(m.buf!), m.tw, m.th), m.ox, m.oy);
		this.storeField(m.ox, m.oy, m.tw, m.th, mu, de);
	}

	// Sharpening result: only the tile's capped points were re-iterated (mu/de packed,
	// aligned to idx). Update those field cells, recolor the ones that just resolved
	// (leave still-capped pixels black), and tick the live working count down by how
	// many resolved. Repaints only the changed pixels via a per-tile getImageData/
	// putImageData, so already-resolved neighbours keep the SSAA from the full render.
	private applySharpen(m: DoneMsg): void {
		const W = canvas.width, idx = m.idx!, mu = new Float32Array(m.mu!), de = new Float32Array(m.de!);
		const img = ctx.getImageData(m.ox, m.oy, m.tw, m.th);
		const data32 = new Uint32Array(img.data.buffer);
		let resolved = 0;
		for (let k = 0; k < idx.length; k++) {
			const p = idx[k], gpos = (m.oy + ((p / m.tw) | 0)) * W + m.ox + (p % m.tw);
			const val = mu[k];
			this.muField[gpos] = val; this.deField[gpos] = de[k];
			if (val !== CAPPED) {
				data32[p] = this.pixelColor(val, de[k]); resolved++;   // resolved -> recolor
				if (isFinite(val) && val > this.muMax) this.muMax = val;
			}
		}
		if (resolved > 0) ctx.putImageData(img, m.ox, m.oy);
		if (this.onProgress) {   // live countdown: working shrinks by however many resolved
			this.workingLive -= resolved;
			const now = performance.now();
			if (now - this.lastEmit > 40) {
				this.lastEmit = now;
				this.onProgress({ working: this.workingLive, abandoned: 0, sharpening: true, done: false, phase: "refining" });
				this.emitStats(false);
			}
		}
	}

	// Background SSAA result: the tile's edge pixels were supersampled into averaged colors
	// (packed, aligned to idx). Blit just those pixels — the field (mu/de) is unchanged, this
	// only anti-aliases the already-resolved display. Per-tile getImageData/putImageData so
	// untouched pixels keep their colour.
	private applySSAA(m: DoneMsg): void {
		const idx = m.idx!, col = new Uint32Array(m.col!);
		const img = ctx.getImageData(m.ox, m.oy, m.tw, m.th);
		const data32 = new Uint32Array(img.data.buffer);
		for (let k = 0; k < idx.length; k++) data32[idx[k]] = col[k];
		ctx.putImageData(img, m.ox, m.oy);
	}

	// Color one field sample (repaints a sharpened pixel) via the shared colorSample —
	// the same function colorizeField and the worker use, so they can't diverge.
	private pixelColor(m: number, deVal: number): number {
		return colorSample(m, deVal, this.lut, this.inSet, this.mode, this.wrap, this.densityMul,
			this.view.spanX / canvas.width, this.bandMap, this.muLo, this.muHi);
	}

	// Copy a tile's (mu, deDist) field into the persistent full-canvas buffers.
	private storeField(ox: number, oy: number, tw: number, th: number, mu: Float32Array, de: Float32Array): void {
		const W = canvas.width;
		for (let r = 0; r < th; r++) {
			const dst = (oy + r) * W + ox, src = r * tw;
			this.muField.set(mu.subarray(src, src + tw), dst);
			this.deField.set(de.subarray(src, src + tw), dst);
		}
	}

	private renderSync(): void {
		const W = canvas.width, H = canvas.height;
		const image = ctx.getImageData(0, 0, W, H);
		const data32 = new Uint32Array(image.data.buffer);
		periodOn = this.usePeriod;
		periodEps2 = this.periodEps2;
		useDD = this.useDD;
		bandMap = this.bandMap;
		usePert = this.usePert;
		pertRhoThresh = this.pertRhoThresh;
		provOn = false;   // paint CAPPED black in the blocking pass; finalizeColors levels + recolors the underlay
		ssaaOn = true;    // no-worker fallback renders crisp (with SSAA) in one blocking pass; no background AA pass
		if (usePert) computeRef(this.view, this.maxIters);
		iterAcc = 0; escAcc = 0; inAcc = 0; perAcc = 0; capAcc = 0;
		renderRegion(
			data32, this.muField, this.deField, W, 0, 0, W, H, W, H, this.view, this.maxIters,
			this.lut, this.inSet, this.densityMul, this.wrap, this.mode,
		);
		ctx.putImageData(image, 0, 0);
		this.genStats = { iters: iterAcc, esc: escAcc, ins: inAcc, per: perAcc, cap: capAcc };
		this.onGenerationComplete(); // auto-level + report on the no-workers path too
	}
}