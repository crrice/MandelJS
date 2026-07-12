// renderer.ts — the orchestration layer that runs on the main thread: the Web
// Worker pool (built at runtime by stringifying kernel.ts via buildWorkerSource)
// and the FractalRenderer class driving progressive tiled render, sharpening,
// palette/precision/period scheduling, and recolor. Depends on kernel.ts (compute)
// and palette.ts (LUTs); reads the canvas/ctx handles defined in index.ts.

//---------------------------------------------------------------------------\\
// Worker pool
//---------------------------------------------------------------------------\\

const TILE_SIZE = 32;   // tile edge in px; small enough to load-balance, big
                        // enough that per-tile messaging stays negligible
const WORKER_CAP = 8;   // don't spawn more than this many workers

interface TileMsg {
	type: "tile"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	canvasW: number; canvasH: number; view: View; maxIters: number; densityMul: number; mode: number;
	usePeriod: boolean; periodEps2: number; useDD: boolean; bandMap: number;
	idx?: Int32Array;   // present => sharpen job: re-iterate only these capped tile-local pixels
}
interface DoneMsg {
	type: "done"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	iters: number; esc: number; ins: number; per: number; cap: number;
	mu: ArrayBuffer; de: ArrayBuffer;
	buf?: ArrayBuffer;   // full-tile pixels (absent for sharpen results)
	idx?: Int32Array;    // sharpen results: mu/de are packed per-capped-point, aligned to idx
}

// Per-generation instrumentation: total iterations + outcome tallies.
interface GenStats { iters: number; esc: number; ins: number; per: number; cap: number; }

// A unit of render work: a tile rectangle. With `idx` (capped tile-local pixel
// indices) it's a sharpening job — only those points are re-iterated.
interface TileJob { ox: number; oy: number; tw: number; th: number; idx?: Int32Array; }

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
		"const IN_SET = Infinity;",
			"const CAPPED = -Infinity;",
		"let deDist = 0;",
		"let periodOn = true;",
		"let periodEps2 = " + PERIOD_EPS2 + ";",   // zoom-scaled, set per tile
		"let useDD = false;",                       // deep-view precision, set per tile
		"let _dhi = 0, _dlo = 0;",                  // DD op scratch
		"const DD_SPLIT = " + DD_SPLIT + ";",
		"let bandMap = 0;",
		"let iterAcc = 0, escAcc = 0, inAcc = 0, perAcc = 0, capAcc = 0;",
		escapeSmooth.toString(),
		ddAdd.toString(),
		ddMul.toString(),
		ddSq.toString(),
		escapeSmoothDD.toString(),
		bandTransform.toString(),
		colorSample.toString(),
		renderRegion.toString(),
		sharpenPoints.toString(),
		"let PAL = null;",
		"onmessage = function (e) {",
		"  var m = e.data;",
		"  if (m.type === 'palette') { PAL = m; return; }",
		"  periodOn = m.usePeriod;",
		"  periodEps2 = m.periodEps2;",
		"  useDD = m.useDD;",
		"  bandMap = m.bandMap;",
		"  iterAcc = 0; escAcc = 0; inAcc = 0; perAcc = 0; capAcc = 0;",
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
	// Stored per-pixel fields (1 sample) so coloring can be redone on the main
	// thread instantly, without re-iterating.
	private muField: Float32Array;
	private deField: Float32Array;
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
	public onProgress: ((p: { working: number; abandoned: number; sharpening: boolean; done: boolean }) => void) | null = null;
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
		let mn = Infinity, mx = -Infinity, cnt = 0;
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (isFinite(m)) { cnt++; if (m < mn) mn = m; if (m > mx) mx = m; }
		}
		if (cnt === 0 || mx <= mn) { this.muLo = 0; this.muHi = 1; return; }
		const BINS = 512;
		const hist = new Uint32Array(BINS);
		const scale = (BINS - 1) / (mx - mn);
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (isFinite(m)) hist[((m - mn) * scale) | 0]++;
		}
		const loTarget = cnt * 0.01, hiTarget = cnt * 0.99;
		let acc = 0, loBin = 0, hiBin = BINS - 1;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= loTarget) { loBin = b; break; } }
		acc = 0;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= hiTarget) { hiBin = b; break; } }
		this.muLo = mn + loBin / scale;
		this.muHi = mn + hiBin / scale;
		if (this.muHi <= this.muLo) this.muHi = this.muLo + 1;
	}

	// Called once a render generation fully lands. Refresh the auto-level range
	// (kept current so a later wrap-off switch has it), and for a non-cyclic
	// escape-time view, repaint from the field so the ramp spans the structure —
	// the workers colored progressively with a flat clamp; this snaps it right.
	private finalizeColors(): void {
		this.computeLevels();
		if (!this.wrap && this.mode === 0) this.colorizeField();
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

	// Scan the stored field for still-undetermined (CAPPED) pixels: the total count
	// (for the UI countdown) and the tiles containing any, ordered hardest-first
	// (most capped pixels). That ordering makes the sharpening queue run
	// longest-processing-time-first, which a scheduling sim showed erases the
	// ~19% worker-idle tail a naive row-major order leaves on deep views.
	private scanCapped(): { count: number; tiles: TileJob[] } {
		const W = canvas.width, H = canvas.height, mu = this.muField;
		const tiles: TileJob[] = [];
		let total = 0;
		for (let oy = 0; oy < H; oy += TILE_SIZE) {
			const th = Math.min(TILE_SIZE, H - oy);
			for (let ox = 0; ox < W; ox += TILE_SIZE) {
				const tw = Math.min(TILE_SIZE, W - ox);
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

	// Post-generation hook: refresh the undetermined count, drive the UI, and — if
	// anything is still capped and we haven't reached the target cap — kick the next
	// sharpening stage on the (now idle) pool at a higher cap over just those tiles.
	// A superseding view bumps the generation, so a stage scheduled here is
	// abandoned before it paints if the user has moved on.
	private afterGeneration(): void {
		if (this.workers.length === 0 || !this.sharpenOn) return;
		const prev = this.undetermined;                       // capped count entering this stage
		const { count, tiles } = this.scanCapped();           // capped count after it
		const resolved = this.sharpenStage === 0 ? 0 : prev - count;
		this.undetermined = count;
		const done = this.sharpenDone(count, prev, tiles.length, resolved);
		// While sharpening, the survivors are "working"; once we stop, whatever is
		// still capped becomes "abandoned" — so the working bucket ticks down to 0
		// as points either resolve or get given up on.
		if (this.onProgress) {
			this.onProgress(done
				? { working: 0, abandoned: count, sharpening: false, done: true }
				: { working: count, abandoned: 0, sharpening: true, done: false });
		}
		if (done) return;
		this.sharpenStage++;
		this.workingLive = count;   // entering capped count; onDone ticks it down live per tile
		const nextCap = Math.min(SHARPEN_CEILING, Math.round(this.maxIters * SHARPEN_MULT));
		this.beginGeneration(nextCap, tiles);   // each tile carries its capped-point idx
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
	private itersForView(v: View): number {
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		if (zoom <= 1) return ITER_BASE;
		return Math.min(ITER_CAP, Math.round(ITER_BASE + ITER_SLOPE * Math.log2(zoom)));
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

	public render(view: View, maxIters = this.itersForView(view)): void {
		this.view = view;
		this.densityMul = this.densityMulFor(view);
		this.useDD = this.ddOverride !== null ? this.ddOverride : this.useDDFor(view);
		this.periodEps2 = this.periodEps2For(view, this.useDD);   // DD lets ε tighten further
		if (this.onPrecision) this.onPrecision(this.useDD ? 128 : 64);   // 64×limbs
		this.sharpenStage = 0;
		this.undetermined = 0;
		// Fresh view: clear any leftover sharpening readout until the first frame lands.
		if (this.onProgress) this.onProgress({ working: 0, abandoned: 0, sharpening: false, done: false });

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
		for (let oy = 0; oy < H; oy += TILE_SIZE)
			for (let ox = 0; ox < W; ox += TILE_SIZE)
				tiles.push({ ox, oy, tw: Math.min(TILE_SIZE, W - ox), th: Math.min(TILE_SIZE, H - oy) });
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
			usePeriod: this.usePeriod, periodEps2: this.periodEps2, useDD: this.useDD, bandMap: this.bandMap,
		};
		if (tile.idx) msg.idx = tile.idx;   // sharpen job: only these capped points
		this.workers[i].postMessage(msg);
	}

	private onDone(i: number, m: DoneMsg): void {
		if (m.gen === this.gen) { // drop stale tiles from a superseded view
			if (m.idx) this.applySharpen(m);
			else this.applyTile(m);
			const s = this.genStats;
			s.iters += m.iters; s.esc += m.esc; s.ins += m.ins; s.per += m.per; s.cap += m.cap;
		}
		this.dispatch(i); // keep the worker fed from the current queue
		// Last tile of this generation just landed — finalize + report.
		if (m.gen === this.gen && this.queue.length === 0 && this.idle.every((x) => x)) {
			this.onGenerationComplete();
		}
	}

	// Initial/full render of a tile: blit its pixels and stash its (mu, deDist) field.
	private applyTile(m: DoneMsg): void {
		ctx.putImageData(new ImageData(new Uint8ClampedArray(m.buf!), m.tw, m.th), m.ox, m.oy);
		this.storeField(m.ox, m.oy, m.tw, m.th, new Float32Array(m.mu), new Float32Array(m.de));
	}

	// Sharpening result: only the tile's capped points were re-iterated (mu/de packed,
	// aligned to idx). Update those field cells, recolor the ones that just resolved
	// (leave still-capped pixels black), and tick the live working count down by how
	// many resolved. Repaints only the changed pixels via a per-tile getImageData/
	// putImageData, so already-resolved neighbours keep the SSAA from the full render.
	private applySharpen(m: DoneMsg): void {
		const W = canvas.width, idx = m.idx!, mu = new Float32Array(m.mu), de = new Float32Array(m.de);
		const img = ctx.getImageData(m.ox, m.oy, m.tw, m.th);
		const data32 = new Uint32Array(img.data.buffer);
		let resolved = 0;
		for (let k = 0; k < idx.length; k++) {
			const p = idx[k], gpos = (m.oy + ((p / m.tw) | 0)) * W + m.ox + (p % m.tw);
			const val = mu[k];
			this.muField[gpos] = val; this.deField[gpos] = de[k];
			if (val !== CAPPED) { data32[p] = this.pixelColor(val, de[k]); resolved++; }  // resolved -> recolor
		}
		if (resolved > 0) ctx.putImageData(img, m.ox, m.oy);
		if (this.onProgress) {   // live countdown: working shrinks by however many resolved
			this.workingLive -= resolved;
			const now = performance.now();
			if (now - this.lastEmit > 40) {
				this.lastEmit = now;
				this.onProgress({ working: this.workingLive, abandoned: 0, sharpening: true, done: false });
			}
		}
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