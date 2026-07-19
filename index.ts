// MandelJS — a from-scratch Mandelbrot explorer.
//
// Compute is split into a pure, allocation-free kernel (`escapeSmooth`) and a
// region primitive (`renderRegion`) that fills an arbitrary rectangle. A pool
// of Web Workers drives that primitive over tiles: the main thread only
// dispatches tile jobs and blits results, so long renders never block the UI.
//
// The worker is built at runtime by stringifying the very same kernel +
// primitive into a Blob — one definition, shared by the workers and the
// synchronous fallback, with no second file to ship. Tile pixels come back as
// transferable buffers (no SharedArrayBuffer, so no cross-origin-isolation
// headers), painted progressively, and every job carries a generation id so a
// re-zoom abandons stale in-flight tiles instantly.

const easel = document.querySelector(".easel") as HTMLDivElement;
const canvas = document.querySelector(".fractal") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// Debug instrumentation toggle (URL: ?debug=1). Off by default so the production
// console stays quiet; on, every completed render logs timing + iteration counts.
const DEBUG = new URLSearchParams(location.search).has("debug");

//---------------------------------------------------------------------------\\
// Orchestration
//---------------------------------------------------------------------------\\

const renderer = new FractalRenderer(currentPalette);

// View <-> URL. The address bar always reflects the current view (?cx&cy&span),
// so any zoom is a permalink: copy it, or reload it verbatim to reproduce the
// exact same view — essential for apples-to-apples before/after benchmarks.
let CANVAS_ASPECT = canvas.width / canvas.height;   // live: the aspect selector updates it (V5)
function viewFromUrl(): View | null {
	const p = new URLSearchParams(location.search);
	const cx = parseFloat(p.get("cx") || ""), cy = parseFloat(p.get("cy") || ""), span = parseFloat(p.get("span") || "");
	const cxLo = parseFloat(p.get("cxl") || "0"), cyLo = parseFloat(p.get("cyl") || "0");   // DD center lo-limbs (0 if absent)
	if (!isFinite(cx) || !isFinite(cy) || !isFinite(span) || span <= 0) return null;
	return { cx, cxLo: isFinite(cxLo) ? cxLo : 0, cy, cyLo: isFinite(cyLo) ? cyLo : 0, spanX: span, spanY: span / CANVAS_ASPECT };
}
// True while a Julia set is on screen. The URL currently carries only the VIEW (cx/cy/span), not the
// formula/set-type/seed (the permalink for those is deferred). So a Julia's z-space view must NOT be
// written to the URL — otherwise a refresh re-applies that view (centered at the z-origin) to the default
// z²+c Mandelbrot, landing it at the origin instead of its usual center. Gating syncUrl on Mandelbrot mode
// keeps the URL a valid Mandelbrot permalink at all times; a refresh mid-Julia returns to the last M-view.
let inJulia = false;
function syncUrl(v: View): void {
	if (inJulia) return;   // don't let a Julia z-view pollute the (Mandelbrot-only) URL
	const p = new URLSearchParams(location.search);
	p.set("cx", String(v.cx)); p.set("cy", String(v.cy)); p.set("span", String(v.spanX));
	// DD center lo-limbs, only when nonzero (deep views) so shallow permalinks stay clean. Each limb is an
	// f64 and String()↔parseFloat round-trips it EXACTLY, so cx+cxLo reconstructs the DD center bit-for-bit.
	if (v.cxLo !== 0) p.set("cxl", String(v.cxLo)); else p.delete("cxl");
	if (v.cyLo !== 0) p.set("cyl", String(v.cyLo)); else p.delete("cyl");
	history.replaceState(null, "", "?" + p.toString());
}

let view: View = viewFromUrl() || { ...DEFAULT_VIEW };
syncUrl(view);

// High-precision (double-double) badge: lit when a view is deep enough to switch to DD.
// Wired BEFORE the first render — onPrecision fires inside render(), so a later hookup
// would miss the initial (URL) frame, which is exactly when a deep permalink loads in DD.
const precisionStatus = document.querySelector(".precision-status") as HTMLElement | null;
if (precisionStatus) {
	renderer.onPrecision = (bits) => {
		precisionStatus.textContent = bits + "-bit";
		precisionStatus.classList.toggle("is-elevated", bits > 64);   // amber/prominent past f64
	};
}

// Heuristic-map flag: shows "parameter map" when a "Mandelbrot" is really a z₀=c heuristic (a formula
// with no z₀=0 set, e.g. z²+c/z), hidden for true M-sets and Julia. Wired before the first render.
const mapNote = document.querySelector(".map-note") as HTMLElement | null;
if (mapNote) {
	renderer.onMapMode = (heuristic) => { mapNote.textContent = heuristic ? "parameter map" : ""; mapNote.classList.toggle("is-shown", heuristic); };
}

renderer.render(view);

// Benchmark helper (console): re-render the current view n times and report the
// timing spread plus the (deterministic) iteration total. Run it at a fixed URL
// view to compare an optimization before/after — median ms is the number to
// trust; iters is noise-free. e.g.  await mandelBench(9)
const dev = window as unknown as {
	mandelBench: (n?: number) => Promise<unknown>;
	mandelPeriod: (on?: boolean) => void;
	mandelSharpen: (on?: boolean) => void;
	mandelBand: (n?: number) => void;
	mandelDD: (on?: boolean | null) => void;
	mandelPert: (on?: boolean | null) => void;
	mandelProv: (on?: boolean) => void;
	tierazon: (opts?: { rings?: boolean; dStrands?: number; dFactor?: number }) => void;
	tierazonExposure: (dFactor: number) => void;
	juliaHere: () => void;
	filterHere: (dFactor?: number) => void;
};

dev.mandelBench = async (n = 9) => {
	renderer.setSharpen(false); // measure the initial-frame path only, no idle passes
	const runs: number[] = [];
	let stats: GenStats = { iters: 0, esc: 0, ins: 0, per: 0, cap: 0 }, maxIters = 0;
	for (let i = 0; i < n; i++) {
		const r = await renderer.renderAndWait(view);
		runs.push(r.ms); stats = r.stats; maxIters = r.maxIters; // stats are deterministic; keep the last
	}
	runs.sort((a, b) => a - b);
	const min = runs[0], median = runs[n >> 1], mean = runs.reduce((a, b) => a + b, 0) / n;
	const px = canvas.width * canvas.height;
	const pts = stats.esc + stats.ins + stats.per + stats.cap || 1;
	const cappedIterPct = stats.iters ? (100 * stats.cap * maxIters / stats.iters) : 0;
	console.log(
		"[bench] n=" + n + " @ zoom " + (DEFAULT_VIEW.spanX / view.spanX).toExponential(2) + "x · median " +
		median.toFixed(1) + " ms (min " + min.toFixed(1) + ", mean " + mean.toFixed(1) + ") · " +
		(stats.iters / 1e6).toFixed(2) + "M iters (" + (stats.iters / px).toFixed(0) + "/px) · " +
		(100 * stats.per / pts).toFixed(0) + "% period / " + (100 * stats.cap / pts).toFixed(0) +
		"% capped, burns " + cappedIterPct.toFixed(0) + "% of iters",
	);
	renderer.setSharpen(true);
	return { min, median, mean, stats, cappedIterPct };
};

// Toggle periodicity checking for A/B benchmarking. e.g.
//   mandelPeriod(false); await mandelBench(9);  mandelPeriod(true); await mandelBench(9)
dev.mandelPeriod = (on = true) => { renderer.setPeriod(on); console.log("periodicity " + (on ? "ON" : "OFF")); };

// Toggle progressive sharpening (idle re-iteration of undetermined points). e.g.
//   mandelSharpen(false)  // freeze at the initial frame
dev.mandelSharpen = (on = true) => { renderer.setSharpen(on); console.log("sharpening " + (on ? "ON" : "OFF")); };

// Switch the escape-time band transfer for A/B. 0 linear, 1 sqrt, 2 log. e.g. mandelBand(1)
dev.mandelBand = (n = 0) => { renderer.setBandMap(n); console.log("band map = " + (["linear", "sqrt", "log"][n] || n)); };

// Force double-double precision for A/B on the wall window (null = auto-gate by zoom).
//   mandelDD(false); await mandelBench(9);  mandelDD(true); await mandelBench(9);  mandelDD(null)
dev.mandelDD = (on = true) => {
	renderer.setDD(on);
	console.log("DD precision " + (on === null ? "AUTO (zoom-gated)" : on ? "forced ON" : "forced OFF"));
	renderer.render(view);
};

// Force the perturbation fast path for A/B at a deep window (null = follow the DD gate).
//   mandelPert(false); await mandelBench(9);  mandelPert(true); await mandelBench(9);  mandelPert(null)
dev.mandelPert = (on = true) => {
	renderer.setPert(on);
	console.log("perturbation " + (on === null ? "AUTO (follows DD gate)" : on ? "forced ON" : "forced OFF"));
	renderer.render(view);
};

// Toggle provisional CAPPED coloring for A/B — the developing paper→ink underlay vs the old
// all-black first frame. Recolors instantly from the stored field (no re-iterate); pair with
// mandelSharpen(false) to freeze an all-CAPPED frame and flip it. e.g. mandelProv(false)
dev.mandelProv = (on = true) => { renderer.setProv(on); console.log("provisional coloring " + (on ? "ON" : "OFF")); };

// Custom-formula preview (the "Tierazon" repro): a Julia set of z ← (z²+c)·sin(z^(c·i)) with the
// seed and window from tierazon-basic-repro.md, f64. NOT wired into the UI yet — a console hook to
// eyeball the shape. The cap is left to the normal probe-cap + idle-sharpening machinery (more
// accurate than the old program's fixed cap). The target window is 4:3, so the canvas is resized to
// 4:3 (square pixels → undistorted); reload to return to the normal 2:1 Mandelbrot explorer. e.g. tierazon()
dev.tierazon = (opts?: { rings?: boolean; dStrands?: number; dFactor?: number }) => {
	const W = 640, H = 480;   // 4:3, matching the target window's aspect (square pixels, no stretch)
	canvas.width = W; canvas.height = H;
	easel.style.height = H + "px";
	const overlay = easel.querySelectorAll("canvas")[1] as HTMLCanvasElement | undefined;
	if (overlay) { overlay.width = W; overlay.height = H; }   // keep the selector overlay in sync
	// Window + seed straight from the brief.
	const XMIN = -0.1499053515515627, XMAX = 1.188366179688075;
	const YMIN = 0.2655855689131403, YMAX = 1.269289217342869;
	view = { cx: (XMIN + XMAX) / 2, cxLo: 0, cy: (YMIN + YMAX) / 2, cyLo: 0, spanX: XMAX - XMIN, spanY: YMAX - YMIN };
	const ct = compileFormula("(z^2 + c) * sin(z^(c*i))");   // the old Cthulu formula, now via the compiler
	if (ct.ok && ct.body) renderer.setCustomFormula(ct.body);
	renderer.setSetType(true, 0.4206477290564087, 0.5647650444593624);   // Julia, the brief's seed
	if (opts && opts.rings) {
		const dStrands = opts.dStrands ?? 0.08, dFactor = opts.dFactor ?? 4;
		renderer.setFilter(1, dStrands, dFactor);
		renderer.render(view, 128);
		console.log("tierazon x-ray rings: dStrands=" + dStrands + ", dFactor=" + dFactor + " · tierazonExposure(n) to tune · reload to reset");
	} else {
		renderer.setFilter(0);   // escape-time coloring
		renderer.render(view);
		console.log("tierazon: Cthulu Julia, escape-time, window 4:3 · tierazon({rings:true}) for the x-ray filter · reload to reset");
	}
};

// Tune the x-ray filter exposure by eye — instant recolor from the stored accumulators (no re-iterate).
dev.tierazonExposure = (dFactor) => { renderer.setFilterExposure(dFactor); console.log("filter exposure dFactor=" + dFactor); };

// z²+c JULIA seeded from the current view CENTER — tests the Julia path through Kernel 2. e.g. juliaHere()
dev.juliaHere = () => {
	renderer.setFormula(FORMULA_MANDEL);
	renderer.setSetType(true, view.cx, view.cy);   // Julia @ current center
	renderer.setFilter(0);
	const seed = view;
	view = { cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 4 / (canvas.width / canvas.height) };   // default z-window
	renderer.render(view);
	console.log("z²+c Julia @ c = " + seed.cx.toFixed(6) + " + " + seed.cy.toFixed(6) + "i · reload to reset");
};

// Apply the x-ray filter to the CURRENT fractal (default z²+c Mandelbrot) — tests filters on M-sets
// (per-pixel trap limit = |c|). e.g. filterHere() or filterHere(6)
dev.filterHere = (dFactor = 4) => {
	renderer.setFilter(1, 0.08, dFactor);
	renderer.render(view);
	console.log("x-ray rings on the current fractal, dFactor=" + dFactor + " · tierazonExposure(n) to tune · reload to reset");
};

// Progressive readout (optional element): the current render phase plus the live undetermined-point
// split — `working` (still being iterated) and `abandoned` (given up on once escalation stops).
// The leading dot pulses while the workers are busy (any non-done phase) and turns green when
// settled. Phase: first frame → refining → anti-aliasing → done.
const sharpenStatus = document.querySelector(".sharpen-status") as HTMLElement | null;
if (sharpenStatus) {
	renderer.onProgress = ({ working, abandoned, done, phase, etaMs }) => {
		const parts = [phase];
		// First-frame ETA (conservative estimate; the refinement/AA tail isn't estimated). Shown as a countdown.
		if (phase === "first frame" && etaMs !== undefined && etaMs > 250) parts.push("~" + fmtEta(etaMs) + " left");
		if (working > 0) parts.push(working.toLocaleString() + " working");
		if (abandoned > 0) parts.push(abandoned.toLocaleString() + " abandoned");
		sharpenStatus.textContent = parts.join(" · ");
		sharpenStatus.classList.toggle("is-active", !done);
		sharpenStatus.classList.toggle("is-done", done);
	};
}

// Humanize an ETA in ms: 8400 → "8s", 92000 → "1m 32s".
function fmtEta(ms: number): string {
	const s = Math.ceil(ms / 1000);
	if (s < 60) return s + "s";
	const m = Math.floor(s / 60), rs = s % 60;
	return m + "m" + (rs ? " " + rs + "s" : "");
}

// Telemetry grid (optional element): a cell per stat, updated live as tiles land. Cells are keyed
// by a data-k attribute so the markup and the updater stay decoupled.
const telemetry = document.querySelector(".telemetry") as HTMLElement | null;
const teleCells: Record<string, HTMLElement> = {};
if (telemetry) {
	telemetry.querySelectorAll<HTMLElement>(".tstat").forEach((el) => {
		const k = el.dataset.k, v = el.querySelector<HTMLElement>(".tstat-v");
		if (k && v) teleCells[k] = v;
	});
	renderer.onStats = (s) => updateTelemetry(s);
}
function setCell(k: string, text: string): void { const el = teleCells[k]; if (el) el.textContent = text; }
// Set by updateContextualControls: a filter recolors by orbit-trap accumulation, so the escape-time
// telemetry (composition = trapped/miss, deepest/dwell = meaningless) is relabelled/blanked (V7).
const filterState = { active: false };

function updateTelemetry(s: FrameStats): void {
	setCell("zoom", fmtMag(s.zoom));
	setCell("precision", s.bits + "-bit");
	setCell("deepest", filterState.active ? "—" : fmtCount(s.deepest) + " iters" + (s.done ? "" : " …"));
	setCell("throughput", s.itersPerSec > 0 ? fmtCount(Math.round(s.itersPerSec)) + " iters/s" : "—");
	setCell("composition", compText(s));
	setCell("method", methodText(s));
	setCell("thresholds", !filterState.active && s.p50 > 0 ? "p50 " + fmtCount(Math.round(s.p50)) + " · p90 " + fmtCount(Math.round(s.p90)) : "—");
}

// Composition — status partition of every pixel (sums to 100), one slice per line (the cell's value
// uses white-space: pre-line). In filter mode the partition is trapped/miss (the orbit touched the trap
// or not); in escape-time it's exterior/interior/unresolved. FrameStats carries trapped→escaped, miss→inSet.
function compText(s: FrameStats): string {
	const t = s.escaped + s.inSet + s.capped;
	if (t <= 0) return "—";
	if (filterState.active) return [fmtPct(s.escaped, t) + "% trapped", fmtPct(s.inSet, t) + "% miss"].join("\n");
	const parts = [fmtPct(s.escaped, t) + "% exterior", fmtPct(s.inSet, t) + "% interior"];
	if (s.capped > 0) parts.push(fmtPct(s.capped, t) + "% unresolved");
	return parts.join("\n");
}

// Method — compute-path partition of the EXTERIOR pixels only. Nonzero buckets, so a shallow window
// reads "100% direct f64" and a deep one "99% perturbation · 1% exact DD".
function methodText(s: FrameStats): string {
	const t = s.xPert + s.xDD + s.xDirect;
	if (t <= 0) return "—";
	const parts: string[] = [];
	if (s.xPert > 0) parts.push(fmtPct(s.xPert, t) + "% perturbation");
	if (s.xDD > 0) parts.push(fmtPct(s.xDD, t) + "% exact DD");
	if (s.xDirect > 0) parts.push(fmtPct(s.xDirect, t) + "% direct f64");
	return parts.join(" · ");
}

function fmtPct(n: number, total: number): string {
	const p = 100 * n / total;
	if (p >= 99.95) return "100";
	if (p > 0 && p < 0.05) return "<0.1";
	return p.toFixed(1);
}

// Humanize a large count: 6_800_000 → "6.8M", 78_157 → "78k", 890 → "890".
function fmtCount(n: number): string {
	if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
	if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
	if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
	return String(n | 0);
}

// Magnification vs the default view: humanized (1.3M×, 1.8T×) through 10¹⁵, then scientific with a
// superscript exponent for the truly deep dives where the friendly names run out.
const SUPS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
function fmtMag(z: number): string {
	if (z < 1e3) return (z >= 100 ? String(Math.round(z)) : z.toFixed(1)) + "×";
	if (z < 1e15) return fmtCount(Math.round(z)) + "×";
	const [m, e] = z.toExponential(1).split("e");
	const exp = String(Math.abs(parseInt(e, 10))).replace(/./g, (d) => SUPS[+d]);
	return m + "×10" + exp;
}

// Recolor on light/dark flip (matters for the theme-aware subtle palette).
const themeMq = matchMedia("(prefers-color-scheme: dark)");
if (themeMq.addEventListener) themeMq.addEventListener("change", () => renderer.recolor());

//---------------------------------------------------------------------------\\
// Interactivity — a zoom selector you draw, nudge, and resize
//---------------------------------------------------------------------------\\
//
// The overlay canvas carries a single, optional selection rect, aspect-locked to
// the view so a dive never distorts. Drag empty space to draw one; drag inside
// it to move it; scroll over it to resize about its center; a single click
// outside dismisses it. Nothing commits implicitly — the zoom button reads the
// current selection — so a dive is always deliberate.

type SelRect = { x: number; y: number; w: number; h: number };

const DRAG_SLOP = 4;      // px of motion before a press counts as a drag (vs a click)
const SEL_MIN_H = 10;     // smallest selection height worth keeping
const WHEEL_STEP = 1.12;  // per-notch resize factor

class ZoomSelector {
	private overlay: HTMLCanvasElement;
	private octx: CanvasRenderingContext2D;
	private aspect: number;

	private rect: SelRect | null = null;
	private mode: "none" | "draw" | "move" = "none";
	private moved = false;
	private downPt: [number, number] = [0, 0];   // press origin (click-vs-drag test)
	private anchor: [number, number] = [0, 0];    // draw: the fixed corner
	private grab: [number, number] = [0, 0];      // move: cursor offset within the box

	// Fires whenever the selection appears or clears, so the zoom button can enable/disable.
	public onChange: (() => void) | null = null;

	public constructor(base: HTMLCanvasElement) {
		this.aspect = base.width / base.height;
		this.overlay = document.createElement("canvas");
		this.overlay.width = base.width;
		this.overlay.height = base.height;
		this.overlay.style.cursor = "crosshair";
		easel.appendChild(this.overlay);
		this.octx = this.overlay.getContext("2d")!;

		this.overlay.addEventListener("mousedown", this.onDown);
		// move/up on window so a drag that leaves the canvas keeps tracking and still releases.
		window.addEventListener("mousemove", this.onMove);
		window.addEventListener("mouseup", this.onUp);
		this.overlay.addEventListener("wheel", this.onWheel, { passive: false });
	}

	private local(ev: MouseEvent): [number, number] {
		const b = this.overlay.getBoundingClientRect();
		return [ev.clientX - b.left, ev.clientY - b.top];
	}

	private inside(p: [number, number]): boolean {
		const r = this.rect;
		return !!r && p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
	}

	private onDown = (ev: MouseEvent): void => {
		const p = this.local(ev);
		this.downPt = p;
		this.moved = false;
		if (this.inside(p)) {
			this.mode = "move";
			this.grab = [p[0] - this.rect!.x, p[1] - this.rect!.y];
		} else {
			this.mode = "draw";
			this.anchor = p;
		}
	};

	private onMove = (ev: MouseEvent): void => {
		const p = this.local(ev);
		if (this.mode === "none") {
			this.overlay.style.cursor = this.inside(p) ? "move" : "crosshair";
			return;
		}
		if (!this.moved && Math.hypot(p[0] - this.downPt[0], p[1] - this.downPt[1]) > DRAG_SLOP) this.moved = true;
		if (this.mode === "draw") {
			this.overlay.style.cursor = "crosshair";
			if (this.moved) this.setRect(this.clampSize(this.drawRect(p)));
		} else {
			this.overlay.style.cursor = "move";
			if (this.moved) this.setRect(this.clampMove(p[0] - this.grab[0], p[1] - this.grab[1]));
		}
	};

	private onUp = (ev: MouseEvent): void => {
		if (this.mode === "none") return;
		const wasDraw = this.mode === "draw";
		const moved = this.moved;
		this.mode = "none";
		// A click on empty space (draw, no drag) dismisses; a drag too small to matter is discarded.
		// A press inside the box that didn't move keeps the selection.
		if (wasDraw && (!moved || !this.rect || this.rect.h < SEL_MIN_H)) this.clear();
		const p = this.local(ev);
		this.overlay.style.cursor = this.inside(p) ? "move" : "crosshair";
	};

	// Scroll over the box → resize about its center, aspect locked. Over empty space (or with no
	// box) we don't preventDefault, so the page scrolls as usual.
	private onWheel = (ev: WheelEvent): void => {
		if (!this.rect || !this.inside(this.local(ev))) return;
		ev.preventDefault();
		const r = this.rect;
		const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
		const f = ev.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP;   // scroll up = tighter selection
		this.setRect(this.clampSize({ x: cx - r.w * f / 2, y: cy - r.h * f / 2, w: r.w * f, h: r.h * f }, cx, cy));
	};

	// Aspect-locked rect from the fixed anchor to the cursor: size follows whichever axis was dragged
	// further, direction follows the drag, so the box always encloses the cursor.
	private drawRect(p: [number, number]): SelRect {
		const dx = p[0] - this.anchor[0], dy = p[1] - this.anchor[1];
		const w = Math.max(Math.abs(dx), Math.abs(dy) * this.aspect);
		const h = w / this.aspect;
		return { x: dx >= 0 ? this.anchor[0] : this.anchor[0] - w, y: dy >= 0 ? this.anchor[1] : this.anchor[1] - h, w, h };
	}

	// Clamp a rect to the canvas: cap the size to the frame (aspect preserved), then keep it fully
	// on-canvas. When re-centering (resize) the given center is held; otherwise the origin is nudged in.
	private clampSize(r: SelRect, cx?: number, cy?: number): SelRect {
		const W = this.overlay.width, H = this.overlay.height;
		let { w, h } = r;
		const minW = SEL_MIN_H * this.aspect;
		w = Math.min(Math.max(w, minW), W);
		h = w / this.aspect;
		if (h > H) { h = H; w = H * this.aspect; }
		let x = cx !== undefined ? cx - w / 2 : r.x;
		let y = cy !== undefined ? cy - h / 2 : r.y;
		x = Math.min(Math.max(x, 0), W - w);
		y = Math.min(Math.max(y, 0), H - h);
		return { x, y, w, h };
	}

	private clampMove(x: number, y: number): SelRect {
		const r = this.rect!, W = this.overlay.width, H = this.overlay.height;
		return { x: Math.min(Math.max(x, 0), W - r.w), y: Math.min(Math.max(y, 0), H - r.h), w: r.w, h: r.h };
	}

	private setRect(r: SelRect | null): void {
		this.rect = r;
		this.redraw();
		if (this.onChange) this.onChange();
	}

	private redraw(): void {
		const c = this.octx, W = this.overlay.width, H = this.overlay.height;
		c.clearRect(0, 0, W, H);
		const r = this.rect;
		if (!r) return;
		c.fillStyle = "rgba(76, 110, 245, 0.10)";
		c.fillRect(r.x, r.y, r.w, r.h);
		// Stroke twice so the edge reads on any background: a dark halo, bright dashes on top.
		c.setLineDash([]);
		c.lineWidth = 3;
		c.strokeStyle = "rgba(0, 0, 0, 0.55)";
		c.strokeRect(r.x, r.y, r.w, r.h);
		c.setLineDash([5, 4]);
		c.lineWidth = 1;
		c.strokeStyle = "rgba(255, 255, 255, 0.95)";
		c.strokeRect(r.x, r.y, r.w, r.h);
	}

	// The committed selection as [x, y, w, h], or undefined if none / too small to be intentional.
	public getRect(): [number, number, number, number] | undefined {
		const r = this.rect;
		if (!r || r.h < SEL_MIN_H) return undefined;
		return [r.x, r.y, r.w, r.h];
	}

	public hasSelection(): boolean { return !!this.rect; }

	public clear(): void { this.setRect(null); }
}

const selector = new ZoomSelector(canvas);

const zoomButton = document.querySelector(".zoom-button") as HTMLButtonElement;
const backButton = document.querySelector(".back-button") as HTMLButtonElement | null;
const outButton = document.querySelector(".out-button") as HTMLButtonElement | null;
const resetButton = document.querySelector(".reset-button") as HTMLButtonElement;

// View history for exact zoom-out. Each dive/out/reset pushes the outgoing view; back pops it.
// Kept separate from the URL (which only mirrors the current view) so stepping back restores the
// DD center lo-limbs bit-for-bit — no precision loss on the way out.
const viewHistory: View[] = [];
function pushHistory(v: View): void {
	viewHistory.push(v);
	if (backButton) backButton.disabled = false;
}

// Navigate to a view: swap it in, mirror to the URL, render, and drop any selection.
function goTo(next: View): void {
	view = next;
	syncUrl(view);
	// Show the new magnification immediately and blank the rest to a dash — the figures fill back in
	// as the first tiles land, so the grid never lingers on the previous frame's numbers.
	if (telemetry) {
		setCell("zoom", fmtMag(DEFAULT_VIEW.spanX / next.spanX));
		for (const k of ["deepest", "throughput", "composition", "method", "thresholds"]) setCell(k, "…");
	}
	renderer.render(view);
	selector.clear();
}

// ---- V6: Mandelbrot ↔ Julia toggle. The M-view (c-space) and J-view (z-space) are independent
// coordinate systems, so we snapshot each mode's {view, history} and swap. The J bundle is keyed on its
// seed: re-entering Julia from the SAME center restores your exploration; a moved center → fresh J. ----
let mBundle: { view: View; history: View[] } | null = null;                  // saved Mandelbrot state while in Julia
let jBundle: { seed: number; view: View; history: View[] } | null = null;    // cached Julia state (seed = f64 key)

function snapshotHistory(): View[] { return viewHistory.slice(); }
function setHistory(h: View[]): void {
	viewHistory.length = 0;
	for (const v of h) viewHistory.push(v);
	if (backButton) backButton.disabled = viewHistory.length === 0;
}
function defaultJuliaView(): View {
	return { cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 4 / CANVAS_ASPECT };   // origin, |z| < 2, aspect-matched
}

// The formula dropdown, as data. Key = the <option> value. "0" is the standard z²+c (Kernel 1 fast path,
// no compiled formula). "custom" is the editable field. Every other entry is a formula STRING compiled
// through the same path as custom (compileFormula → setCustomFormula) — adding a preset is just a row.
// Each may carry its own default window: `center` (else origin, or cx=-1 for the standard) and `spanX`.
interface Preset { formula?: string; center?: { cx: number; cy: number }; spanX?: number; }
const PRESETS: { [key: string]: Preset } = {
	"0": {},                                                                   // z²+c → Kernel 1; classic cx=-1 framing
	"cubic": { formula: "z^3 + c" },                                           // cubic Multibrot, origin
	"ship": { formula: "(abs(re(z)) + abs(im(z))*i)^2 + c", center: { cx: -0.5, cy: -0.5 }, spanX: 3.4 },   // Burning Ship
	"cosine": { formula: "c*cos(z)" },                                         // cosine map, origin
	"custom": {},                                                              // editable; origin
};

// The default window for the current mode + formula (reset target; also where a formula switch lands).
// Julia always centers on the origin. In Mandelbrot mode each preset supplies its own framing (PRESETS):
// the standard z²+c keeps the classic cx=-1, everything else defaults to the origin unless it overrides.
function defaultViewFor(): View {
	if (inJulia) return defaultJuliaView();
	const key = formulaSelect ? formulaSelect.value : "0";
	const p = PRESETS[key] || {};
	const cx = p.center ? p.center.cx : (key === "0" ? DEFAULT_VIEW.cx : 0);
	const cy = p.center ? p.center.cy : 0;
	const spanX = p.spanX || DEFAULT_VIEW.spanX;
	return { ...DEFAULT_VIEW, cx, cy, spanX, spanY: spanX / CANVAS_ASPECT };
}
function seedKey(cx: number, cy: number): number { return cx * 1e7 + cy; }   // cheap equality key for the seed

function enterJulia(): void {
	inJulia = true;   // stop the URL tracking the z-space view (see syncUrl)
	const scx = view.cx + view.cxLo, scy = view.cy + view.cyLo;   // seed = DD center collapsed to f64
	mBundle = { view, history: snapshotHistory() };
	renderer.setSetType(true, scx, scy);
	const key = seedKey(scx, scy);
	if (jBundle && jBundle.seed === key) { view = jBundle.view; setHistory(jBundle.history); }        // same seed → restore
	else { view = defaultJuliaView(); setHistory([]); jBundle = { seed: key, view, history: [] }; }    // new seed → fresh
	syncUrl(view);
	renderer.render(view);
}
function exitJulia(): void {
	if (jBundle) jBundle = { seed: jBundle.seed, view, history: snapshotHistory() };   // stash the J exploration
	inJulia = false;   // resume URL tracking; the restored M-view syncs below
	renderer.setSetType(false);
	if (mBundle) { view = mBundle.view; setHistory(mBundle.history); }
	syncUrl(view);
	renderer.render(view);
}

// ---- V5: aspect selector. Fixed width, derived height; resize canvas + easel + selector overlay,
// re-derive spanY = spanX/aspect, re-render. CANVAS_ASPECT stays live for later default-view derivations. ----
function setAspect(aspect: number): void {
	const W = 640, H = Math.round(W / aspect);
	canvas.width = W; canvas.height = H;
	easel.style.height = H + "px";
	const overlay = easel.querySelectorAll("canvas")[1] as HTMLCanvasElement | undefined;
	if (overlay) { overlay.width = W; overlay.height = H; }
	CANVAS_ASPECT = aspect;
	view = { ...view, spanY: view.spanX / aspect };
	syncUrl(view);
	renderer.render(view);
}

selector.onChange = () => { zoomButton.disabled = !selector.hasSelection(); };
zoomButton.disabled = true;

zoomButton.addEventListener("click", () => {
	const r = selector.getRect();
	if (!r) return;
	const W = canvas.width, H = canvas.height;
	// Recenter in double-double: newCenter = oldCenter + boxOffset. In f64 the offset is lost once it
	// drops below the center's ULP (~|c|·ε); ddAdd's twoSum keeps it, so the box lands where you drew it.
	const offX = ((r[0] + r[2] / 2) / W - 0.5) * view.spanX;
	const offY = ((r[1] + r[3] / 2) / H - 0.5) * view.spanY;
	ddAdd(view.cx, view.cxLo, offX, 0); const ncx = _dhi, ncxLo = _dlo;
	ddAdd(view.cy, view.cyLo, offY, 0); const ncy = _dhi, ncyLo = _dlo;
	pushHistory(view);
	goTo({
		cx: ncx, cxLo: ncxLo, cy: ncy, cyLo: ncyLo,
		spanX: view.spanX * (r[2] / W),
		spanY: view.spanY * (r[3] / H),
	});
});

if (backButton) {
	backButton.disabled = true;
	backButton.addEventListener("click", () => {
		const prev = viewHistory.pop();
		if (!prev) return;
		backButton.disabled = viewHistory.length === 0;
		goTo(prev);
	});
}

if (outButton) {
	// Step out past history: 2× the span about the current center (kept exactly — only span changes).
	outButton.addEventListener("click", () => {
		pushHistory(view);
		goTo({ ...view, spanX: view.spanX * 2, spanY: view.spanY * 2 });
	});
}

resetButton.addEventListener("click", () => {
	pushHistory(view);
	goTo(defaultViewFor());
});

// Coloring method (optional control) — one dropdown for all four paths: escape-time bands with the
// linear / √ / log transforms, plus distance estimate. Each recolors instantly from the stored field.
const coloringSelect = document.querySelector(".coloring-select") as HTMLSelectElement | null;
if (coloringSelect) {
	coloringSelect.addEventListener("change", () => {
		const v = coloringSelect.value;
		if (v === "distance") renderer.setColoring(1, 0);
		else renderer.setColoring(0, v === "sqrt" ? 1 : v === "log" ? 2 : 0);
	});
}

// Palette instrument — palette picker + density slider. Wrap is no longer user-facing: each palette's
// own default (cyclic) is used (setPalette resets it), so the colorful palettes band and subtle ramps.
const densitySlider = document.querySelector(".density-slider") as HTMLInputElement | null;
if (densitySlider) {
	densitySlider.value = String(currentPalette.density);
	densitySlider.addEventListener("input", () => renderer.setDensity(Number(densitySlider.value)));
}

const paletteSelect = document.querySelector(".palette-select") as HTMLSelectElement | null;
if (paletteSelect) {
	paletteSelect.addEventListener("change", () => {
		const p = PALETTES[paletteSelect.value];
		if (!p) return;
		renderer.setPalette(p);   // resets effective wrap to the palette default (E7)
		if (densitySlider) densitySlider.value = String(p.density);
	});
}

//---------------------------------------------------------------------------\\
// Render-settings controls (V3–V6): formula, Julia toggle + seed, filter + params, aspect. All
// optional (absent on pages without them). Formula/set-type/filter/strands/aspect re-iterate; exposure
// recolors instantly. Kernel selection is derived inside the renderer (deriveKernel).
//---------------------------------------------------------------------------\\

const formulaSelect = document.querySelector(".formula-select") as HTMLSelectElement | null;
const formulaCustom = document.querySelector(".formula-custom") as HTMLElement | null;
const formulaInput = document.querySelector(".formula-input") as HTMLInputElement | null;
const formulaError = document.querySelector(".formula-error") as HTMLElement | null;
const juliaToggle = document.querySelector(".julia-toggle") as HTMLInputElement | null;
const filterSelect = document.querySelector(".filter-select") as HTMLSelectElement | null;
const strandsSlider = document.querySelector(".strands-slider") as HTMLInputElement | null;
const exposureSlider = document.querySelector(".exposure-slider") as HTMLInputElement | null;
const aspectSelect = document.querySelector(".aspect-select") as HTMLSelectElement | null;
const coloringBody = coloringSelect?.closest(".ctrl-section")?.querySelector<HTMLElement>(".ctrl-body") ?? null;

// Reflect the current control state into the renderer + show/hide contextual controls.
function currentFilterId(): number { return filterSelect ? Number(filterSelect.value) : 0; }
function pushFilter(): void {
	renderer.setFilter(currentFilterId(), strandsSlider ? Number(strandsSlider.value) : 0.08, exposureSlider ? Number(exposureSlider.value) : 4);
}
function updateContextualControls(): void {
	const filterOn = currentFilterId() !== 0;
	const customOn = formulaSelect?.value === "custom";
	const k2 = (formulaSelect ? formulaSelect.value !== "0" : false) || !!juliaToggle?.checked || filterOn;
	document.querySelectorAll<HTMLElement>(".filter-param").forEach((el) => el.classList.toggle("hidden", !filterOn));
	formulaCustom?.classList.toggle("hidden", !customOn);   // the f(z,c)= text field appears only for "custom…"
	if (!customOn && formulaError) formulaError.textContent = "";   // clear a stale error when leaving custom
	coloringBody?.classList.toggle("inactive", filterOn);   // escape-time coloring is bypassed by a filter
	// Distance coloring needs Kernel 1's derivative; disable it on Kernel 2 (fall back to log if it was picked).
	const distOpt = coloringSelect?.querySelector<HTMLOptionElement>('option[value="distance"]');
	if (distOpt) distOpt.disabled = k2;
	if (k2 && coloringSelect?.value === "distance") { coloringSelect.value = "log"; renderer.setColoring(0, 2); }
	filterState.active = filterOn;   // telemetry relabels in filter mode (V7)
}

// Show/clear a formula error; empty text hides the pill (see .formula-error:empty in CSS).
function showFormulaError(msg: string): void { if (formulaError) formulaError.textContent = msg; }

// Compile the text field and, if it's valid, install it as the custom formula + re-render. Returns
// whether it compiled. `refsC === false` (a formula that ignores c) makes every Mandelbrot pixel
// identical — surfaced as a non-blocking note rather than an error. The compiler is pure + cheap.
function applyCustomFormula(): boolean {
	if (!formulaInput) return false;
	const res = compileFormula(formulaInput.value);
	if (!res.ok || !res.body) { showFormulaError(res.error || "invalid formula"); return false; }
	showFormulaError(res.refsC === false && !juliaToggle?.checked ? "note: no c — every point is identical" : "");
	renderer.setCustomFormula(res.body);
	updateContextualControls();
	goTo(view);   // render the current view (the dropdown handler resets it to the formula default first)
	return true;
}

if (formulaSelect) {
	formulaSelect.addEventListener("change", () => {
		// A new formula is a new fractal: land on its default window (per-preset center) and drop the old
		// zoom history. Julia keeps its own view/bundle (already origin-centered).
		if (!inJulia) { view = defaultViewFor(); setHistory([]); }
		const key = formulaSelect.value;
		if (key === "custom") {
			updateContextualControls();   // reveal the text field
			applyCustomFormula();         // compile the field + install + render the reset view
			return;
		}
		const preset = PRESETS[key];
		if (preset && preset.formula) {
			const res = compileFormula(preset.formula);   // presets are known-valid, but guard anyway
			if (res.ok && res.body) renderer.setCustomFormula(res.body);
		} else {
			renderer.setFormula(FORMULA_MANDEL);          // "0" → standard z²+c (Kernel 1)
		}
		updateContextualControls();
		goTo(view);
	});
}
if (formulaInput) {
	// Validate live as they type (cheap, no render); apply on Enter or blur (a re-iterate).
	formulaInput.addEventListener("input", () => {
		const res = compileFormula(formulaInput.value);
		showFormulaError(res.ok ? "" : res.error || "invalid formula");
	});
	formulaInput.addEventListener("change", () => applyCustomFormula());
	formulaInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyCustomFormula(); } });
}

if (filterSelect) {
	filterSelect.addEventListener("change", () => { pushFilter(); updateContextualControls(); renderer.render(view); });
}
if (strandsSlider) {   // trap band half-width — re-iterates, so 'change' (on release), not 'input'
	strandsSlider.addEventListener("change", () => { pushFilter(); renderer.render(view); });
}
if (exposureSlider) {   // exposure — instant recolor from the stored accumulators, so live 'input'
	exposureSlider.addEventListener("input", () => renderer.setFilterExposure(Number(exposureSlider.value)));
}
if (aspectSelect) {
	aspectSelect.addEventListener("change", () => setAspect(Number(aspectSelect.value)));
}
if (juliaToggle) {
	juliaToggle.addEventListener("change", () => { if (juliaToggle.checked) enterJulia(); else exitJulia(); });
}
updateContextualControls();   // initial state: filter params hidden (filter = none by default)
