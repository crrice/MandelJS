// config.ts — the app's serializable state + the param schema (P1). Each parameter's URL
// write AND read live together in one row (the old syncUrl/restoreFromUrl bug class was
// exactly that pair drifting apart across two distant functions). The same rows also back
// the .par text format. DOM-free by design: importable by main.ts, the Node golden/bench
// rigs, and (P2) the UI binder.
//
// Value conventions mirror the controls exactly: control-backed params are RAW STRINGS
// (the slider/select .value), so serialization is byte-compatible with the old
// control-reading syncUrl — old permalinks round-trip unchanged. Typed values only where
// the old code used them (julia seed f64s, cap number, stops list, cyclic flag).
import type { View } from "./kernel/kernel";
import { PALETTES } from "./palette";
import { decodeColors } from "./fractint/colors";

// The formula dropdown, as data. Key = the <option> value. "0" is the standard z²+c
// (Kernel 1 fast path, no compiled formula). "custom" is the editable field. Every other
// entry is a formula STRING compiled through the same path as custom — adding a preset is
// just a row. Each may carry its own default window.
export interface Preset { formula?: string; center?: { cx: number; cy: number }; spanX?: number; }
export const PRESETS: { [key: string]: Preset } = {
	"0": {},                                                                   // z²+c → Kernel 1; classic cx=-1 framing
	"cubic": { formula: "z^3 + c" },                                           // cubic Multibrot, origin
	"ship": { formula: "(abs(re(z)) + abs(im(z))*i)^2 + c", center: { cx: -0.5, cy: -0.5 }, spanX: 3.4 },   // Burning Ship
	"cosine": { formula: "c*cos(z)" },                                         // cosine map, origin
	"custom": {},                                                              // editable; origin
};

export const CUSTOM_DENSITY = 32;   // the custom palette's fixed default density
export const MAP_DENSITY = 255;     // the map palette's: one cycle of its 255 outside entries

// What a change to each param costs — the taxonomy the UI dispatch follows (today by
// convention in main.ts's handlers; a P2 binder can drive it from here).
export type Cost = "recolor" | "reiterate" | "reframe";

export interface AppState {
	formulaKey: string;      // "0" | preset key | "custom"
	expr: string;            // custom formula text (meaningful when formulaKey === "custom")
	z0: string;              // initial z₀ expression, may use c ("" = the default seed)
	bail: number | null;     // bailout radius (null = the kernel's default)
	juliaOn: boolean;
	juliaX: number;          // Julia seed (f64s; String() round-trips exactly)
	juliaY: number;
	filterId: string;        // filter select value ("0" = none)
	strands: string;         // trap band half-width (slider value, verbatim)
	exposure: string;        // filter exposure (slider value, verbatim)
	blend: string;           // filter A/B blend ("0" | "1")
	aspect: string;          // aspect select value ("2", "1.3333333", …)
	paletteKey: string;      // "escape" | … | "custom"
	stops: string[];         // custom palette stops, "#rrggbb" each
	inset: string;           // custom palette in-set color, "#rrggbb"
	cyclic: boolean;         // custom palette bands flag
	map: string;             // map palette: a Fractint colors= string, verbatim
	mapInside: number;       // map palette: the in-set entry (Fractint inside=, 0..255)
	density: string;         // density slider value, verbatim
	coloring: string;        // "linear" | "sqrt" | "log" | "distance"
	discrete: boolean;       // color from the integer escape count (Fractint bands)
	logmap: number;          // Fractint logmap flag (0 = off)
	palBlend: boolean;       // palette blending (false = nearest stop)
	aa: boolean;             // edge anti-aliasing
	cap: number | null;      // forced iteration cap (null = adaptive)
}

export function defaultState(): AppState {
	return {
		formulaKey: "0", expr: "z^2 + c", z0: "", bail: null,
		juliaOn: false, juliaX: 0, juliaY: 0,
		filterId: "0", strands: "0.08", exposure: "4", blend: "0",
		aspect: "2",
		paletteKey: "escape", stops: ["#0d0221", "#3a0ca3", "#7209b7", "#f72585", "#ffd60a"],
		inset: "#000000", cyclic: true, map: "", mapInside: 0,
		density: String(PALETTES.escape.density), coloring: "log",
		discrete: false, logmap: 0, palBlend: true, aa: true,
		cap: null,
	};
}

// The raw view numbers as they travel in the URL. spanY is NOT serialized — it derives
// from span / aspect, and the aspect param must be applied first (main.ts owns that
// ordering because it also resizes the canvas). rot/skew/xmag are the frame affine
// (math/frame.ts), at their defaults 0/0/1 when the URL omits them.
export interface RawView { cx: number; cxLo: number; cy: number; cyLo: number; span: number; rot: number; skew: number; xmag: number; }

// The density the URL omits: each palette's own default (custom → CUSTOM_DENSITY, map →
// MAP_DENSITY).
export function defaultDensityFor(paletteKey: string): number {
	if (paletteKey === "custom") return CUSTOM_DENSITY;
	if (paletteKey === "map") return MAP_DENSITY;
	return PALETTES[paletteKey] ? PALETTES[paletteKey].density : -1;
}

//---------------------------------------------------------------------------\\
// The schema rows. ORDER MATTERS: URLSearchParams serializes in insertion order, and the
// row order below reproduces the old syncUrl's exact output (byte-compatibility with
// every existing permalink and the goldens' recorded URLs).
//---------------------------------------------------------------------------\\

interface ParamRow {
	cost: Cost;
	write(p: URLSearchParams, view: View, s: AppState): void;
	read(p: URLSearchParams, s: AppState): void;
}

const ROWS: ParamRow[] = [
	{ // formula key — omit the default z²+c; unknown keys fall back to "0" (old restore rule)
		cost: "reframe",
		write(p, _v, s) { if (s.formulaKey !== "0") p.set("f", s.formulaKey); },
		read(p, s) { const f = p.get("f") || "0"; s.formulaKey = PRESETS[f] ? f : "0"; },
	},
	{ // custom formula text — only meaningful (and serialized) for the custom key
		cost: "reframe",
		write(p, _v, s) { if (s.formulaKey === "custom") p.set("expr", s.expr); },
		read(p, s) { const e = p.get("expr"); if (e != null) s.expr = e; },
	},
	{ // initial z₀ expression — only when set (any formula, not just custom)
		cost: "reiterate",
		write(p, _v, s) { if (s.z0 !== "") p.set("z0", s.z0); },
		read(p, s) { const z = p.get("z0"); if (z != null) s.z0 = z; },
	},
	{ // bailout radius — only when set; non-positive / non-numeric reads as unset
		cost: "reiterate",
		write(p, _v, s) { if (s.bail != null) p.set("bail", String(s.bail)); },
		read(p, s) {
			const b = p.get("bail");
			if (b != null) { const r = Number(b); s.bail = isFinite(r) && r > 0 ? r : null; }
		},
	},
	{ // Julia set type + seed
		cost: "reframe",
		write(p, _v, s) { if (s.juliaOn) { p.set("j", "1"); p.set("jx", String(s.juliaX)); p.set("jy", String(s.juliaY)); } },
		read(p, s) {
			s.juliaOn = p.get("j") === "1";
			const jx = parseFloat(p.get("jx") || ""), jy = parseFloat(p.get("jy") || "");
			s.juliaX = isFinite(jx) ? jx : 0;
			s.juliaY = isFinite(jy) ? jy : 0;
		},
	},
	{ // filter + its params (params only travel when a filter is on, like the old syncUrl)
		cost: "reiterate",
		write(p, _v, s) {
			const filt = Number(s.filterId);
			if (filt !== 0) {
				p.set("filt", String(filt));
				p.set("str", s.strands);
				p.set("exp", s.exposure);
				if (s.blend !== "0") p.set("fb", s.blend);
			}
		},
		read(p, s) {
			const filt = p.get("filt"); if (filt) s.filterId = filt;
			const str = p.get("str"); if (str) s.strands = str;
			const exp = p.get("exp"); if (exp) s.exposure = exp;
			const fb = p.get("fb"); if (fb) s.blend = fb;
		},
	},
	{ // aspect — the select's value verbatim; default 2:1 omitted
		cost: "reframe",
		write(p, _v, s) { if (s.aspect !== "2") p.set("ar", s.aspect); },
		read(p, s) { const ar = p.get("ar"); if (ar && isFinite(Number(ar)) && Number(ar) > 0) s.aspect = ar; },
	},
	{ // palette (+ the custom gradient or the map when selected)
		cost: "recolor",
		write(p, _v, s) {
			if (s.paletteKey !== "escape") p.set("pal", s.paletteKey);
			if (s.paletteKey === "custom") {
				p.set("stops", s.stops.map((h) => h.replace("#", "")).join("-"));
				p.set("inset", s.inset.replace("#", ""));
				if (!s.cyclic) p.set("cyc", "0");   // bands default ON → omit
			}
			if (s.paletteKey === "map") {
				p.set("map", s.map);
				if (s.mapInside !== 0) p.set("mapin", String(s.mapInside));
			}
		},
		read(p, s) {
			const pal = p.get("pal");
			if (pal === "custom") {
				s.paletteKey = "custom";
				const stopsParam = p.get("stops");
				if (stopsParam) {
					const parsed = stopsParam.split("-").map((h) => "#" + h).filter((h) => /^#[0-9a-fA-F]{6}$/.test(h));
					// ≥1: a single stop is legal (customPalette flattens it into a constant
					// gradient — one color + the in-set color = a two-tone palette).
					if (parsed.length >= 1) s.stops = parsed;
				}
				if (/^[0-9a-fA-F]{6}$/.test(p.get("inset") || "")) s.inset = "#" + p.get("inset");
				s.cyclic = p.get("cyc") !== "0";
			} else if (pal === "map") {
				// A map that does not decode leaves the default palette.
				const m = p.get("map");
				if (m && decodeColors(m).ok) {
					s.paletteKey = "map";
					s.map = m;
					s.density = String(MAP_DENSITY);
					const mi = Number(p.get("mapin") || "0");
					s.mapInside = Number.isInteger(mi) && mi >= 0 && mi <= 255 ? mi : 0;
				}
			} else if (pal && PALETTES[pal]) {
				s.paletteKey = pal;
				s.density = String(PALETTES[pal].density);   // palette selection resets density to its default
			}
		},
	},
	{ // density — omitted when it sits at the selected palette's own default
		cost: "recolor",
		write(p, _v, s) { if (Number(s.density) !== defaultDensityFor(s.paletteKey)) p.set("dens", s.density); },
		read(p, s) { const dens = p.get("dens"); if (dens) s.density = dens; },
	},
	{ // coloring method — log is the default
		cost: "recolor",
		write(p, _v, s) { if (s.coloring !== "log") p.set("col", s.coloring); },
		read(p, s) { const col = p.get("col"); if (col) s.coloring = col; },
	},
	{ // discrete (integer-count) coloring — only when on
		cost: "recolor",
		write(p, _v, s) { if (s.discrete) p.set("disc", "1"); },
		read(p, s) { s.discrete = p.get("disc") === "1"; },
	},
	{ // Fractint logmap flag — only when on; non-integer reads as off
		cost: "recolor",
		write(p, _v, s) { if (s.logmap !== 0) p.set("lm", String(s.logmap)); },
		read(p, s) { const lm = Number(p.get("lm") || "0"); s.logmap = Number.isInteger(lm) ? lm : 0; },
	},
	{ // palette blending — on by default
		cost: "recolor",
		write(p, _v, s) { if (!s.palBlend) p.set("pb", "0"); },
		read(p, s) { s.palBlend = p.get("pb") !== "0"; },
	},
	{ // edge anti-aliasing — on by default
		cost: "reiterate",
		write(p, _v, s) { if (!s.aa) p.set("aa", "0"); },
		read(p, s) { s.aa = p.get("aa") !== "0"; },
	},
	{ // forced iteration cap — only when set
		cost: "reiterate",
		write(p, _v, s) { if (s.cap != null) p.set("cap", String(s.cap)); },
		read(p, s) {
			const cap = p.get("cap");
			if (cap != null) { const n = Math.round(Number(cap)); s.cap = isFinite(n) && n > 0 ? n : null; }
		},
	},
];

//---------------------------------------------------------------------------\\
// URL serialization
//---------------------------------------------------------------------------\\

// The full query string ("?…") for a view + state — the old syncUrl, schema-driven. Every
// f64 round-trips exactly through String()↔parseFloat; URLSearchParams handles escaping.
export function urlFromState(view: View, s: AppState): string {
	const p = new URLSearchParams();
	p.set("cx", String(view.cx)); p.set("cy", String(view.cy)); p.set("span", String(view.spanX));
	if (view.cxLo !== 0) p.set("cxl", String(view.cxLo));   // DD center lo-limbs, only on deep views
	if (view.cyLo !== 0) p.set("cyl", String(view.cyLo));
	if (view.rot) p.set("rot", String(view.rot));              // frame affine, only when non-default
	if (view.skew) p.set("skew", String(view.skew));
	if ((view.xmag || 1) !== 1) p.set("xmag", String(view.xmag));
	for (const row of ROWS) row.write(p, view, s);
	return "?" + p.toString();
}

// Parse a query string into a fresh state (+ the raw view, null when absent/invalid).
// Validation rules mirror the old restoreFromUrl exactly; missing params keep defaults, so
// bare and legacy ?cx&cy&span links load unchanged.
export function stateFromUrl(qs: string): { state: AppState; rawView: RawView | null } {
	const p = new URLSearchParams(qs);
	const state = defaultState();
	for (const row of ROWS) row.read(p, state);
	const cx = parseFloat(p.get("cx") || ""), cy = parseFloat(p.get("cy") || ""), span = parseFloat(p.get("span") || "");
	const cxLo = parseFloat(p.get("cxl") || "0"), cyLo = parseFloat(p.get("cyl") || "0");
	const rot = parseFloat(p.get("rot") || "0"), skew = parseFloat(p.get("skew") || "0"), xmag = parseFloat(p.get("xmag") || "1");
	const rawView = (isFinite(cx) && isFinite(cy) && isFinite(span) && span > 0)
		? {
			cx, cxLo: isFinite(cxLo) ? cxLo : 0, cy, cyLo: isFinite(cyLo) ? cyLo : 0, span,
			rot: isFinite(rot) ? rot : 0, skew: isFinite(skew) ? skew : 0, xmag: isFinite(xmag) && xmag !== 0 ? xmag : 1,
		}
		: null;
	return { state, rawView };
}

//---------------------------------------------------------------------------\\
// .par — a Fractint-inspired plain-text parameter file over the SAME rows: `key=value`
// lines using the URL keys, wrapped in a named block. Import feeds the same readers as a
// URL, so the two formats cannot drift.
//---------------------------------------------------------------------------\\

export function parFromState(name: string, view: View, s: AppState): string {
	const qs = urlFromState(view, s);
	const p = new URLSearchParams(qs);
	const lines: string[] = [];
	p.forEach((v, k) => lines.push("  " + k + "=" + v));
	return name.replace(/\s+/g, "_") + " { ; MandelJS parameter set\n" + lines.join("\n") + "\n}\n";
}

export function stateFromPar(text: string): { state: AppState; rawView: RawView | null } {
	const body = /\{([\s\S]*)\}/.exec(text);
	const p = new URLSearchParams();
	for (const line of (body ? body[1] : text).split("\n")) {
		const t = line.split(";")[0].trim();   // strip Fractint-style comments
		const eq = t.indexOf("=");
		if (eq > 0) p.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
	}
	return stateFromUrl("?" + p.toString());
}
