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