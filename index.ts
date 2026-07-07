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

//---------------------------------------------------------------------------\\
// Core compute
//---------------------------------------------------------------------------\\

interface View {
	cx: number;    // center, real axis
	cy: number;    // center, imaginary axis
	spanX: number; // width of the view in the complex plane
	spanY: number; // height of the view in the complex plane
}

const DEFAULT_VIEW: View = { cx: -1, cy: 0, spanX: 4, spanY: 2 };

// Iteration budget scales with zoom: deeper views need more iterations or the
// boundary filaments blob into solid "fuzz" (points that would escape just
// later get mislabeled in-set). Grows per octave of zoom, capped so very deep
// views stay tolerable — the worker pool absorbs the extra cost.
const ITER_BASE = 1000;   // full-view budget
const ITER_SLOPE = 600;   // extra iterations per octave (2x) of zoom
const ITER_CAP = 20000;   // ceiling

// Color-frequency control. Deep in, the smooth count changes so fast per pixel
// that a fixed color cycle wraps many times between neighbors — chromatic
// static. Stretch the cycle with zoom (identity at the full view) to hold the
// color gradient's per-pixel rate roughly constant. The exponent ~matches how
// fast the per-pixel delta grows with zoom.
const COLOR_STRETCH_EXP = 0.3;

// Distance-coloring mode: smooth bands by log(distance in pixels). Higher =
// more bands. (Escape-time mode ignores this.)
const DIST_SCALE = 1.5;

// Supersampling: SS x SS sub-samples per pixel, colors averaged, to anti-alias
// the boundary. 1 = off. Applied ADAPTIVELY — only to pixels whose neighborhood
// isn't flat (edges / boundary), so most pixels stay at one sample.
const SS = 2;

// Adaptive-SSAA trigger: a pixel is supersampled when a 4-neighbor's color
// differs by more than this (|dR|+|dG|+|dB|). Lower = more pixels supersampled.
const EDGE_TH = 30;

// Escape radius. A larger radius than the classic |z| > 2 gives visibly
// smoother continuous coloring; 256 (radius 16) is the usual sweet spot.
const BAILOUT2 = 256;

// Sentinel returned by `escapeSmooth` for points that never escaped (in-set).
// Every escaped point yields a finite smooth value, so === is unambiguous.
const IN_SET = Infinity;

// Side-channel output from `escapeSmooth`: the exterior distance estimate (in
// complex-plane units) for the most recent escaped point. A module global to
// keep the hot path allocation-free; embedded into the worker the same way.
let deDist = 0;

// The heart of it: iterate z -> z^2 + c for a single point, returning the
// continuous ("smooth") escape count (or IN_SET if bounded) and, as a side
// effect, `deDist` = the distance-to-boundary estimate  d = 2*|z|*ln|z| / |z'|.
// We carry the derivative z' = dz/dc alongside z (z'_{n+1} = 2*z*z' + 1), which
// is what lets the boundary be colored smoothly instead of as chromatic static.
// Scalar doubles, zero allocations — the hot path. Kept free of outer refs
// (beyond BAILOUT2 / IN_SET / deDist) so it survives stringification.
function escapeSmooth(cr: number, ci: number, maxIters: number): number {
	// Interior shortcut. The two biggest black regions — the main cardioid and
	// the period-2 bulb — are cheap to test algebraically, so we skip iterating
	// them entirely. They're the most expensive points (they never escape), so
	// short-circuiting them is what keeps the tiles reasonably balanced.
	const b = cr + 1;
	if (b * b + ci * ci < 0.0625) return IN_SET;            // period-2 bulb
	const xq = cr - 0.25;
	const q = xq * xq + ci * ci;
	if (q * (q + xq) < 0.25 * ci * ci) return IN_SET;       // main cardioid

	let zx = 0, zy = 0, dzx = 0, dzy = 0, n = 0;
	while (n < maxIters) {
		const x2 = zx * zx, y2 = zy * zy;
		const mag2 = x2 + y2;
		if (mag2 > BAILOUT2) {
			const zmag = Math.sqrt(mag2);
			const dmag = Math.sqrt(dzx * dzx + dzy * dzy);
			deDist = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
			const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
			return mu < 0 ? 0 : mu;
		}
		// derivative first (needs the current z): z' = 2*z*z' + 1
		const ndzx = 2 * (zx * dzx - zy * dzy) + 1;
		const ndzy = 2 * (zx * dzy + zy * dzx);
		// then z = z^2 + c
		const nzx = x2 - y2 + cr;
		const nzy = 2 * zx * zy + ci;
		zx = nzx; zy = nzy;
		dzx = ndzx; dzy = ndzy;
		n++;
	}
	return IN_SET;
}

// Fill a tile into `out` (a Uint32 buffer with row stride `outStride`). The
// tile's top-left sits at (ox, oy) in the full canvas, which — together with
// canvasW/canvasH — is what maps pixels into the complex plane; the output
// itself is written tile-local from index 0. The single-threaded path passes
// the whole canvas as one "tile"; workers pass a small one. mode 0 = escape-time
// bands, mode 1 = distance coloring. Anti-aliasing is ADAPTIVE: one sample per
// pixel, and only pixels near an edge (a neighbor's color differs) get
// supersampled SS x SS. A 1px sampled border makes that decision identical
// whether rendered as a tile or the whole canvas. Also stashes the raw (mu,
// deDist) field into muOut/deOut so the main thread can recolor without
// re-iterating. Self-contained for stringification (escapeSmooth / IN_SET /
// deDist / DIST_SCALE / SS / EDGE_TH).
function renderRegion(
	out: Uint32Array, muOut: Float32Array, deOut: Float32Array, outStride: number,
	ox: number, oy: number, tw: number, th: number,
	canvasW: number, canvasH: number,
	view: View, maxIters: number,
	lut: Uint32Array, inSet: number, densityMul: number, cyclic: boolean, mode: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH;
	const lastIdx = lut.length - 1;
	const pixelSize = view.spanX * invW;                   // for distance mode
	const invSS = 1 / SS, nSub = SS * SS;

	// Color from an already-computed (mu, deDist) sample. This IS the coloring —
	// the main thread runs identical logic over the stored fields.
	function colorOf(mu: number, de: number): number {
		if (mu === IN_SET) return inSet;
		if (mode === 1) {
			let td = Math.log(1 + de / pixelSize) * DIST_SCALE;
			td -= (td | 0);
			return lut[(td * lastIdx) | 0];
		}
		let t = mu * densityMul;
		if (cyclic) t -= (t | 0); else if (t > 1) t = 1;
		return lut[(t * lastIdx) | 0];
	}
	function colorAt(fx: number, fy: number): number {
		const cr = view.cx + (fx * invW - 0.5) * view.spanX;
		const ci = view.cy + (fy * invH - 0.5) * view.spanY;
		const mu = escapeSmooth(cr, ci, maxIters);
		return colorOf(mu, deDist);
	}
	function colorDiff(a: number, b: number): number {
		return Math.abs((a & 255) - (b & 255)) +
			Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
			Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
	}

	// Pass 1: one sample per pixel over the tile PLUS a 1px border (border only
	// for edge detection). Stash the tile's raw (mu, deDist) field for recoloring.
	const sw = tw + 2;
	const s1 = new Uint32Array(sw * (th + 2));
	for (let j = -1; j <= th; j++) {
		const row = (j + 1) * sw;
		const inY = j >= 0 && j < th;
		for (let i = -1; i <= tw; i++) {
			const cr = view.cx + ((ox + i) * invW - 0.5) * view.spanX;
			const ci = view.cy + ((oy + j) * invH - 0.5) * view.spanY;
			const mu = escapeSmooth(cr, ci, maxIters);
			const de = deDist;
			s1[row + i + 1] = colorOf(mu, de);
			if (inY && i >= 0 && i < tw) { const p = j * tw + i; muOut[p] = mu; deOut[p] = de; }
		}
	}

	// Pass 2: keep flat pixels at one sample; supersample only edges.
	const doSS = SS > 1;
	for (let ly = 0; ly < th; ly++) {
		let off = ly * outStride;
		const srow = (ly + 1) * sw;
		for (let lx = 0; lx < tw; lx++, off++) {
			const si = srow + lx + 1;
			const c = s1[si];
			if (doSS && (
				colorDiff(c, s1[si + 1]) > EDGE_TH ||
				colorDiff(c, s1[si - 1]) > EDGE_TH ||
				colorDiff(c, s1[si + sw]) > EDGE_TH ||
				colorDiff(c, s1[si - sw]) > EDGE_TH)) {
				let ar = 0, ag = 0, ab = 0;
				for (let sy = 0; sy < SS; sy++) {
					const fy = oy + ly + (sy + 0.5) * invSS - 0.5;
					for (let sx = 0; sx < SS; sx++) {
						const cc = colorAt(ox + lx + (sx + 0.5) * invSS - 0.5, fy);
						ar += cc & 255; ag += (cc >> 8) & 255; ab += (cc >> 16) & 255;
					}
				}
				out[off] = ((255 << 24) | (((ab / nSub) | 0) << 16) | (((ag / nSub) | 0) << 8) | ((ar / nSub) | 0)) >>> 0;
			} else {
				out[off] = c;
			}
		}
	}
}

//---------------------------------------------------------------------------\\
// Coloring — a small pluggable palette system, baked into a LUT per render.
//---------------------------------------------------------------------------\\

type RGB = [number, number, number];

interface Palette {
	cyclic: boolean;  // DEFAULT wrap (bands) vs clamp (single ramp); user-overridable
	density: number;  // DEFAULT iterations per gradient cycle / ramp; user-overridable
	// Build a 1D lookup table (+ in-set color) for the theme and the *effective*
	// wrap. Taking wrap as an argument (rather than reading `cyclic`) is what lets
	// a user flip bands<->ramp and get a freshly rebuilt, seamless LUT either way.
	build(ink: RGB, paper: RGB, cyclic: boolean): { lut: Uint32Array; inSet: number };
}

const LUT_SIZE = 1024;
const TAU = Math.PI * 2;

// Little-endian RGBA pack (matches Uint32 view over the byte buffer).
function pack(r: number, g: number, b: number): number {
	return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
function clamp255(x: number): number { return x < 0 ? 0 : x > 255 ? 255 : x; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// Inigo Quilez cosine palette: a + b*cos(2pi*(c*t + d)) per channel. Only
// evaluated LUT_SIZE times at build, so the trig is free at render time.
function cosPalette(t: number, a: RGB, b: RGB, c: RGB, d: RGB): RGB {
	return [
		clamp255(255 * (a[0] + b[0] * Math.cos(TAU * (c[0] * t + d[0])))),
		clamp255(255 * (a[1] + b[1] * Math.cos(TAU * (c[1] * t + d[1])))),
		clamp255(255 * (a[2] + b[2] * Math.cos(TAU * (c[2] * t + d[2])))),
	];
}

// Build a LUT by interpolating a gradient across arbitrary color stops (linear
// per segment, faithful to the given colors). When cyclic, the first stop is
// appended so the gradient loops back on itself — LUT[0] === LUT[last] — which
// is what keeps wrapped (banded) rendering free of a hard seam.
function buildStopsLut(stops: RGB[], cyclic: boolean): Uint32Array {
	const pts = cyclic ? stops.concat([stops[0]]) : stops;
	const segs = pts.length - 1;
	const lut = new Uint32Array(LUT_SIZE);
	for (let i = 0; i < LUT_SIZE; i++) {
		const f = (i / (LUT_SIZE - 1)) * segs;   // position along the stop list
		let si = f | 0;
		if (si >= segs) si = segs - 1;           // clamp the final endpoint
		const lt = f - si;                        // fraction within this segment
		const a = pts[si], b = pts[si + 1];
		lut[i] = pack(lerp(a[0], b[0], lt) | 0, lerp(a[1], b[1], lt) | 0, lerp(a[2], b[2], lt) | 0);
	}
	return lut;
}

// A palette defined by hex color stops. Interior stays black — the conventional
// Mandelbrot look, with good contrast on any theme.
function stopsPalette(hexes: string[], cyclic: boolean, density: number): Palette {
	const stops = hexes.map((h) => hexToRgb(h, [0, 0, 0]));
	return {
		cyclic,
		density,
		build(_ink: RGB, _paper: RGB, wrap: boolean): { lut: Uint32Array; inSet: number } {
			return { lut: buildStopsLut(stops, wrap), inSet: pack(0, 0, 0) };
		},
	};
}

const PALETTES: Record<string, Palette> = {
	// Colorful escape-time bands — the default for the explorer.
	escape: {
		cyclic: true,
		density: 32,
		build(): { lut: Uint32Array; inSet: number } {
			const a: RGB = [0.5, 0.5, 0.5], bb: RGB = [0.5, 0.5, 0.5];
			const c: RGB = [1, 1, 1], d: RGB = [0.65, 0.5, 0.2];
			const lut = new Uint32Array(LUT_SIZE);
			for (let i = 0; i < LUT_SIZE; i++) {
				const [r, g, b] = cosPalette(i / (LUT_SIZE - 1), a, bb, c, d);
				lut[i] = pack(r | 0, g | 0, b | 0);
			}
			return { lut, inSet: pack(0, 0, 0) };
		},
	},

	// Subtle monochrome ramp between the theme's paper and ink — the quiet look
	// the ambient renderer uses. Theme-aware: reads --ink / --paper.
	subtle: {
		cyclic: false,
		density: 48,
		build(ink: RGB, paper: RGB, cyclic: boolean): { lut: Uint32Array; inSet: number } {
			const lut = new Uint32Array(LUT_SIZE);
			for (let i = 0; i < LUT_SIZE; i++) {
				let t = i / (LUT_SIZE - 1);
				if (cyclic) t = 1 - Math.abs(2 * t - 1); // triangle paper->ink->paper: loops seamlessly
				t = t * t * (3 - 2 * t);                 // smoothstep for a soft falloff
				lut[i] = pack(
					clamp255(lerp(paper[0], ink[0], t)) | 0,
					clamp255(lerp(paper[1], ink[1], t)) | 0,
					clamp255(lerp(paper[2], ink[2], t)) | 0,
				);
			}
			return { lut, inSet: pack(ink[0] | 0, ink[1] | 0, ink[2] | 0) };
		},
	},

	// Jupiter — the Jovian band tones from my shell palette: warm creams, clay,
	// gold and sage. Reads beautifully as cyclic bands.
	jupiter: stopsPalette(
		["#af9c7c", "#c9805f", "#f5d094", "#e7f2ed", "#a3a18f", "#76664f"], true, 40),

	// Ember — a hot ramp: charred brown, oxblood, burnt orange, amber, pale gold.
	ember: stopsPalette(
		["#180a04", "#6e1a10", "#c9420a", "#f5911d", "#ffd98a"], true, 40),

	// Abyss — cool deep sea: midnight navy, deep teal, teal, aqua, sea-foam.
	abyss: stopsPalette(
		["#07101c", "#0e3a54", "#1c7a8c", "#56c6c0", "#d6f0ea"], true, 40),

	// Twilight — dusk / nebula: deep indigo, violet, orchid, rose, a warm peach glow.
	twilight: stopsPalette(
		["#140a24", "#45206b", "#8a3a8f", "#d05a86", "#f6c9a8"], true, 40),
};

let currentPalette: Palette = PALETTES.escape;

// Read the site's theme colors (falls back to the standalone dark palette when
// the CSS variables aren't defined).
function hexToRgb(hex: string, fallback: RGB): RGB {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return fallback;
	let h = m[1];
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function themeColors(): { ink: RGB; paper: RGB } {
	const cs = getComputedStyle(document.documentElement);
	return {
		ink: hexToRgb(cs.getPropertyValue("--ink"), [231, 231, 226]),
		paper: hexToRgb(cs.getPropertyValue("--paper"), [14, 15, 18]),
	};
}

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
}
interface DoneMsg {
	type: "done"; gen: number;
	ox: number; oy: number; tw: number; th: number;
	buf: ArrayBuffer; mu: ArrayBuffer; de: ArrayBuffer;
}

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
		"const IN_SET = Infinity;",
		"let deDist = 0;",
		escapeSmooth.toString(),
		renderRegion.toString(),
		"let PAL = null;",
		"onmessage = function (e) {",
		"  var m = e.data;",
		"  if (m.type === 'palette') { PAL = m; return; }",
		"  var n = m.tw * m.th;",
		"  var out = new Uint32Array(n), muF = new Float32Array(n), deF = new Float32Array(n);",
		"  renderRegion(out, muF, deF, m.tw, m.ox, m.oy, m.tw, m.th, m.canvasW, m.canvasH,",
		"               m.view, m.maxIters, PAL.lut, PAL.inSet, m.densityMul, PAL.cyclic, m.mode);",
		"  postMessage({ type: 'done', gen: m.gen, ox: m.ox, oy: m.oy, tw: m.tw, th: m.th,",
		"                buf: out.buffer, mu: muF.buffer, de: deF.buffer }, [out.buffer, muF.buffer, deF.buffer]);",
		"};",
	].join("\n");
}

class FractalRenderer {
	private workers: Worker[] = [];
	private idle: boolean[] = [];
	private queue: Array<{ ox: number; oy: number; tw: number; th: number }> = [];
	private gen = 0;
	private view: View = { ...DEFAULT_VIEW };
	private maxIters = ITER_BASE;
	private palette: Palette;
	private wrap: boolean;         // effective wrap (palette default; user-overridable)
	private densityBase: number;   // effective density (palette default; user-overridable)
	private lut!: Uint32Array;
	private inSet = 0;
	private densityMul = 1 / 32;
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

	// Repaint the whole canvas from the stored 1-sample field with the current
	// palette/mode — the coloring pass, run on the main thread, no iteration.
	private colorizeField(): void {
		const W = canvas.width, H = canvas.height, N = W * H;
		const image = ctx.getImageData(0, 0, W, H);
		const data32 = new Uint32Array(image.data.buffer);
		const lut = this.lut, inSet = this.inSet, lastIdx = lut.length - 1;
		const densityMul = this.densityMul, cyclic = this.wrap, mode = this.mode;
		const pixelSize = this.view.spanX / W;
		const mu = this.muField, de = this.deField;
		const lo = this.muLo, span = this.muHi > this.muLo ? this.muHi - this.muLo : 1;
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (m === Infinity) { data32[i] = inSet; continue; }
			if (mode === 1) {
				let td = Math.log(1 + de[i] / pixelSize) * DIST_SCALE;
				td -= (td | 0);
				data32[i] = lut[(td * lastIdx) | 0];
			} else if (cyclic) {
				let t = m * densityMul;
				t -= (t | 0);
				data32[i] = lut[(t * lastIdx) | 0];
			} else {
				// Auto-leveled ramp: normalize mu to the view's escape-count range
				// so the gradient spans the visible structure at any depth instead
				// of clamping to one end.
				let t = (m - lo) / span;
				t = t < 0 ? 0 : t > 1 ? 1 : t;
				data32[i] = lut[(t * lastIdx) | 0];
			}
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
			if (m !== Infinity) { cnt++; if (m < mn) mn = m; if (m > mx) mx = m; }
		}
		if (cnt === 0 || mx <= mn) { this.muLo = 0; this.muHi = 1; return; }
		const BINS = 512;
		const hist = new Uint32Array(BINS);
		const scale = (BINS - 1) / (mx - mn);
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (m !== Infinity) hist[((m - mn) * scale) | 0]++;
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

	// Iterations grow with zoom depth (deeper => more, capped) unless overridden.
	private itersForView(v: View): number {
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		if (zoom <= 1) return ITER_BASE;
		return Math.min(ITER_CAP, Math.round(ITER_BASE + ITER_SLOPE * Math.log2(zoom)));
	}

	// Stretch a cyclic palette's period with zoom so color stops wrapping many
	// times per pixel deep in. Ramp (non-cyclic) palettes clamp, so leave them be.
	private densityMulFor(v: View): number {
		if (!this.wrap) return 1 / this.densityBase;
		const zoom = DEFAULT_VIEW.spanX / v.spanX;
		const stretch = zoom > 1 ? Math.pow(zoom, COLOR_STRETCH_EXP) : 1;
		return 1 / (this.densityBase * stretch);
	}

	public render(view: View, maxIters = this.itersForView(view)): void {
		this.view = view;
		this.maxIters = maxIters;
		this.densityMul = this.densityMulFor(view);
		this.gen++;

		if (this.workers.length === 0) { this.renderSync(); return; }

		// Fresh tile queue for this generation.
		this.queue = [];
		const W = canvas.width, H = canvas.height;
		for (let oy = 0; oy < H; oy += TILE_SIZE)
			for (let ox = 0; ox < W; ox += TILE_SIZE)
				this.queue.push({ ox, oy, tw: Math.min(TILE_SIZE, W - ox), th: Math.min(TILE_SIZE, H - oy) });

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
		};
		this.workers[i].postMessage(msg);
	}

	private onDone(i: number, m: DoneMsg): void {
		if (m.gen === this.gen) { // drop stale tiles from a superseded view
			const img = new ImageData(new Uint8ClampedArray(m.buf), m.tw, m.th);
			ctx.putImageData(img, m.ox, m.oy);
			this.storeField(m.ox, m.oy, m.tw, m.th, new Float32Array(m.mu), new Float32Array(m.de));
		}
		this.dispatch(i); // keep the worker fed from the current queue
		// Last tile of this generation just landed — finalize (auto-level the ramp).
		if (m.gen === this.gen && this.queue.length === 0 && this.idle.every((x) => x)) {
			this.finalizeColors();
		}
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
		renderRegion(
			data32, this.muField, this.deField, W, 0, 0, W, H, W, H, this.view, this.maxIters,
			this.lut, this.inSet, this.densityMul, this.wrap, this.mode,
		);
		ctx.putImageData(image, 0, 0);
		this.finalizeColors(); // auto-level the ramp on the no-workers path too
	}
}

//---------------------------------------------------------------------------\\
// Orchestration
//---------------------------------------------------------------------------\\

const renderer = new FractalRenderer(currentPalette);
let view: View = { ...DEFAULT_VIEW };
renderer.render(view);

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
	renderer.render(view);
	boxZoomer.clear();
});

const resetButton = document.querySelector(".reset-button") as HTMLElement;
resetButton.addEventListener("click", () => {
	view = { ...DEFAULT_VIEW };
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
