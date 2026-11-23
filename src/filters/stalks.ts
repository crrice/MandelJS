// filters/stalks.ts — stalks: a running-minimum orbit trap on the coordinate axes. The
// pixel's value is the orbit's closest approach to either axis, so the stalks (the
// pullbacks of the axes under the map) thread the exterior AND the interior. Closeness is
// one scalar, so the palette reads as a plain near→far ramp — no parity channel. Why a
// minimum and not Tierazon's weighted sum: docs/filters/filter-stalks.md.
import type { FilterDef } from "./index";

export const stalks: FilterDef = {
	id: 2,
	key: "stalks",
	label: "stalks",

	// The running minimum, declared once before the loop.
	locals: "let trap = Infinity;",

	// No per-pixel geometry: the axes are the same locus for every pixel.
	pixelInit: "",

	// In-loop observer on the POST-update z: its distance to the nearer axis. `skipGuard`
	// is spliced by the assembler — Mandelbrot skips n=1, where z₁ = c would draw the
	// plane's own axes across the image.
	observer(skipGuard: string): string {
		return skipGuard + "{\n" +
			"const dre = Math.abs(zx), dim = Math.abs(zy);\n" +
			"const d = dre < dim ? dre : dim;\n" +
			"if (d < trap) trap = d;\n" +
			"}";
	},

	// At loop exit: intensity falls linearly from 1 on an axis to 0 at the strands width.
	// An orbit that never came that close is a miss (-1 → background). out[0], the parity
	// channel, has nothing to carry.
	complete:
		"K.out[0] = 0;\n" +
		"if (!(trap < dStrands)) return -1;\n" +
		"return 1 - trap / dStrands;",

	// Closeness is a one-shot ramp, not a cycle: the gradient is baked end to end.
	lut: { cyclic: false },

	// The readout: closeness indexes the gradient. dFactor = exposure gamma; density cycles
	// the palette. blend 0 = A, the gradient faded into the background by the same
	// closeness, so stalks glow out of it; 1 = B, the gradient as it is, so each stalk
	// keeps a hard edge at the strands width. Fully per-pixel — no frame stats.
	color(inten: number, _parity: number, lut: Uint32Array, inSet: number, dFactor: number, blend: number, density: number): number {
		if (inten < 0) return inSet;
		if (inten > 1) inten = 1;
		const gamma = dFactor * 0.25;
		const u = Math.pow(inten, 1 / gamma);
		const uf = u < 1 ? u : 0.999999;
		let uc = uf * density; uc -= Math.floor(uc);
		const g = lut[(uc * (lut.length - 1)) | 0];
		if (blend === 1) return g;
		const gr = g & 255, gg = (g >> 8) & 255, gb = (g >> 16) & 255;
		const ir = inSet & 255, ig = (inSet >> 8) & 255, ib = (inSet >> 16) & 255;
		const R = (ir + (gr - ir) * u) | 0, G = (ig + (gg - ig) * u) | 0, B = (ib + (gb - ib) * u) | 0;
		return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
	},
};
