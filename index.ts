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
	if (!isFinite(cx) || !isFinite(cy) || !isFinite(span) || span <= 0) return null;
	return { cx, cy, spanX: span, spanY: span / CANVAS_ASPECT };
}
function syncUrl(v: View): void {
	const p = new URLSearchParams(location.search);
	p.set("cx", String(v.cx)); p.set("cy", String(v.cy)); p.set("span", String(v.spanX));
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

// Progressive-sharpening readout (optional element). Splits the undetermined
// points into `working` (still being iterated) and `abandoned` (given up on once
// escalation stops). Appears with the first frame; the working count ticks down
// as points resolve, then drops to 0 as the remainder transfers to abandoned;
// resets on a new view. `is-active` = workers still refining, `is-done` = settled.
const sharpenStatus = document.querySelector(".sharpen-status") as HTMLElement | null;
if (sharpenStatus) {
	renderer.onProgress = ({ working, abandoned, sharpening, done }) => {
		// Always visible for now (even at 0 · 0): the working count ticks down live
		// as points resolve, then transfers to abandoned when escalation stops.
		sharpenStatus.textContent =
			working.toLocaleString() + " working · " + abandoned.toLocaleString() + " abandoned";
		sharpenStatus.classList.toggle("is-active", sharpening);
		sharpenStatus.classList.toggle("is-done", done);
	};
}

// Recolor on light/dark flip (matters for the theme-aware subtle palette).
const themeMq = matchMedia("(prefers-color-scheme: dark)");
if (themeMq.addEventListener) themeMq.addEventListener("change", () => renderer.recolor());

//---------------------------------------------------------------------------\\
// Interactivity — drag a box, hit zoom
//---------------------------------------------------------------------------\\

class CanvasBoxZoomer {
	private overlay: HTMLCanvasElement;
	private octx: CanvasRenderingContext2D;

	private isDown = false;
	private start: [number, number] = [0, 0];
	private end: [number, number] = [0, 0];

	public constructor(base: HTMLCanvasElement) {
		this.overlay = document.createElement("canvas");
		this.overlay.width = base.width;
		this.overlay.height = base.height;
		easel.appendChild(this.overlay);

		this.octx = this.overlay.getContext("2d")!;

		this.overlay.addEventListener("mousedown", this.onMouseDown.bind(this));
		this.overlay.addEventListener("mousemove", this.onMouseMove.bind(this));
		this.overlay.addEventListener("mouseup", this.onMouseUp.bind(this));
	}

	private onMouseDown(ev: MouseEvent): void {
		this.start = [ev.offsetX, ev.offsetY];
		this.end = [ev.offsetX, ev.offsetY];
		this.isDown = true;
	}

	private onMouseMove(ev: MouseEvent): void {
		if (!this.isDown) return;
		this.end = [ev.offsetX, ev.offsetY];
		const r = this.getCurrentRect();
		const c = this.octx;
		c.clearRect(0, 0, this.overlay.width, this.overlay.height);
		if (!r) return;
		// Draw twice so it reads on any background: a dark solid halo underneath,
		// bright dashes on top.
		c.setLineDash([]);
		c.lineWidth = 3;
		c.strokeStyle = "rgba(0, 0, 0, 0.55)";
		c.strokeRect(r[0], r[1], r[2], r[3]);
		c.setLineDash([5, 4]);
		c.lineWidth = 1;
		c.strokeStyle = "rgba(255, 255, 255, 0.95)";
		c.strokeRect(r[0], r[1], r[2], r[3]);
	}

	private onMouseUp(ev: MouseEvent): void {
		this.end = [ev.offsetX, ev.offsetY];
		this.isDown = false;
	}

	// The selected rect as [x, y, w, h], locked to the canvas aspect ratio so the
	// zoom never distorts: a rect with w/h == canvasW/canvasH scales spanX and
	// spanY by the same factor, leaving the view aspect unchanged. Size is driven
	// by whichever axis you dragged further, so the box always encloses the
	// cursor; direction follows the drag. Undefined if too small to be intentional.
	public getCurrentRect(): [number, number, number, number] | undefined {
		const aspect = this.overlay.width / this.overlay.height;
		const dx = this.end[0] - this.start[0];
		const dy = this.end[1] - this.start[1];
		const w = Math.max(Math.abs(dx), Math.abs(dy) * aspect);
		const h = w / aspect;
		if (h < 10) return undefined;
		const x = dx >= 0 ? this.start[0] : this.start[0] - w;
		const y = dy >= 0 ? this.start[1] : this.start[1] - h;
		return [x, y, w, h];
	}

	public clear(): void {
		this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
		this.start = [0, 0];
		this.end = [0, 0];
	}
}

const boxZoomer = new CanvasBoxZoomer(canvas);

const zoomButton = document.querySelector(".zoom-button") as HTMLElement;
zoomButton.addEventListener("click", () => {
	const r = boxZoomer.getCurrentRect();
	if (!r) return;
	const W = canvas.width, H = canvas.height;
	view = {
		cx: view.cx + ((r[0] + r[2] / 2) / W - 0.5) * view.spanX,
		cy: view.cy + ((r[1] + r[3] / 2) / H - 0.5) * view.spanY,
		spanX: view.spanX * (r[2] / W),
		spanY: view.spanY * (r[3] / H),
	};
	syncUrl(view);
	renderer.render(view);
	boxZoomer.clear();
});

const resetButton = document.querySelector(".reset-button") as HTMLElement;
resetButton.addEventListener("click", () => {
	view = { ...DEFAULT_VIEW };
	syncUrl(view);
	renderer.render(view);
	boxZoomer.clear();
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
