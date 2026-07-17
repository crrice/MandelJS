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
const CANVAS_ASPECT = canvas.width / canvas.height;
function viewFromUrl(): View | null {
	const p = new URLSearchParams(location.search);
	const cx = parseFloat(p.get("cx") || ""), cy = parseFloat(p.get("cy") || ""), span = parseFloat(p.get("span") || "");
	const cxLo = parseFloat(p.get("cxl") || "0"), cyLo = parseFloat(p.get("cyl") || "0");   // DD center lo-limbs (0 if absent)
	if (!isFinite(cx) || !isFinite(cy) || !isFinite(span) || span <= 0) return null;
	return { cx, cxLo: isFinite(cxLo) ? cxLo : 0, cy, cyLo: isFinite(cyLo) ? cyLo : 0, spanX: span, spanY: span / CANVAS_ASPECT };
}
function syncUrl(v: View): void {
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

// Progressive readout (optional element): the current render phase plus the live undetermined-point
// split — `working` (still being iterated) and `abandoned` (given up on once escalation stops).
// The leading dot pulses while the workers are busy (any non-done phase) and turns green when
// settled. Phase: first frame → refining → anti-aliasing → done.
const sharpenStatus = document.querySelector(".sharpen-status") as HTMLElement | null;
if (sharpenStatus) {
	renderer.onProgress = ({ working, abandoned, done, phase }) => {
		const parts = [phase];
		if (working > 0) parts.push(working.toLocaleString() + " working");
		if (abandoned > 0) parts.push(abandoned.toLocaleString() + " abandoned");
		sharpenStatus.textContent = parts.join(" · ");
		sharpenStatus.classList.toggle("is-active", !done);
		sharpenStatus.classList.toggle("is-done", done);
	};
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

function updateTelemetry(s: FrameStats): void {
	setCell("zoom", fmtMag(s.zoom));
	setCell("precision", s.bits + "-bit");
	setCell("deepest", fmtCount(s.deepest) + " iters" + (s.done ? "" : " …"));
	setCell("throughput", s.itersPerSec > 0 ? fmtCount(Math.round(s.itersPerSec)) + " iters/s" : "—");
	setCell("composition", compText(s));
	setCell("method", methodText(s));
	setCell("thresholds", s.p50 > 0 ? "p50 " + fmtCount(Math.round(s.p50)) + " · p90 " + fmtCount(Math.round(s.p90)) : "—");
}

// Composition — status partition of every pixel (sums to 100), one slice per line (the cell's
// value uses white-space: pre-line). Unresolved shown only when nonzero.
function compText(s: FrameStats): string {
	const t = s.escaped + s.inSet + s.capped;
	if (t <= 0) return "—";
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
	goTo({ ...DEFAULT_VIEW });
});

// Coloring-mode toggle (optional control — absent on pages without it).
const modeButton = document.querySelector(".mode-button") as HTMLElement | null;
if (modeButton) {
	const labels = ["escape-time", "distance"];
	let mode = 0;
	const sync = () => { modeButton.textContent = "coloring: " + labels[mode]; };
	sync();
	modeButton.addEventListener("click", () => {
		mode = mode ? 0 : 1;
		renderer.setColorMode(mode);
		sync();
	});
}

// Palette instrument — palette picker, wrap toggle, density slider. All optional
// (absent on pages without them); each recolors instantly from the stored field.
const wrapToggle = document.querySelector(".wrap-toggle") as HTMLInputElement | null;
if (wrapToggle) {
	wrapToggle.checked = currentPalette.cyclic;
	wrapToggle.addEventListener("change", () => renderer.setWrap(wrapToggle.checked));
}

const densitySlider = document.querySelector(".density-slider") as HTMLInputElement | null;
if (densitySlider) {
	densitySlider.value = String(currentPalette.density);
	densitySlider.addEventListener("input", () => renderer.setDensity(Number(densitySlider.value)));
}

// Band transfer selector (escape-time): linear / sqrt / log. sqrt & log give consistent,
// zoom-stable banding; instant recolor from the stored field.
const bandSelect = document.querySelector(".band-select") as HTMLSelectElement | null;
if (bandSelect) {
	bandSelect.addEventListener("change", () => renderer.setBandMap(Number(bandSelect.value)));
}

const paletteSelect = document.querySelector(".palette-select") as HTMLSelectElement | null;
if (paletteSelect) {
	paletteSelect.addEventListener("change", () => {
		const p = PALETTES[paletteSelect.value];
		if (!p) return;
		renderer.setPalette(p);
		// Sync the wrap/density controls to the newly selected palette's defaults.
		if (wrapToggle) wrapToggle.checked = p.cyclic;
		if (densitySlider) densitySlider.value = String(p.density);
	});
}
