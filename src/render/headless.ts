// render/headless.ts — the DOM-free frame setup: {state, rawView, W, H} → a configured
// single-threaded engine (generated kernels installed, frame state incl. the view affine
// and the z₀/bailout escape settings, index coloring incl. the map palette/discrete/logmap,
// the perturbation reference, the Kernel 2 seed decision), ready for renderRegion. The
// headless render CLI (render.mjs) and the par runners (bench/par-*.mjs) share it.
//
// Faithfulness: the app's resting single pass, WITHOUT its post-pass niceties — no
// probe-sized cap (opts.iters, else the state's forced cap, else 1500), no sharpening
// ladder, no level-snap repaint, density is the zoom-1 mapping.
//---------------------------------------------------------------------------\\

import { View, FORMULA_CUSTOM, installKernels, setFrameState, setIndexState, computeRef, renderRegion } from "../kernel/kernel";
import type { KernelFrameState } from "../kernel/kernel";
import { assembleAll } from "../kernel/assemble";
import { AppState, RawView, PRESETS, CUSTOM_DENSITY, MAP_DENSITY } from "../config";
import { PALETTES, customPalette, mapPalette } from "../palette";
import { compileFormula, compileZ0 } from "../formula";
import { logmapTable } from "../fractint/colors";
import { useDDFor, periodEps2For, decideSeedAtC, z0Key, z0NeedsK2, escapeSpec } from "./pipeline";

// The theme colors palette.ts falls back to (the subtle palette reads them; no DOM here).
const INK: [number, number, number] = [231, 231, 226], PAPER: [number, number, number] = [14, 15, 18];
const FALLBACK_VIEW: RawView = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, span: 4, rot: 0, skew: 0, xmag: 1 };

export interface HeadlessOpts {
	iters?: number;     // the cap (default: the state's forced cap, else 1500)
	noaa?: boolean;     // 1 sample per pixel even when state.aa is on
	noperiod?: boolean; // bake the cycle detector out
}

export interface HeadlessFrame {
	view: View; W: number; H: number; maxIters: number;
	lut: Uint32Array; inSet: number; densityMul: number; cyclic: boolean; mode: number;
	map: Uint32Array | null;        // the map palette's 256 packed entries (null = gradient)
	logTable: Uint8Array | null;    // the logmap table over 0..maxIters (null = off)
	k2: boolean; useDD: boolean; usePert: boolean; seedAtC: boolean;
}

// Configure the engine for one frame. Throws on a formula that does not compile; an
// invalid z₀ applies as unset, like the app. Kernel state is module-global: the frame
// stays current until the next setupHeadless.
export function setupHeadless(state: AppState, rawView: RawView | null, W: number, H: number, opts: HeadlessOpts = {}): HeadlessFrame {
	const raw = rawView || FALLBACK_VIEW;
	const view: View = { cx: raw.cx, cxLo: raw.cxLo, cy: raw.cy, cyLo: raw.cyLo, spanX: raw.span, spanY: raw.span / (W / H), rot: raw.rot, skew: raw.skew, xmag: raw.xmag };

	let formulaBody: string | null = null;
	const preset = PRESETS[state.formulaKey];
	const src = state.formulaKey === "custom" ? state.expr : preset && preset.formula;
	if (src) {
		const res = compileFormula(src);
		if (!res.ok || !res.body) throw new Error("formula failed to compile: " + (res.error || ""));
		formulaBody = res.body;
	}
	const filterId = Number(state.filterId) || 0;
	const usePeriod = !opts.noperiod;
	const z0 = state.z0 === "" || compileZ0(state.z0).ok ? state.z0 : "";
	const k2 = formulaBody != null || state.juliaOn || filterId !== 0 || z0NeedsK2(z0, state.bail);
	const counts = (state.discrete || state.logmap !== 0) && filterId === 0;
	installKernels(assembleAll({ usePeriod, formulaBody, filterId, juliaMode: state.juliaOn, ...escapeSpec(z0, state.bail, k2, state.juliaOn, counts) }).srcs);

	const useDD = k2 ? false : useDDFor(view, W);
	const usePert = useDD;
	const maxIters = opts.iters || state.cap || 1500;

	// Palette: the app's own bakes. Custom stops/inset are absolute; the theme args only
	// matter for the theme-aware built-ins ("subtle").
	const density = Number(state.density) || 32;
	const pal = state.paletteKey === "custom"
		? customPalette(state.stops, state.inset, state.cyclic, CUSTOM_DENSITY)
		: state.paletteKey === "map" ? mapPalette(state.map, state.mapInside, MAP_DENSITY) || PALETTES.escape
			: (PALETTES[state.paletteKey] || PALETTES.escape);
	const cyclic = state.paletteKey === "custom" ? state.cyclic : pal.cyclic;
	const { lut, inSet, map } = pal.build(INK, PAPER, cyclic, state.palBlend);
	const mode = state.coloring === "distance" ? 1 : 0;
	const bandMap = state.coloring === "linear" ? 0 : state.coloring === "sqrt" ? 1 : 2;
	const logTable = logmapTable(state.logmap, maxIters);
	setIndexState({ discrete: state.discrete, logTable, mapLut: map || null });

	const frame: KernelFrameState = {
		usePeriod, periodEps2: periodEps2For(view, useDD), useDD, usePert,
		bandMap,
		fractalMode: k2 ? 1 : 0, formulaId: formulaBody != null ? FORMULA_CUSTOM : 0,
		juliaMode: state.juliaOn, mSeedAtC: false, juliaCx: state.juliaX, juliaCy: state.juliaY,
		filterId, trapDStrands: Number(state.strands), filterDFactor: Number(state.exposure),
		filterBlend: Number(state.blend), filterDensity: 1,
		ssaaOn: !opts.noaa && state.aa,
	};
	setFrameState(frame);
	const seedAtC = k2 && !state.juliaOn && z0Key(z0) === "" && decideSeedAtC(view);
	if (seedAtC) setFrameState({ ...frame, mSeedAtC: true });
	if (usePert) computeRef(view, maxIters);

	return { view, W, H, maxIters, lut, inSet, densityMul: 1 / density, cyclic, mode, map: map || null, logTable, k2, useDD, usePert, seedAtC };
}

// Render the tile (ox, oy, tw, th) of a configured frame (default: all of it). out is packed
// RGBA; mu/de are the kernel's fields, tile-local row-major.
export function renderHeadless(f: HeadlessFrame, ox = 0, oy = 0, tw = f.W, th = f.H): { out: Uint32Array; mu: Float32Array; de: Float32Array } {
	const N = tw * th;
	const out = new Uint32Array(N), mu = new Float32Array(N), de = new Float32Array(N);
	renderRegion(out, mu, de, tw, ox, oy, tw, th, f.W, f.H, f.view, f.maxIters, f.lut, f.inSet, f.densityMul, f.cyclic, f.mode);
	return { out, mu, de };
}
