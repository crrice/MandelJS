// filters/index.ts — the filter registry. A filter is ONE FilterDef: kernel codegen
// snippets (init/observer/complete) consumed by the assembler, the palette-bake policy
// consumed by the colorizer, and the color readout consumed by colorSample. Adding a
// filter = adding a file + a registry row; the CONTROLS stay universal (strands/exposure/
// blend) per the filter-controls-uniform directive, so there is no per-filter UI here.
import { xrayRings } from "./xray";

export type FilterColorFn = (
	inten: number, parity: number, lut: Uint32Array, inSet: number,
	dFactor: number, blend: number, density: number,
) => number;

export interface FilterDef {
	id: number;
	key: string;
	label: string;
	locals: string;                            // loop-local accumulator declarations
	pixelInit: string;                         // Mandelbrot-mode per-pixel trap geometry
	observer(skipGuard: string): string;       // in-loop hook on the post-update z
	complete: string;                          // loop exit → (intensity, parity) outputs
	lut: { cyclic: boolean } | null;           // palette-bake override (null = palette default)
	color: FilterColorFn;                      // (intensity, parity) → packed RGBA
}

export const FILTERS: { [id: number]: FilterDef } = {
	[xrayRings.id]: xrayRings,
};
