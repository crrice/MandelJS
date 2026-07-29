// filters/xray.ts — Tierazon filter #41: concentric ring orbit-trap, even/odd parity →
// intensity+parity channels. The first FilterDef of the registry; extracted verbatim from
// the old hand-written escapeCustom/filterColor. Self-contained (OKLab helpers live here —
// only filter mapping B uses them).
import type { FilterDef } from "./index";

// OKLab conversion (perceptual) for mapping B: keep a gradient color's hue+chroma, impose
// parity as lightness. Color-pass only — never the iteration loop.
let _okL = 0, _okA = 0, _okB = 0;
function srgbToLin(c: number): number { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToOklab(r: number, g: number, b: number): void {
	const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
	const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
	const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
	const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
	const cl = Math.cbrt(l), cm = Math.cbrt(m), cs = Math.cbrt(s);
	_okL = 0.2104542553 * cl + 0.7936177850 * cm - 0.0040720468 * cs;
	_okA = 1.9779984951 * cl - 2.4285922050 * cm + 0.4505937099 * cs;
	_okB = 0.0259040371 * cl + 0.7827717662 * cm - 0.8086757660 * cs;
}
function oklabToPacked(L: number, a: number, b: number): number {
	const cl = L + 0.3963377774 * a + 0.2158037573 * b;
	const cm = L - 0.1055613458 * a - 0.0638541728 * b;
	const cs = L - 0.0894841775 * a - 1.2914855480 * b;
	const l = cl * cl * cl, m = cm * cm * cm, s = cs * cs * cs;
	let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
	r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
	g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
	bl = bl <= 0.0031308 ? 12.92 * bl : 1.055 * Math.pow(bl, 1 / 2.4) - 0.055;
	const R = r < 0 ? 0 : r > 1 ? 255 : (r * 255) | 0;
	const G = g < 0 ? 0 : g > 1 ? 255 : (g * 255) | 0;
	const B = bl < 0 ? 0 : bl > 1 ? 255 : (bl * 255) | 0;
	return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
}

export const xrayRings: FilterDef = {
	id: 1,
	key: "xray",
	label: "x-ray rings",

	// Loop-local accumulators, declared once before the loop.
	locals: "let xtot = 0, ytot = 0, minRing = Infinity;",

	// Per-pixel trap geometry for MANDELBROT mode (c = the pixel). Julia mode hoists the
	// frame-constant ctx values instead (the assembler decides which to emit).
	pixelInit: "tLimit = Math.sqrt(cx * cx + cy * cy); tLo = tLimit - dStrands; tHi = tLimit + dStrands;",

	// In-loop observer on the POST-update z. `skipGuard` is spliced by the assembler:
	// Mandelbrot (z₀=0) skips n=1 (z₁=c lands on the ring exactly for every pixel — a
	// trivial uniform hit); Julia has no such artifact.
	observer(skipGuard: string): string {
		return skipGuard + "{\n" +
			"const fr = Math.sqrt(zx * zx + zy * zy);\n" +
			"if (fr > tLo && fr < tHi) {\n" +
			"  const fdr = Math.abs(tLimit - fr);\n" +
			"  if (fdr < minRing) minRing = fdr;\n" +
			"  if ((n & 1) === 0) xtot++; else ytot++;\n" +
			"}\n}";
	},

	// At loop exit: fold accumulators into (intensity, parity). out[0]=parity channel,
	// return = intensity (or -1 = miss → background).
	complete:
		"if (minRing === Infinity) { K.out[0] = 0; return -1; }\n" +
		"const ftot = xtot + ytot;\n" +
		"K.out[0] = ftot > 0 ? ytot / ftot : 0.5;\n" +
		"return 1 - minRing / dStrands;",

	// The palette bake policy: parity maps the gradient's ENDPOINTS to all-even/all-odd,
	// which must stay distinct — force a non-cyclic LUT.
	lut: { cyclic: false },

	// The readout: (intensity, parity) → packed RGBA through the shared palette LUT.
	// dFactor = exposure gamma; density cycles the palette; blend 0 = A (bg-anchored
	// triangle), 1 = B (OKLab lightness curtain). Fully per-pixel — no frame stats.
	color(inten: number, parity: number, lut: Uint32Array, inSet: number, dFactor: number, blend: number, density: number): number {
		if (inten < 0) return inSet;
		if (inten > 1) inten = 1;
		const gamma = dFactor * 0.25;
		const u = Math.pow(inten, 1 / gamma);
		const uf = u < 1 ? u : 0.999999;
		let uc = uf * density; uc -= Math.floor(uc);
		if (parity < 0) parity = 0; else if (parity > 1) parity = 1;
		if (blend === 1) {
			const col = lut[(uc * (lut.length - 1)) | 0];
			rgbToOklab(col & 255, (col >> 8) & 255, (col >> 16) & 255);
			return oklabToPacked(_okL + 0.14 * (parity - 0.5), _okA, _okB);
		}
		let ua = uc + 0.12 * (parity - 0.5);
		if (ua < 0) ua = 0; else if (ua > 1) ua = 1;
		const g = lut[(ua * (lut.length - 1)) | 0];
		const gr = g & 255, gg = (g >> 8) & 255, gb = (g >> 16) & 255;
		const ir = inSet & 255, ig = (inSet >> 8) & 255, ib = (inSet >> 16) & 255;
		const R = (ir + (gr - ir) * u) | 0, G = (ig + (gg - ig) * u) | 0, B = (ib + (gb - ib) * u) | 0;
		return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
	},
};
