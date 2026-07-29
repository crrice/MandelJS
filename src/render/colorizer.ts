// render/colorizer.ts — the Colorizer: palette/LUT lifecycle (theme-aware rebuild,
// per-filter override, provisional ramp) + every "sample → packed color" path, all routed
// through the kernel's single colorSample so nothing can drift. Reads the DOM only inside
// rebuild() (via themeColors), so importing this module stays Node-safe.
import { View, SS, colorSample, setColorState } from "../kernel/kernel";
import type { KernelColorState } from "../kernel/kernel";
import { Palette, PALETTES, themeColors } from "../palette";
import { FILTERS } from "../filters/index";
import type { PaletteMsg } from "../protocol";
import type { FieldStore, Levels } from "./field";
import type { RenderSink } from "./sink";

// Band-frequency multipliers for the compressed (zoom-stable) escape maps — densityBase
// was calibrated for linear mu; √/log span far less, so each gets a frequency multiplier
// to land a comparable band count. Eyeball-tunable: larger = more bands.
const BAND_FREQ_SQRT = 3;
const BAND_FREQ_LOG = 24;
// Linear-map zoom stretch: hold the per-pixel color rate roughly constant with depth.
const COLOR_STRETCH_EXP = 0.3;

// Per-filter LUT treatment comes from the registry (FilterDef.lut).

export class Colorizer {
	private palette: Palette;
	public wrap: boolean;          // effective wrap (palette default; not user-facing)
	public densityBase: number;    // effective density (palette default; user-overridable)
	public densityMul = 1 / 32;
	public bandMap = 2;            // escape band transfer (0 linear / 1 sqrt / 2 log)
	public mode = 0;               // 0 = escape-time, 1 = distance
	public lut!: Uint32Array;
	public inSet = 0;
	private provLut!: Uint32Array;

	public constructor(palette: Palette, filterId: number) {
		this.palette = palette;
		this.wrap = palette.cyclic;
		this.densityBase = palette.density;
		this.rebuild(filterId);
	}

	// Switch palettes: reset wrap/density to the palette's own defaults + rebuild.
	public setPalette(p: Palette, filterId: number): void {
		this.palette = p;
		this.wrap = p.cyclic;
		this.densityBase = p.density;
		this.rebuild(filterId);
	}

	// Re-bake the LUT from the current theme, honoring the filter's LUT override, and the
	// theme-aware paper→ink provisional ramp.
	public rebuild(filterId: number): void {
		const { ink, paper } = themeColors();
		const ov = filterId !== 0 && FILTERS[filterId] ? FILTERS[filterId].lut : null;
		const built = this.palette.build(ink, paper, ov ? ov.cyclic : this.wrap);
		this.lut = built.lut;
		this.inSet = built.inSet;
		this.provLut = PALETTES.subtle.build(ink, paper, false).lut;
	}

	// The palette message each worker holds (its own structured-clone copy, ~4KB).
	public paletteMsg(): PaletteMsg {
		return { type: "palette", lut: this.lut, inSet: this.inSet, cyclic: this.wrap };
	}

	// Push the color-pass state colorSample/filterColor read — called before EVERY
	// main-thread color path so none can run on stale kernel state.
	public pushColorState(cs: Omit<KernelColorState, "provLut">): void {
		setColorState({ ...cs, provLut: this.provLut });
	}

	// Map the density knob to the cyclic period, per band map (see the P0 kernel notes:
	// sqrt/log are zoom-stable; linear stretches with zoom).
	public densityMulFor(view: View, defaultSpanX: number): number {
		if (this.bandMap === 1) return BAND_FREQ_SQRT / this.densityBase;
		if (this.bandMap === 2) return BAND_FREQ_LOG / this.densityBase;
		if (!this.wrap) return 1 / this.densityBase;
		const zoom = defaultSpanX / view.spanX;
		const stretch = zoom > 1 ? Math.pow(zoom, COLOR_STRETCH_EXP) : 1;
		return 1 / (this.densityBase * stretch);
	}

	// Color one field sample — the shared colorSample with this frame's level window.
	public sampleColor(mu: number, de: number, view: View, levels: Levels, width: number): number {
		return colorSample(mu, de, this.lut, this.inSet, this.mode, this.wrap, this.densityMul,
			view.spanX / width, this.bandMap, levels.muLo, levels.muHi);
	}

	// Average one edge pixel's SS² subsamples into a packed color.
	public ssaaAverage(mu: Float32Array, de: Float32Array, off: number, nSub: number, view: View, levels: Levels, width: number): number {
		let ar = 0, ag = 0, ab = 0;
		for (let s = 0; s < nSub; s++) {
			const cc = this.sampleColor(mu[off + s], de[off + s], view, levels, width);
			ar += cc & 255; ag += (cc >> 8) & 255; ab += (cc >> 16) & 255;
		}
		return ((255 << 24) | (((ab / nSub) | 0) << 16) | (((ag / nSub) | 0) << 8) | ((ar / nSub) | 0)) >>> 0;
	}

	// Provisional heat color for one CAPPED pixel's structure signal, leveled to [lo, hi].
	public provColor(logDz: number, lo: number, hi: number): number {
		const span = hi > lo ? hi - lo : 1;
		let t = (logDz - lo) / span;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		return this.provLut[(t * (this.provLut.length - 1)) | 0];
	}

	// Repaint the whole frame from the stored 1-sample field with the current coloring,
	// then re-apply the cached anti-aliasing on top (re-averaged through the new colors) —
	// the instant-recolor pass. Caller pushes color state first.
	public repaintFrame(field: FieldStore, sink: RenderSink, view: View, levels: Levels): void {
		const N = field.width * field.height;
		const edit = sink.editFrame();
		const mu = field.mu, de = field.de;
		for (let i = 0; i < N; i++) {
			edit.data32[i] = this.sampleColor(mu[i], de[i], view, levels, field.width);
		}
		const nSub = SS * SS;
		for (let e = 0; e < field.ssaaCount; e++) {
			edit.data32[field.ssaaPos[e]] = this.ssaaAverage(field.ssaaMu, field.ssaaDe, e * nSub, nSub, view, levels, field.width);
		}
		edit.commit();
	}
}
