//---------------------------------------------------------------------------\\
// palette.ts — a small pluggable palette system, baked into a LUT per render.
// Main-thread only (themeColors reads the DOM); workers receive baked LUTs by message.
//---------------------------------------------------------------------------\\
import { decodeColors, pal8FromPal6, encodeColors } from "./fractint/colors";

export type RGB = [number, number, number];

export interface Palette {
	cyclic: boolean;  // DEFAULT wrap (bands) vs clamp (single ramp); user-overridable
	density: number;  // DEFAULT iterations per gradient cycle / ramp; user-overridable
	// Build a 1D lookup table (+ in-set color) for the theme and the *effective*
	// wrap. Taking wrap as an argument (rather than reading `cyclic`) is what lets
	// a user flip bands<->ramp and get a freshly rebuilt, seamless LUT either way. blend
	// false = nearest stop, no interpolation. A map palette also returns its exact entries.
	build(ink: RGB, paper: RGB, cyclic: boolean, blend?: boolean): { lut: Uint32Array; inSet: number; map?: Uint32Array };
}

const LUT_SIZE = 1024;
const TAU = Math.PI * 2;
// Blending off on a procedural (stop-less) palette: its curve held at this many even stops.
const NOMINAL_STOPS = 16;

// Little-endian RGBA pack (matches Uint32 view over the byte buffer).
function pack(r: number, g: number, b: number): number {
	return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
function clamp255(x: number): number { return x < 0 ? 0 : x > 255 ? 255 : x; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
// A procedural palette's position with blending off: snapped to the nearest nominal stop.
function stepT(t: number, blend: boolean): number { return blend ? t : Math.round(t * NOMINAL_STOPS) / NOMINAL_STOPS; }

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
// is what keeps wrapped (banded) rendering free of a hard seam. Without blend each entry
// takes the NEAREST stop's color instead.
function buildStopsLut(stops: RGB[], cyclic: boolean, blend = true): Uint32Array {
	const pts = cyclic ? stops.concat([stops[0]]) : stops;
	const segs = pts.length - 1;
	const lut = new Uint32Array(LUT_SIZE);
	for (let i = 0; i < LUT_SIZE; i++) {
		const f = (i / (LUT_SIZE - 1)) * segs;   // position along the stop list
		let si = f | 0;
		if (si >= segs) si = segs - 1;           // clamp the final endpoint
		let lt = f - si;                          // fraction within this segment
		if (!blend) lt = lt < 0.5 ? 0 : 1;
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
		build(_ink: RGB, _paper: RGB, wrap: boolean, blend = true): { lut: Uint32Array; inSet: number } {
			return { lut: buildStopsLut(stops, wrap, blend), inSet: pack(0, 0, 0) };
		},
	};
}

// A USER-authored palette: arbitrary hex color stops + an explicit in-set color (the
// interior for escape-time, and the background/miss color for a filter). Same bake as
// stopsPalette, but the interior is user-chosen rather than forced black. buildStopsLut
// needs ≥2 stops, so a single stop is duplicated into a flat gradient. main.ts rebuilds
// one of these on every edit.
export function customPalette(hexes: string[], insetHex: string, cyclic: boolean, density: number): Palette {
	let stops = hexes.map((h) => hexToRgb(h, [0, 0, 0]));
	if (stops.length === 0) stops = [[0, 0, 0]];
	if (stops.length === 1) stops = [stops[0], stops[0]];
	const inset = hexToRgb(insetHex, [0, 0, 0]);
	return {
		cyclic,
		density,
		build(_ink: RGB, _paper: RGB, wrap: boolean, blend = true): { lut: Uint32Array; inSet: number } {
			return { lut: buildStopsLut(stops, wrap, blend), inSet: pack(inset[0], inset[1], inset[2]) };
		},
	};
}

// A MAP palette: an exact 256-entry Fractint map from a colors= string (C5.1/C5.4). Entry
// `inside` (Fractint's inside=, 0 by default) is the in-set color; discrete coloring indexes
// the entries exactly (kernel indexColor). As a gradient it is entries 1..255 on a cycle of
// 255 — the position of count k is entry k, wrapping 255 → 1 like Fractint. null when the
// string does not decode.
export function mapPalette(colors: string, inside: number, density: number): Palette | null {
	const res = decodeColors(colors);
	if (!res.ok || !res.pal6) return null;
	const pal8 = pal8FromPal6(res.pal6);
	const map = new Uint32Array(256);
	for (let i = 0; i < 256; i++) map[i] = pack(pal8[i * 3], pal8[i * 3 + 1], pal8[i * 3 + 2]);
	const stops: RGB[] = [];
	for (let k = 0; k < 255; k++) {
		const e = k === 0 ? 255 : k;   // cycle position 0 ≡ 255
		stops.push([pal8[e * 3], pal8[e * 3 + 1], pal8[e * 3 + 2]]);
	}
	return {
		cyclic: true,
		density,
		build(_ink: RGB, _paper: RGB, wrap: boolean, blend = true): { lut: Uint32Array; inSet: number; map: Uint32Array } {
			return { lut: buildStopsLut(stops, wrap, blend), inSet: map[inside & 255], map };
		},
	};
}

// A gradient LUT (+ its in-set color) sampled as a 256-entry map, colors= encoded: entry 0
// is the in-set color, entry k the LUT at cycle position k/255 — the map palette's own
// layout, so a map made from a palette reads back as that palette.
export function mapColorsFrom(lut: Uint32Array, inSet: number): string {
	const pal8 = new Uint8Array(768);
	for (let k = 0; k < 256; k++) {
		const c = k === 0 ? inSet : lut[Math.round(((k % 255) / 255) * (lut.length - 1))];
		pal8[k * 3] = c & 255; pal8[k * 3 + 1] = (c >> 8) & 255; pal8[k * 3 + 2] = (c >> 16) & 255;
	}
	return encodeColors(pal8, true);
}

export const PALETTES: Record<string, Palette> = {
	// Colorful escape-time bands — the default for the explorer.
	escape: {
		cyclic: true,
		density: 32,
		build(_ink: RGB, _paper: RGB, _cyclic: boolean, blend = true): { lut: Uint32Array; inSet: number } {
			const a: RGB = [0.5, 0.5, 0.5], bb: RGB = [0.5, 0.5, 0.5];
			const c: RGB = [1, 1, 1], d: RGB = [0.65, 0.5, 0.2];
			const lut = new Uint32Array(LUT_SIZE);
			for (let i = 0; i < LUT_SIZE; i++) {
				const [r, g, b] = cosPalette(stepT(i / (LUT_SIZE - 1), blend), a, bb, c, d);
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
		build(ink: RGB, paper: RGB, cyclic: boolean, blend = true): { lut: Uint32Array; inSet: number } {
			const lut = new Uint32Array(LUT_SIZE);
			for (let i = 0; i < LUT_SIZE; i++) {
				let t = stepT(i / (LUT_SIZE - 1), blend);
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

export let currentPalette: Palette = PALETTES.escape;

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
export function themeColors(): { ink: RGB; paper: RGB } {
	const cs = getComputedStyle(document.documentElement);
	return {
		ink: hexToRgb(cs.getPropertyValue("--ink"), [231, 231, 226]),
		paper: hexToRgb(cs.getPropertyValue("--paper"), [14, 15, 18]),
	};
}
