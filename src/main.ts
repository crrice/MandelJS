// main.ts — MandelJS entry: URL state, navigation (zoom selector, history, M↔J bundles),
// controls wiring, telemetry readouts, and the dev console hooks. Compute lives in
// src/kernel/, orchestration in src/render/pipeline.ts; the worker pool runs src/worker.ts.
import { View, DEFAULT_VIEW, FORMULA_MANDEL } from "./kernel/kernel";
import { ddAdd, _dhi, _dlo } from "./math/dd";
import { compileFormula } from "./formula";
import { Palette, PALETTES, customPalette, currentPalette } from "./palette";
import { RenderPipeline } from "./render/pipeline";
import { CanvasSink } from "./render/sink";
import type { GenStats, FrameStats } from "./render/telemetry";
import { AppState, PRESETS, CUSTOM_DENSITY, urlFromState, stateFromUrl, parFromState, stateFromPar } from "./config";
import { FILTERS } from "./filters/index";
import type { RawView } from "./config";
import { easel, canvas, ctx, DEBUG } from "./ui/dom";
import { computeGeometry, applyGeometry, pinGeometry, getResolution, setResolution } from "./ui/viewport";
import type { ResolutionMode } from "./ui/viewport";

//---------------------------------------------------------------------------\\
// Orchestration
//---------------------------------------------------------------------------\\

const renderer = new RenderPipeline(new CanvasSink(canvas), currentPalette, { debug: DEBUG });

// State <-> URL. The address bar reflects the FULL state (view + formula + set type/seed +
// filter + aspect + coloring — see syncUrl/restoreFromUrl), so any view is a permalink:
// copy it, or reload it verbatim to reproduce exactly what's on screen.
// The REQUESTED view aspect (the URL's ar param). spanY always derives from THIS — never
// from the realized buffer ratio — so a permalink frames the SAME complex-plane window on
// every device; the device-local resolution setting only changes the pixel count.
let VIEW_ASPECT = 2;
// True while a Julia set is on screen. The URL carries the FULL state, so a Julia z-view is
// a valid permalink. inJulia only tells syncUrl which set type to record + which seed.
let inJulia = false;
let currentSeed = { cx: 0, cy: 0 };   // the active Julia seed, for the URL (set by enterJulia / restoreFromUrl)

// Serialize the ENTIRE app state into the address bar so any view is a shareable
// permalink. The param schema (config.ts) does the writing — one row per param, write and
// read co-located; currentState() below gathers the live values. Byte-compatible with the
// pre-P1 serializer. Called by every mutating control (and restoreFromUrl).
function syncUrl(): void {
	history.replaceState(null, "", urlFromState(view, currentState()));
}

// Gather the live app state from the controls + module vars — the ONE place serialization
// reads from. Null-control fallbacks match the old syncUrl's ternaries, so pages without
// the optional controls serialize identically.
function currentState(): AppState {
	return {
		formulaKey: formulaSelect ? formulaSelect.value : "0",
		expr: formulaInput ? formulaInput.value : "z^2 + c",
		juliaOn: inJulia, juliaX: currentSeed.cx, juliaY: currentSeed.cy,
		filterId: filterSelect ? filterSelect.value : "0",
		strands: strandsSlider ? strandsSlider.value : "0.08",
		exposure: exposureSlider ? exposureSlider.value : "4",
		blend: blendSelect ? blendSelect.value : "0",
		aspect: aspectSelect ? aspectSelect.value : "2",
		paletteKey: paletteSelect ? paletteSelect.value : "escape",
		stops: customStops.slice(),
		inset: palInset ? palInset.value : "#000000",
		cyclic: palCyclic ? palCyclic.checked : true,
		density: densitySlider ? densitySlider.value : "32",
		coloring: coloringSelect ? coloringSelect.value : "log",
		cap: currentIterCap(),
	};
}

let view: View = { ...DEFAULT_VIEW };   // placeholder — restoreFromUrl() (end of setup) sets the real view

// High-precision (double-double) badge: lit when a view is deep enough to switch to DD.
// Subscribed BEFORE the first render — the precision event fires inside render(), so a
// later hookup would miss the initial (URL) frame — exactly when a deep permalink loads in DD.
const precisionStatus = document.querySelector(".precision-status") as HTMLElement | null;
if (precisionStatus) {
	renderer.events.on("precision", (bits) => {
		precisionStatus.textContent = bits + "-bit";
		precisionStatus.classList.toggle("is-elevated", bits > 64);   // amber/prominent past f64
	});
}

// Heuristic-map flag: shows "parameter map" when a "Mandelbrot" is really a z₀=c heuristic
// (a formula with no z₀=0 set), hidden for true M-sets and Julia. Wired before first render.
const mapNote = document.querySelector(".map-note") as HTMLElement | null;
if (mapNote) {
	renderer.events.on("mapmode", (heuristic) => { mapNote.textContent = heuristic ? "parameter map" : ""; mapNote.classList.toggle("is-shown", heuristic); });
}
// The first render is deferred to restoreFromUrl() at the end of setup — it applies the
// URL's full state to the controls + renderer, then renders once.

// Benchmark helper (console): re-render the current view n times and report the timing
// spread plus the (deterministic) iteration total. Median ms is the number to trust;
// iters is noise-free. e.g.  await mandelBench(9)
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
	mandelDump: () => Promise<unknown>;
	lastGolden?: unknown;
	mandelPar: (text?: string) => unknown;
	mandelUrlRT: (qs: string) => string;
};

dev.mandelBench = async (n = 9) => {
	renderer.configure({ sharpen: false }); // measure the initial-frame path only, no idle passes
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
	renderer.configure({ sharpen: true });
	return { min, median, mean, stats, cappedIterPct };
};

// Toggle periodicity checking for A/B benchmarking.
dev.mandelPeriod = (on = true) => { renderer.configure({ period: on }); console.log("periodicity " + (on ? "ON" : "OFF")); };

// Toggle progressive sharpening (idle re-iteration of undetermined points).
dev.mandelSharpen = (on = true) => { renderer.configure({ sharpen: on }); console.log("sharpening " + (on ? "ON" : "OFF")); };

// Switch the escape-time band transfer for A/B. 0 linear, 1 sqrt, 2 log. e.g. mandelBand(1)
dev.mandelBand = (n = 0) => { renderer.recolor({ bandMap: n }); console.log("band map = " + (["linear", "sqrt", "log"][n] || n)); };

// Force double-double precision for A/B on the wall window (null = auto-gate by zoom).
dev.mandelDD = (on = true) => {
	renderer.configure({ dd: on });
	console.log("DD precision " + (on === null ? "AUTO (zoom-gated)" : on ? "forced ON" : "forced OFF"));
	renderer.render(view);
};

// Force the perturbation fast path for A/B at a deep window (null = follow the DD gate).
dev.mandelPert = (on = true) => {
	renderer.configure({ pert: on });
	console.log("perturbation " + (on === null ? "AUTO (follows DD gate)" : on ? "forced ON" : "forced OFF"));
	renderer.render(view);
};

// Toggle provisional CAPPED coloring for A/B — the developing paper→ink underlay vs the
// old all-black first frame. Recolors instantly from the stored field (no re-iterate).
dev.mandelProv = (on = true) => { renderer.recolor({ prov: on }); console.log("provisional coloring " + (on ? "ON" : "OFF")); };

// Custom-formula preview (the "Tierazon" repro): a Julia set of z ← (z²+c)·sin(z^(c·i))
// with the seed and window from tierazon-basic-repro.md, f64. SYNCS the UI controls to
// what it sets, so afterward every control lines up and you can swap modes freely — and it
// becomes a full permalink (survives reload). 4:3 window. e.g. tierazon()
dev.tierazon = (opts?: { rings?: boolean; dStrands?: number; dFactor?: number }) => {
	const W = 640, H = 480;   // 4:3, matching the target window's aspect (square pixels, no stretch)
	pinGeometry(canvas, easel, W, H);   // the repro is pinned — resolution policy doesn't apply
	selector.syncGeometry(W, H, W / H);
	VIEW_ASPECT = W / H;
	// Window + seed + formula straight from the brief.
	const XMIN = -0.1499053515515627, XMAX = 1.188366179688075;
	const YMIN = 0.2655855689131403, YMAX = 1.269289217342869;
	view = { cx: (XMIN + XMAX) / 2, cxLo: 0, cy: (YMIN + YMAX) / 2, cyLo: 0, spanX: XMAX - XMIN, spanY: YMAX - YMIN };
	const FORMULA = "(z^2 + c) * sin(z^(c*i))", SX = 0.4206477290564087, SY = 0.5647650444593624;
	const rings = !!(opts && opts.rings), dStrands = opts?.dStrands ?? 0.08, dFactor = opts?.dFactor ?? 4;
	const ct = compileFormula(FORMULA);
	if (ct.ok && ct.body) renderer.configure({ formula: { body: ct.body } });
	renderer.configure({ setType: { julia: true, cx: SX, cy: SY } });   // Julia, the brief's seed
	renderer.configure({ filter: { id: rings ? 1 : 0, dStrands, dFactor } });

	// ---- Sync the UI controls + navigation state to the renderer, so the config is fully
	// hand-controllable.
	if (formulaSelect) formulaSelect.value = "custom";
	if (formulaInput) formulaInput.value = FORMULA;
	if (aspectSelect) aspectSelect.value = "1.3333333";
	if (filterSelect) filterSelect.value = rings ? "1" : "0";
	if (strandsSlider) strandsSlider.value = String(dStrands);
	if (exposureSlider) exposureSlider.value = String(dFactor);
	mBundle = { view: defaultViewFor(), history: [] };   // sensible M-view for toggling julia off (inJulia still false here)
	inJulia = true;
	currentSeed = { cx: SX, cy: SY };
	if (juliaToggle) juliaToggle.checked = true;
	jBundle = { seed: seedKey(SX, SY), view, history: [] };
	setHistory([]);
	updateContextualControls();   // reveal the f(z,c)= field + filter params to match
	syncUrl();

	if (rings) renderer.render(view, 128); else renderer.render(view);
	console.log("tierazon: Cthulu Julia" + (rings ? " + x-ray rings" : ", escape-time") + " — UI + URL synced; swap modes freely. reload to reset.");
};

// Tune the x-ray filter exposure by eye — instant recolor from the stored accumulators.
dev.tierazonExposure = (dFactor) => { renderer.recolor({ filterExposure: dFactor }); console.log("filter exposure dFactor=" + dFactor); };

// z²+c JULIA seeded from the current view CENTER — tests the Julia path. e.g. juliaHere()
dev.juliaHere = () => {
	renderer.configure({ formula: { id: FORMULA_MANDEL } });
	renderer.configure({ setType: { julia: true, cx: view.cx, cy: view.cy } });   // Julia @ current center
	renderer.configure({ filter: { id: 0, dStrands: 0.08, dFactor: 1 } });
	const seed = view;
	view = { cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 4 / (canvas.width / canvas.height) };   // default z-window
	renderer.render(view);
	console.log("z²+c Julia @ c = " + seed.cx.toFixed(6) + " + " + seed.cy.toFixed(6) + "i · reload to reset");
};

// Apply the x-ray filter to the CURRENT fractal (default z²+c Mandelbrot) — tests filters
// on M-sets (per-pixel trap limit = |c|). e.g. filterHere() or filterHere(6)
dev.filterHere = (dFactor = 4) => {
	renderer.configure({ filter: { id: 1, dStrands: 0.08, dFactor } });
	renderer.render(view);
	console.log("x-ray rings on the current fractal, dFactor=" + dFactor + " · tierazonExposure(n) to tune · reload to reset");
};

// ---- P0 golden-capture harness (refactor-p0.md, step 0). Deterministically re-render the
// CURRENT state (initial frame ONLY — sharpening off, since the ladder's stage count depends
// on wall-clock) and fingerprint the result: the exact iteration total + FNV-1a hashes of the
// raw (mu, de) fields and the canvas pixels. Captured pre-refactor into goldens/*.json; the
// ported build must reproduce every record bit-for-bit. V8-only (Math.* precision is per-
// engine). The record also lands in dev.lastGolden so automation can poll a slow window's
// result instead of awaiting. e.g.  await mandelDump()
function fnv1a(bytes: Uint8Array | Uint8ClampedArray): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, "0");
}
dev.mandelDump = async () => {
	dev.lastGolden = undefined;
	renderer.configure({ sharpen: false });   // initial frame only: deterministic pass count
	// GOLDEN PIN: capture at the device-independent legacy geometry — a 640-wide buffer
	// and the REALIZED-ratio spanY the records were captured with. The live app derives
	// spanY from the requested aspect and sizes the buffer per device; the goldens must
	// not vary with either. Restored (and re-rendered) after the capture.
	const legacyH = Math.round(640 / VIEW_ASPECT);
	pinGeometry(canvas, easel, 640, legacyH);
	const viewLegacy: View = { ...view, spanY: view.spanX / (640 / legacyH) };
	const r = await renderer.renderAndWait(viewLegacy);
	renderer.configure({ sharpen: true });
	const f = { muField: renderer.fields.mu, deField: renderer.fields.de };
	const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
	// deField is hashed RAW since P3: the generated kernels define the de side-channel (0)
	// on in-set returns, so the old scheduling-dependent stale entries — and the mask that
	// worked around them — are gone.
	const rec = {
		url: location.search,
		w: canvas.width, h: canvas.height,
		maxIters: r.maxIters, iters: r.stats.iters,
		esc: r.stats.esc, ins: r.stats.ins, per: r.stats.per, cap: r.stats.cap,
		muHash: fnv1a(new Uint8Array(f.muField.buffer, f.muField.byteOffset, f.muField.byteLength)),
		deHash: fnv1a(new Uint8Array(f.deField.buffer, f.deField.byteOffset, f.deField.byteLength)),
		pixHash: fnv1a(img.data),
	};
	console.log("[golden] " + JSON.stringify(rec));
	dev.lastGolden = rec;
	applyLayout();               // restore the live layout…
	renderer.render(view);       // …and the live frame (the pin clobbered both)
	return rec;
};

// .par round-trip (schema-driven; see config.ts). No argument: log + return the current
// state as a Fractint-style parameter block. With text: parse it and apply the whole
// state (same applier as a URL permalink), then render. e.g.
//   const p = mandelPar()          // export
//   mandelPar(p)                   // re-import
dev.mandelPar = (text?: string) => {
	if (text == null) {
		const par = parFromState("mandeljs", view, currentState());
		console.log(par);
		return par;
	}
	applyFullState(stateFromPar(text));
	return "par applied";
};

// URL round-trip test hook (pure, no rendering): parse a query string through the schema
// and re-serialize. On an already-normalized permalink the output must be IDENTICAL —
// the P1 byte-compatibility gate. e.g. mandelUrlRT(location.search) === location.search
dev.mandelUrlRT = (qs: string) => {
	const { state, rawView } = stateFromUrl(qs);
	const v: View = rawView
		? { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: 0 }
		: view;
	return urlFromState(v, state);
};

// Progressive readout (optional element): the current render phase plus the live
// undetermined-point split — `working` (still being iterated) and `abandoned` (given up on
// once escalation stops). Phase: first frame → refining → anti-aliasing → done.
const sharpenStatus = document.querySelector(".sharpen-status") as HTMLElement | null;
if (sharpenStatus) {
	renderer.events.on("progress", ({ working, abandoned, done, phase, etaMs }) => {
		const parts = [phase];
		// First-frame ETA (conservative estimate; the refinement/AA tail isn't estimated).
		if (phase === "first frame" && etaMs !== undefined && etaMs > 250) parts.push("~" + fmtEta(etaMs) + " left");
		if (working > 0) parts.push(working.toLocaleString() + " working");
		if (abandoned > 0) parts.push(abandoned.toLocaleString() + " abandoned");
		sharpenStatus.textContent = parts.join(" · ");
		sharpenStatus.classList.toggle("is-active", !done);
		sharpenStatus.classList.toggle("is-done", done);
	});
}

// Humanize an ETA in ms: 8400 → "8s", 92000 → "1m 32s".
function fmtEta(ms: number): string {
	const s = Math.ceil(ms / 1000);
	if (s < 60) return s + "s";
	const m = Math.floor(s / 60), rs = s % 60;
	return m + "m" + (rs ? " " + rs + "s" : "");
}

// Telemetry grid (optional element): a cell per stat, updated live as tiles land. Cells are
// keyed by a data-k attribute so the markup and the updater stay decoupled.
const telemetry = document.querySelector(".telemetry") as HTMLElement | null;
const teleCells: Record<string, HTMLElement> = {};
if (telemetry) {
	telemetry.querySelectorAll<HTMLElement>(".tstat").forEach((el) => {
		const k = el.dataset.k, v = el.querySelector<HTMLElement>(".tstat-v");
		if (k && v) teleCells[k] = v;
	});
	renderer.events.on("stats", (s) => updateTelemetry(s));
}
function setCell(k: string, text: string): void { const el = teleCells[k]; if (el) el.textContent = text; }
// Set by updateContextualControls: a filter recolors by orbit-trap accumulation, so the
// escape-time telemetry (composition = trapped/miss, deepest/dwell = meaningless) is
// relabelled/blanked.
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

// Composition — status partition of every pixel (sums to 100), one slice per line. In
// filter mode the partition is trapped/miss; in escape-time it's exterior/interior/
// unresolved. FrameStats carries trapped→escaped, miss→inSet.
function compText(s: FrameStats): string {
	const t = s.escaped + s.inSet + s.capped;
	if (t <= 0) return "—";
	if (filterState.active) return [fmtPct(s.escaped, t) + "% trapped", fmtPct(s.inSet, t) + "% miss"].join("\n");
	const parts = [fmtPct(s.escaped, t) + "% exterior", fmtPct(s.inSet, t) + "% interior"];
	if (s.capped > 0) parts.push(fmtPct(s.capped, t) + "% unresolved");
	return parts.join("\n");
}

// Method — compute-path partition of the EXTERIOR pixels only.
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

// Magnification vs the default view: humanized (1.3M×, 1.8T×) through 10¹⁵, then
// scientific with a superscript exponent for the truly deep dives.
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
if (themeMq.addEventListener) themeMq.addEventListener("change", () => renderer.recolor({ theme: true }));

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

const DRAG_SLOP_MOUSE = 4;    // px of motion before a press counts as a drag (vs a click)
const DRAG_SLOP_TOUCH = 10;   // fingers wobble — wider slop before a tap becomes a drag
const SEL_MIN_H = 10;         // smallest selection height worth keeping (CSS px)
const WHEEL_STEP = 1.12;      // per-notch resize factor (mouse wheel)
const DBL_TAP_MS = 350;       // double-tap window (touch): places a quarter-frame box
const DBL_TAP_PX = 40;        // ...if the second tap lands within this radius

// The zoom selector, in CSS-pixel space (the buffer resolution never touches it — the
// committed selection is returned as normalized fractions of the frame). Pointer Events
// give one code path for mouse, touch, and pen: one finger draws/moves the box exactly
// like the mouse; a two-finger pinch resizes the SELECTION about its center (the wheel's
// touch equivalent — the view itself never pinches); a touch double-tap places a
// quarter-frame box. Nothing commits implicitly — the zoom button reads the selection.
class ZoomSelector {
	private overlay: HTMLCanvasElement;
	private octx: CanvasRenderingContext2D;
	private cssW = 640;
	private cssH = 320;
	private aspect = 2;
	private dpr = 1;

	private rect: SelRect | null = null;   // CSS px
	private mode: "none" | "draw" | "move" | "pinch" = "none";
	private moved = false;
	private downPt: [number, number] = [0, 0];   // press origin (tap-vs-drag test)
	private anchor: [number, number] = [0, 0];    // draw: the fixed corner
	private grab: [number, number] = [0, 0];      // move: pointer offset within the box
	private pointers = new Map<number, [number, number]>();   // active pointers (pinch)
	private pinch0 = 1;                    // pinch: starting pointer distance
	private pinchRect: SelRect | null = null;   // pinch: the box at gesture start
	private lastTap: { t: number; x: number; y: number } | null = null;

	// Fires whenever the selection appears or clears, so the zoom button can enable/disable.
	public onChange: (() => void) | null = null;

	public constructor() {
		this.overlay = document.createElement("canvas");
		this.overlay.style.cursor = "crosshair";
		this.overlay.style.touchAction = "none";   // one-finger draw + pinch belong to us; the page scrolls from outside the canvas
		easel.appendChild(this.overlay);
		this.octx = this.overlay.getContext("2d")!;

		this.overlay.addEventListener("pointerdown", this.onDown);
		this.overlay.addEventListener("pointermove", this.onMove);
		this.overlay.addEventListener("pointerup", this.onUp);
		this.overlay.addEventListener("pointercancel", this.onCancel);
		this.overlay.addEventListener("wheel", this.onWheel, { passive: false });
	}

	// Re-apply geometry from the layout: CSS box + a dpr-crisp drawing buffer. Drops any
	// selection — it was locked to the old box.
	public syncGeometry(cssW: number, cssH: number, aspect: number): void {
		this.cssW = cssW; this.cssH = cssH; this.aspect = aspect;
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.overlay.width = Math.round(cssW * this.dpr);
		this.overlay.height = Math.round(cssH * this.dpr);
		this.overlay.style.width = cssW + "px";
		this.overlay.style.height = cssH + "px";
		this.clear();
	}

	private local(ev: { clientX: number; clientY: number }): [number, number] {
		const b = this.overlay.getBoundingClientRect();
		return [ev.clientX - b.left, ev.clientY - b.top];
	}

	private slop(ev: PointerEvent): number { return ev.pointerType === "mouse" ? DRAG_SLOP_MOUSE : DRAG_SLOP_TOUCH; }

	private inside(p: [number, number]): boolean {
		const r = this.rect;
		return !!r && p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
	}

	private onDown = (ev: PointerEvent): void => {
		try { this.overlay.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no capturable id */ }   // drags that leave the canvas keep tracking + release
		const p = this.local(ev);
		this.pointers.set(ev.pointerId, p);
		if (this.pointers.size === 2 && this.rect) {
			// Second finger down: pinch-resize the selection about its center.
			const pts = [...this.pointers.values()];
			this.pinch0 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
			this.pinchRect = { ...this.rect };
			this.mode = "pinch";
			return;
		}
		if (this.pointers.size > 1) return;   // 3+ fingers, or 2 with no box: ignore
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

	private onMove = (ev: PointerEvent): void => {
		const p = this.local(ev);
		if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, p);
		if (this.mode === "pinch" && this.pinchRect) {
			const pts = [...this.pointers.values()];
			if (pts.length >= 2) {
				const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) || 1;
				const f = d / this.pinch0;
				const r = this.pinchRect;
				const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
				this.setRect(this.clampSize({ x: cx - r.w * f / 2, y: cy - r.h * f / 2, w: r.w * f, h: r.h * f }, cx, cy));
			}
			return;
		}
		if (this.mode === "none") {
			if (ev.pointerType === "mouse") this.overlay.style.cursor = this.inside(p) ? "move" : "crosshair";
			return;
		}
		if (!this.moved && Math.hypot(p[0] - this.downPt[0], p[1] - this.downPt[1]) > this.slop(ev)) this.moved = true;
		if (this.mode === "draw") {
			if (this.moved) this.setRect(this.clampSize(this.drawRect(p)));
		} else if (this.mode === "move") {
			if (this.moved) this.setRect(this.clampMove(p[0] - this.grab[0], p[1] - this.grab[1]));
		}
	};

	private onUp = (ev: PointerEvent): void => {
		this.pointers.delete(ev.pointerId);
		if (this.mode === "pinch") {
			// Pinch ends when either finger lifts; the surviving finger doesn't start a drag.
			if (this.pointers.size < 2) { this.mode = "none"; this.pinchRect = null; }
			return;
		}
		if (this.mode === "none") return;
		const wasDraw = this.mode === "draw";
		const moved = this.moved;
		this.mode = "none";
		const p = this.local(ev);
		if (wasDraw && !moved && ev.pointerType !== "mouse") {
			// Touch tap on empty space: dismisses (below, as ever) — but a SECOND tap within
			// the double-tap window places a quarter-frame selection centered on it: the
			// quick-dive affordance. The zoom button still commits.
			const now = performance.now();
			if (this.lastTap && now - this.lastTap.t < DBL_TAP_MS &&
				Math.hypot(p[0] - this.lastTap.x, p[1] - this.lastTap.y) < DBL_TAP_PX) {
				this.lastTap = null;
				this.setRect(this.clampSize({ x: p[0] - this.cssW / 4, y: p[1] - this.cssH / 4, w: this.cssW / 2, h: this.cssH / 2 }, p[0], p[1]));
				return;
			}
			this.lastTap = { t: now, x: p[0], y: p[1] };
		}
		// A tap on empty space (draw, no drag) dismisses; a drag too small to matter is
		// discarded. A press inside the box that didn't move keeps the selection.
		if (wasDraw && (!moved || !this.rect || this.rect.h < SEL_MIN_H)) this.clear();
		if (ev.pointerType === "mouse") this.overlay.style.cursor = this.inside(p) ? "move" : "crosshair";
	};

	private onCancel = (ev: PointerEvent): void => {
		this.pointers.delete(ev.pointerId);
		this.mode = "none";
		this.pinchRect = null;
	};

	// Scroll over the box → resize about its center, aspect locked. Over empty space (or
	// with no box) we don't preventDefault, so the page scrolls as usual.
	private onWheel = (ev: WheelEvent): void => {
		if (!this.rect || !this.inside(this.local(ev))) return;
		ev.preventDefault();
		const r = this.rect;
		const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
		const f = ev.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP;   // scroll up = tighter selection
		this.setRect(this.clampSize({ x: cx - r.w * f / 2, y: cy - r.h * f / 2, w: r.w * f, h: r.h * f }, cx, cy));
	};

	// Aspect-locked rect from the fixed anchor to the cursor: size follows whichever axis
	// was dragged further, direction follows the drag, so the box always encloses the cursor.
	private drawRect(p: [number, number]): SelRect {
		const dx = p[0] - this.anchor[0], dy = p[1] - this.anchor[1];
		const w = Math.max(Math.abs(dx), Math.abs(dy) * this.aspect);
		const h = w / this.aspect;
		return { x: dx >= 0 ? this.anchor[0] : this.anchor[0] - w, y: dy >= 0 ? this.anchor[1] : this.anchor[1] - h, w, h };
	}

	// Clamp a rect to the frame (CSS px): cap the size (aspect preserved), then keep it
	// fully on-canvas. When re-centering (resize/pinch) the given center is held; otherwise
	// the origin is nudged in.
	private clampSize(r: SelRect, cx?: number, cy?: number): SelRect {
		const W = this.cssW, H = this.cssH;
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
		const r = this.rect!, W = this.cssW, H = this.cssH;
		return { x: Math.min(Math.max(x, 0), W - r.w), y: Math.min(Math.max(y, 0), H - r.h), w: r.w, h: r.h };
	}

	private setRect(r: SelRect | null): void {
		this.rect = r;
		this.redraw();
		if (this.onChange) this.onChange();
	}

	private redraw(): void {
		const c = this.octx, W = this.cssW, H = this.cssH;
		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);   // draw in CSS units, dpr-crisp
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

	// The committed selection as NORMALIZED fractions of the frame [x, y, w, h] — the
	// CSS/buffer decoupling never touches the view math. Undefined if none / too small.
	public getRectNorm(): [number, number, number, number] | undefined {
		const r = this.rect;
		if (!r || r.h < SEL_MIN_H) return undefined;
		return [r.x / this.cssW, r.y / this.cssH, r.w / this.cssW, r.h / this.cssH];
	}

	public hasSelection(): boolean { return !!this.rect; }

	public clear(): void { this.setRect(null); }
}

const selector = new ZoomSelector();

const zoomButton = document.querySelector(".zoom-button") as HTMLButtonElement;
const backButton = document.querySelector(".back-button") as HTMLButtonElement | null;
const outButton = document.querySelector(".out-button") as HTMLButtonElement | null;
const resetButton = document.querySelector(".reset-button") as HTMLButtonElement;

// View history for exact zoom-out. Each dive/out/reset pushes the outgoing view; back pops
// it. Kept separate from the URL (which only mirrors the current view) so stepping back
// restores the DD center lo-limbs bit-for-bit — no precision loss on the way out.
const viewHistory: View[] = [];
function pushHistory(v: View): void {
	viewHistory.push(v);
	if (backButton) backButton.disabled = false;
}

// Navigate to a view: swap it in, mirror to the URL, render, and drop any selection.
function goTo(next: View): void {
	view = next;
	syncUrl();
	// Show the new magnification immediately and blank the rest to a dash — the figures
	// fill back in as the first tiles land.
	if (telemetry) {
		setCell("zoom", fmtMag(DEFAULT_VIEW.spanX / next.spanX));
		for (const k of ["deepest", "throughput", "composition", "method", "thresholds"]) setCell(k, "…");
	}
	renderer.render(view);
	selector.clear();
}

// ---- Mandelbrot ↔ Julia toggle. The M-view (c-space) and J-view (z-space) are independent
// coordinate systems, so we snapshot each mode's {view, history} and swap. The J bundle is
// keyed on its seed: re-entering Julia from the SAME center restores your exploration; a
// moved center → fresh J. ----
let mBundle: { view: View; history: View[] } | null = null;                  // saved Mandelbrot state while in Julia
let jBundle: { seed: number; view: View; history: View[] } | null = null;    // cached Julia state (seed = f64 key)

function snapshotHistory(): View[] { return viewHistory.slice(); }
function setHistory(h: View[]): void {
	viewHistory.length = 0;
	for (const v of h) viewHistory.push(v);
	if (backButton) backButton.disabled = viewHistory.length === 0;
}
function defaultJuliaView(): View {
	return { cx: 0, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 4 / VIEW_ASPECT };   // origin, |z| < 2, aspect-matched
}

// The default window for the current mode + formula (reset target; also where a formula
// switch lands). Julia always centers on the origin. In Mandelbrot mode each preset
// supplies its own framing.
function defaultViewFor(): View {
	if (inJulia) return defaultJuliaView();
	const key = formulaSelect ? formulaSelect.value : "0";
	const p = PRESETS[key] || {};
	const cx = p.center ? p.center.cx : (key === "0" ? DEFAULT_VIEW.cx : 0);
	const cy = p.center ? p.center.cy : 0;
	const spanX = p.spanX || DEFAULT_VIEW.spanX;
	return { ...DEFAULT_VIEW, cx, cy, spanX, spanY: spanX / VIEW_ASPECT };
}
function seedKey(cx: number, cy: number): number { return cx * 1e7 + cy; }   // cheap equality key for the seed

function enterJulia(): void {
	inJulia = true;
	const scx = view.cx + view.cxLo, scy = view.cy + view.cyLo;   // seed = DD center collapsed to f64
	currentSeed = { cx: scx, cy: scy };
	mBundle = { view, history: snapshotHistory() };
	renderer.configure({ setType: { julia: true, cx: scx, cy: scy } });
	const key = seedKey(scx, scy);
	if (jBundle && jBundle.seed === key) { view = jBundle.view; setHistory(jBundle.history); }        // same seed → restore
	else { view = defaultJuliaView(); setHistory([]); jBundle = { seed: key, view, history: [] }; }    // new seed → fresh
	syncUrl();
	renderer.render(view);
}
function exitJulia(): void {
	if (jBundle) jBundle = { seed: jBundle.seed, view, history: snapshotHistory() };   // stash the J exploration
	inJulia = false;
	renderer.configure({ setType: { julia: false } });
	if (mBundle) { view = mBundle.view; setHistory(mBundle.history); }
	syncUrl();
	renderer.render(view);
}

// ---- Aspect + responsive layout. The CSS box follows the container width and the
// REQUESTED aspect (ui/viewport computes it; the buffer follows the device resolution
// policy). applyLayout re-derives everything; setAspect is the user handler — relayout,
// re-derive spanY from the requested aspect, re-sync, re-render. ----
function applyLayout(): void {
	VIEW_ASPECT = aspectSelect ? Number(aspectSelect.value) : 2;
	const container = easel.parentElement ? easel.parentElement.clientWidth : 640;
	const g = computeGeometry(container, VIEW_ASPECT, getResolution());
	applyGeometry(canvas, easel, g);
	selector.syncGeometry(g.cssW, g.cssH, VIEW_ASPECT);
}
function setAspect(_aspect: number): void {
	applyLayout();
	view = { ...view, spanY: view.spanX / VIEW_ASPECT };
	syncUrl();
	renderer.render(view);
}

selector.onChange = () => { zoomButton.disabled = !selector.hasSelection(); };
zoomButton.disabled = true;

zoomButton.addEventListener("click", () => {
	const r = selector.getRectNorm();   // normalized fractions — buffer resolution never enters
	if (!r) return;
	// Recenter in double-double: newCenter = oldCenter + boxOffset. In f64 the offset is
	// lost once it drops below the center's ULP (~|c|·ε); ddAdd's twoSum keeps it, so the
	// box lands where you drew it.
	const offX = (r[0] + r[2] / 2 - 0.5) * view.spanX;
	const offY = (0.5 - (r[1] + r[3] / 2)) * view.spanY;   // Im up: match the render's flipped y-map so the box lands where drawn
	ddAdd(view.cx, view.cxLo, offX, 0); const ncx = _dhi, ncxLo = _dlo;
	ddAdd(view.cy, view.cyLo, offY, 0); const ncy = _dhi, ncyLo = _dlo;
	pushHistory(view);
	goTo({
		cx: ncx, cxLo: ncxLo, cy: ncy, cyLo: ncyLo,
		spanX: view.spanX * r[2],
		spanY: view.spanY * r[3],
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
	// Step out past history: 2× the span about the current center (kept exactly — only span
	// changes).
	outButton.addEventListener("click", () => {
		pushHistory(view);
		goTo({ ...view, spanX: view.spanX * 2, spanY: view.spanY * 2 });
	});
}

resetButton.addEventListener("click", () => {
	pushHistory(view);
	goTo(defaultViewFor());
});

// Coloring method (optional control) — one dropdown for all four paths: escape-time bands
// with the linear / √ / log transforms, plus distance estimate. Each recolors instantly.
const coloringSelect = document.querySelector(".coloring-select") as HTMLSelectElement | null;
function applyColoringFromControls(): void {
	const v = coloringSelect ? coloringSelect.value : "log";
	if (v === "distance") renderer.recolor({ coloring: { mode: 1, bandMap: 0 } });
	else renderer.recolor({ coloring: { mode: 0, bandMap: v === "sqrt" ? 1 : v === "log" ? 2 : 0 } });
}
if (coloringSelect) {
	coloringSelect.addEventListener("change", () => { applyColoringFromControls(); syncUrl(); });
}

// Palette instrument — palette picker + density slider. Wrap is no longer user-facing:
// each palette's own default (cyclic) is used (setPalette resets it).
const densitySlider = document.querySelector(".density-slider") as HTMLInputElement | null;
if (densitySlider) {
	densitySlider.value = String(currentPalette.density);
	densitySlider.addEventListener("input", () => { renderer.recolor({ density: Number(densitySlider.value) }); syncUrl(); });
}

const paletteSelect = document.querySelector(".palette-select") as HTMLSelectElement | null;

// ---- Custom palette: a small gradient editor (arbitrary color stops + in-set color),
// baked through the SAME LUT as the built-in palettes. Applies to escape-time AND filters.
// Live — every edit rebuilds the Palette and recolors from the stored field. ----
const paletteEditor = document.querySelector(".palette-editor") as HTMLElement | null;
const palBar = document.querySelector(".pal-bar") as HTMLElement | null;
const palStops = document.querySelector(".pal-stops") as HTMLElement | null;
const palInset = document.querySelector(".pal-inset") as HTMLInputElement | null;
const palCyclic = document.querySelector(".pal-cyclic") as HTMLInputElement | null;
const palAdd = document.querySelector(".pal-add") as HTMLButtonElement | null;
const palRemove = document.querySelector(".pal-remove") as HTMLButtonElement | null;
let customStops = ["#0d0221", "#3a0ca3", "#7209b7", "#f72585", "#ffd60a"];

function updatePalBar(): void { if (palBar) palBar.style.background = "linear-gradient(90deg, " + customStops.join(", ") + ")"; }
function buildCustomPalette(): Palette {
	return customPalette(customStops, palInset ? palInset.value : "#000000", palCyclic ? palCyclic.checked : true, CUSTOM_DENSITY);
}
function applyCustomPalette(): void {
	renderer.recolor({ palette: buildCustomPalette() });
	if (densitySlider) densitySlider.value = String(CUSTOM_DENSITY);
	updatePalBar();
	syncUrl();
}
// (Re)build the stop swatches from customStops — one native color input each, wired live.
function renderStops(): void {
	if (!palStops) return;
	palStops.textContent = "";
	customStops.forEach((hex, i) => {
		const inp = document.createElement("input");
		inp.type = "color"; inp.value = hex;
		inp.addEventListener("input", () => { customStops[i] = inp.value; applyCustomPalette(); });
		palStops.appendChild(inp);
	});
}

if (palAdd) palAdd.addEventListener("click", () => { customStops.push(customStops[customStops.length - 1] || "#ffffff"); renderStops(); applyCustomPalette(); });
if (palRemove) palRemove.addEventListener("click", () => { if (customStops.length > 2) { customStops.pop(); renderStops(); applyCustomPalette(); } });
if (palInset) palInset.addEventListener("input", () => applyCustomPalette());
if (palCyclic) palCyclic.addEventListener("change", () => applyCustomPalette());

if (paletteSelect) {
	paletteSelect.addEventListener("change", () => {
		const isCustom = paletteSelect.value === "custom";
		paletteEditor?.classList.toggle("hidden", !isCustom);
		if (isCustom) { renderStops(); applyCustomPalette(); return; }
		const p = PALETTES[paletteSelect.value];
		if (!p) return;
		renderer.recolor({ palette: p });   // resets effective wrap/density to the palette defaults
		if (densitySlider) densitySlider.value = String(p.density);
		syncUrl();
	});
}

//---------------------------------------------------------------------------\\
// Render-settings controls: formula, Julia toggle + seed, filter + params, aspect. All
// optional (absent on pages without them). Formula/set-type/filter/strands/aspect
// re-iterate; exposure recolors instantly. Kernel selection is derived inside the
// renderer (deriveKernel).
//---------------------------------------------------------------------------\\

const filterSelectEl = document.querySelector(".filter-select") as HTMLSelectElement | null;
// Filter options come from the registry (one FilterDef per filter) — adding a filter file
// adds its dropdown entry; the HTML carries only the empty select.
if (filterSelectEl) {
	filterSelectEl.textContent = "";
	const none = document.createElement("option");
	none.value = "0"; none.textContent = "none";
	filterSelectEl.appendChild(none);
	for (const def of Object.values(FILTERS)) {
		const o = document.createElement("option");
		o.value = String(def.id); o.textContent = def.label;
		filterSelectEl.appendChild(o);
	}
}

const formulaSelect = document.querySelector(".formula-select") as HTMLSelectElement | null;
const formulaCustom = document.querySelector(".formula-custom") as HTMLElement | null;
const formulaInput = document.querySelector(".formula-input") as HTMLInputElement | null;
const formulaError = document.querySelector(".formula-error") as HTMLElement | null;
const juliaToggle = document.querySelector(".julia-toggle") as HTMLInputElement | null;
const filterSelect = document.querySelector(".filter-select") as HTMLSelectElement | null;
const strandsSlider = document.querySelector(".strands-slider") as HTMLInputElement | null;
const exposureSlider = document.querySelector(".exposure-slider") as HTMLInputElement | null;
const blendSelect = document.querySelector(".blend-select") as HTMLSelectElement | null;
const aspectSelect = document.querySelector(".aspect-select") as HTMLSelectElement | null;
const pertToggle = document.querySelector(".pert-toggle") as HTMLInputElement | null;   // advanced: z²+c perturbation fast-path A/B (perf only — same image, so no view state)
const itercapInput = document.querySelector(".itercap-input") as HTMLInputElement | null;   // advanced: hard maxiter (blank = adaptive); changes the image, so it IS view state

// Reflect the current control state into the renderer + show/hide contextual controls.
function currentFilterId(): number { return filterSelect ? Number(filterSelect.value) : 0; }
function pushFilter(): void {
	renderer.configure({ filter: { id: currentFilterId(), dStrands: strandsSlider ? Number(strandsSlider.value) : 0.08, dFactor: exposureSlider ? Number(exposureSlider.value) : 4 } });
}
function updateContextualControls(): void {
	const filterOn = currentFilterId() !== 0;
	const customOn = formulaSelect?.value === "custom";
	const k2 = (formulaSelect ? formulaSelect.value !== "0" : false) || !!juliaToggle?.checked || filterOn;
	document.querySelectorAll<HTMLElement>(".filter-param").forEach((el) => el.classList.toggle("hidden", !filterOn));
	formulaCustom?.classList.toggle("hidden", !customOn);   // the f(z,c)= text field appears only for "custom…"
	if (!customOn && formulaError) formulaError.textContent = "";   // clear a stale error when leaving custom
	// A filter reads through the palette, so the palette + its editor stay live in filter
	// mode; only the escape-time-specific controls (density, transfer mode) dim.
	document.querySelectorAll<HTMLElement>(".escape-only").forEach((el) => el.classList.toggle("is-dimmed", filterOn));
	// Distance coloring needs Kernel 1's derivative; disable it on Kernel 2.
	const distOpt = coloringSelect?.querySelector<HTMLOptionElement>('option[value="distance"]');
	if (distOpt) distOpt.disabled = k2;
	if (k2 && coloringSelect?.value === "distance") { coloringSelect.value = "log"; renderer.recolor({ coloring: { mode: 0, bandMap: 2 } }); }
	filterState.active = filterOn;   // telemetry relabels in filter mode
	// Perturbation is a z²+c-only fast path — mirror deriveKernel(): disabled + off on
	// Kernel 2 (custom / Julia / filter), enabled + on (auto) on Kernel 1. Reflective only;
	// the change handler drives the renderer.
	if (pertToggle) {
		pertToggle.disabled = k2;
		pertToggle.checked = !k2;
		pertToggle.closest(".field")?.classList.toggle("is-dimmed", k2);
	}
}

// Show/clear a formula error; empty text hides the pill (see .formula-error:empty in CSS).
function showFormulaError(msg: string): void { if (formulaError) formulaError.textContent = msg; }

// Compile the text field and, if it's valid, install it as the custom formula + re-render.
// `refsC === false` (a formula that ignores c) makes every Mandelbrot pixel identical —
// surfaced as a non-blocking note rather than an error.
function applyCustomFormula(): boolean {
	if (!formulaInput) return false;
	const res = compileFormula(formulaInput.value);
	if (!res.ok || !res.body) { showFormulaError(res.error || "invalid formula"); return false; }
	showFormulaError(res.refsC === false && !juliaToggle?.checked ? "note: no c — every point is identical" : "");
	renderer.configure({ formula: { body: res.body } });
	updateContextualControls();
	goTo(view);   // render the current view (the dropdown handler resets it to the formula default first)
	return true;
}

// Configure the renderer for the CURRENT formula-select value (+ optional custom expr)
// WITHOUT touching the view or rendering. Shared by the change handler's non-custom branch
// and by restoreFromUrl.
function applyFormulaFromControls(expr?: string | null): void {
	const key = formulaSelect ? formulaSelect.value : "0";
	if (key === "custom") {
		if (formulaInput && expr != null) formulaInput.value = expr;
		if (formulaInput) {
			const res = compileFormula(formulaInput.value);
			if (res.ok && res.body) { renderer.configure({ formula: { body: res.body } }); showFormulaError(res.refsC === false && !juliaToggle?.checked ? "note: no c — every point is identical" : ""); }
			else showFormulaError(res.error || "invalid formula");
		}
		return;
	}
	const preset = PRESETS[key];
	if (preset && preset.formula) {
		const res = compileFormula(preset.formula);   // presets are known-valid, but guard anyway
		if (res.ok && res.body) renderer.configure({ formula: { body: res.body } });
	} else {
		renderer.configure({ formula: { id: FORMULA_MANDEL } });   // "0" → standard z²+c (Kernel 1)
	}
}

if (formulaSelect) {
	formulaSelect.addEventListener("change", () => {
		// A new formula is a new fractal: land on its default window (per-preset center) and
		// drop the old zoom history. Julia keeps its own view/bundle.
		if (!inJulia) { view = defaultViewFor(); setHistory([]); }
		if (formulaSelect.value === "custom") {
			updateContextualControls();   // reveal the text field
			applyCustomFormula();         // compile the field + install + render the reset view
			return;
		}
		applyFormulaFromControls();
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
	filterSelect.addEventListener("change", () => { pushFilter(); updateContextualControls(); syncUrl(); renderer.render(view); });
}
if (strandsSlider) {   // trap band half-width — re-iterates, so 'change' (on release), not 'input'
	strandsSlider.addEventListener("change", () => { pushFilter(); syncUrl(); renderer.render(view); });
}
if (exposureSlider) {   // exposure — instant recolor from the stored accumulators, so live 'input'
	exposureSlider.addEventListener("input", () => { renderer.recolor({ filterExposure: Number(exposureSlider.value) }); syncUrl(); });
}
if (blendSelect) {   // A/B color-mapping method (experimental) — instant recolor
	blendSelect.addEventListener("change", () => { renderer.recolor({ filterBlend: Number(blendSelect.value) }); syncUrl(); });
}
if (aspectSelect) {
	aspectSelect.addEventListener("change", () => setAspect(Number(aspectSelect.value)));
}
// Resolution: how many pixels get computed on THIS device. A device-local preference
// (localStorage), deliberately never in the URL — the same permalink renders the same
// window everywhere, just denser or coarser.
const resolutionSelect = document.querySelector(".resolution-select") as HTMLSelectElement | null;
if (resolutionSelect) {
	resolutionSelect.value = getResolution();
	resolutionSelect.addEventListener("change", () => {
		setResolution(resolutionSelect.value as ResolutionMode);
		applyLayout();
		renderer.render(view);
	});
}
// Window resizes / rotations: re-derive the layout (debounced). A CSS-only change keeps
// the frame (the canvas just scales); a buffer change re-renders at the new pixel count.
let resizeTimer = 0;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		const bw = canvas.width, bh = canvas.height;
		applyLayout();
		if (canvas.width !== bw || canvas.height !== bh) renderer.render(view);
	}, 200);
});
// Coarse pointers (phones): collapse the control sections — the canvas + the sticky
// action bar are the interface; everything else is a tap away.
if (matchMedia("(pointer: coarse)").matches) {
	document.querySelectorAll<HTMLElement>(".ctrl-section[open]").forEach((el) => el.removeAttribute("open"));
}
if (pertToggle) {
	// Perturbation is a pure performance path (identical image to the double-double
	// engine), so it carries no view state / URL — just flip the override and re-iterate.
	// checked = auto (pert where DD engages); unchecked = force DD.
	pertToggle.addEventListener("change", () => { renderer.configure({ pert: pertToggle.checked ? null : false }); renderer.render(view); });
}
// Forced iteration cap (advanced): blank/0 = adaptive, a positive integer = a hard
// maxiter. It changes the image (pixels still capped become interior), so it re-iterates
// AND is view state (URL). See setIterCap.
function currentIterCap(): number | null {
	if (!itercapInput || itercapInput.value.trim() === "") return null;
	const n = Math.round(Number(itercapInput.value));
	return isFinite(n) && n > 0 ? n : null;
}
if (itercapInput) {
	itercapInput.addEventListener("change", () => { renderer.configure({ iterCap: currentIterCap() }); syncUrl(); renderer.render(view); });
}
if (juliaToggle) {
	juliaToggle.addEventListener("change", () => { if (juliaToggle.checked) enterJulia(); else exitJulia(); });
}
updateContextualControls();   // initial state: filter params hidden (filter = none by default)

// ---- Permalink restore + first render. Runs LAST (all controls + renderer methods
// exist). The schema (config.ts) parses the URL into an AppState; applyFullState pushes
// it into the controls + renderer (no change events → no premature renders/syncs), then
// does the single first render. Missing/invalid params fall back to defaults, so a bare
// URL and old ?cx&cy&span links still load. The same applier serves .par import. ----
function restoreFromUrl(): void {
	applyFullState(stateFromUrl(location.search));
}

// Apply a parsed {state, rawView} to the controls + renderer + navigation, then render
// once. Application ORDER matters and mirrors the old restore: aspect first (it resizes
// the canvas, and spanY derives from CANVAS_ASPECT), then formula, filter, coloring, cap,
// and finally the view + set type.
function applyFullState({ state: s, rawView }: { state: AppState; rawView: RawView | null }): void {
	// Aspect first (it sets VIEW_ASPECT, which the view's spanY derives from).
	if (aspectSelect) aspectSelect.value = s.aspect;
	applyLayout();

	// Formula (+ custom text).
	if (formulaSelect) formulaSelect.value = s.formulaKey;
	applyFormulaFromControls(s.formulaKey === "custom" ? s.expr : null);

	// Filter + params. Control values come from the state; pushFilter reads the controls,
	// preserving the old select-rejects-unknown-value semantics.
	if (filterSelect) filterSelect.value = s.filterId;
	if (strandsSlider) strandsSlider.value = s.strands;
	if (exposureSlider) exposureSlider.value = s.exposure;
	if (blendSelect) blendSelect.value = s.blend;
	pushFilter();
	if (blendSelect) renderer.recolor({ filterBlend: Number(blendSelect.value) });

	// Coloring: palette (resets density to its default) → density override → transfer mode.
	if (s.paletteKey === "custom") {
		if (paletteSelect) paletteSelect.value = "custom";
		customStops = s.stops.slice();
		if (palInset) palInset.value = s.inset;
		if (palCyclic) palCyclic.checked = s.cyclic;
		paletteEditor?.classList.remove("hidden");
		renderStops();
		renderer.recolor({ palette: buildCustomPalette() });
		updatePalBar();
		if (densitySlider) densitySlider.value = String(CUSTOM_DENSITY);
	} else if (s.paletteKey !== "escape" && paletteSelect && PALETTES[s.paletteKey]) {
		paletteSelect.value = s.paletteKey;
		renderer.recolor({ palette: PALETTES[s.paletteKey] });
		if (densitySlider) densitySlider.value = String(PALETTES[s.paletteKey].density);
	}
	const palDefault = s.paletteKey === "custom" ? CUSTOM_DENSITY : (PALETTES[s.paletteKey] ? PALETTES[s.paletteKey].density : -1);
	if (Number(s.density) !== palDefault && densitySlider) {
		densitySlider.value = s.density;
		renderer.recolor({ density: Number(s.density) });
	}
	if (coloringSelect) coloringSelect.value = s.coloring;
	applyColoringFromControls();

	// Forced iteration cap — applied before the first render.
	if (itercapInput) itercapInput.value = s.cap != null ? String(s.cap) : "";
	renderer.configure({ iterCap: currentIterCap() });

	// View + set type. spanY derives from the REQUESTED aspect — the same window on
	// every device regardless of the buffer's pixel count.
	const urlView: View | null = rawView
		? { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: rawView.span / VIEW_ASPECT }
		: null;
	if (s.juliaOn) {
		mBundle = { view: defaultViewFor(), history: [] };   // inJulia still false → a sensible M-view for a later exit
		inJulia = true;
		if (juliaToggle) juliaToggle.checked = true;
		currentSeed = { cx: s.juliaX, cy: s.juliaY };
		renderer.configure({ setType: { julia: true, cx: s.juliaX, cy: s.juliaY } });
		view = urlView || defaultJuliaView();
		jBundle = { seed: seedKey(s.juliaX, s.juliaY), view, history: [] };
	} else {
		inJulia = false;
		if (juliaToggle) juliaToggle.checked = false;
		renderer.configure({ setType: { julia: false } });
		view = urlView || defaultViewFor();
	}

	updateContextualControls();   // fix any conflicts (e.g. distance coloring on Kernel 2 → log)
	syncUrl();                    // normalize the address bar to the canonical serialization
	renderer.render(view);
}
restoreFromUrl();
