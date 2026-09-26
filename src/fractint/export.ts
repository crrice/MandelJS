// fractint/export.ts — the .par file format MandelJS writes: a Fractint-valid 20.04 entry
// (type, center-mag with rotation/skew, maxiter, inside, logmap, colors=, and an frm: block
// for formulas) that Fractint itself can load, plus `; mandeljs: <query>` comment lines that
// carry the exact MandelJS state, so a MandelJS re-import is lossless (config.stateFromPar
// reads those lines first). The Fractint part is the closest Fractint rendering of the state:
// MandelJS-only settings (filters, smooth coloring …) live only in the query.
//---------------------------------------------------------------------------\\

import type { View } from "../kernel/kernel";
import { AppState, PRESETS, urlFromState } from "../config";
import { PALETTES, customPalette, mapColorsFrom } from "../palette";
import { FNode, parseFormula } from "../formula";
import { fmtNum } from "./frm-translate";
import { ddToDecimal } from "./decimal";

const LINE = 76;               // wrap width: Fractint reads at most 512 characters per line
const FALLBACK_MAXIT = 1000;   // maxiter when the cap is adaptive (MandelJS's base budget)
// The theme colors palette.ts falls back to (the subtle palette reads them; no DOM here).
const INK: [number, number, number] = [231, 231, 226], PAPER: [number, number, number] = [14, 15, 18];

// MandelJS functions → Fractint built-ins (C4.9); the rest share their names.
const FRM_FN: { [k: string]: string } = { abs: "cabs", re: "real", im: "imag" };

// A formula.ts tree printed in the frm dialect, fully parenthesized (the dialects' precedence
// and associativity differ, C4.3). Unary minus is written 0-x: Fractint folds a minus into
// a following literal even across a paren (C4.11). c is pixel (or p1 for a Julia).
function frmExpr(n: FNode, c: string): string {
	switch (n.t) {
		case "num": return n.v;
		case "var": return n.name === "z" ? "z" : c;
		case "const": return n.name === "i" ? "(0,1)" : n.name;
		case "neg": return "(0-" + frmExpr(n.a, c) + ")";
		case "bin": return "(" + frmExpr(n.a, c) + n.op + frmExpr(n.b, c) + ")";
		case "call": return (FRM_FN[n.name] || n.name) + "(" + frmExpr(n.a, c) + ")";
	}
}

// A long command broken the way Fractint's writer does: '\' at the end, continued on the
// next (indented) line.
function wrapped(cmd: string): string {
	const out: string[] = [];
	for (let i = 0; i < cmd.length; i += LINE) out.push(cmd.slice(i, i + LINE));
	return "  " + out.join("\\\n  ");
}

// The palette as a Fractint map: the map palette verbatim, anything else sampled from its LUT
// (entry 0 = the in-set color, entry k = cycle position k/255).
function colorsFor(s: AppState): string {
	if (s.paletteKey === "map") return s.map;
	const pal = s.paletteKey === "custom" ? customPalette(s.stops, s.inset, s.cyclic, 0) : PALETTES[s.paletteKey] || PALETTES.escape;
	const b = pal.build(INK, PAPER, s.paletteKey === "custom" ? s.cyclic : pal.cyclic, s.palBlend);
	return mapColorsFrom(b.lut, b.inSet);
}

export function parFromState(name: string, view: View, s: AppState): string {
	const id = name.replace(/\s+/g, "_");
	const cmds: string[] = ["reset=2004"];
	let frm = "";

	// Type: the z²+c fast path is Fractint's mandel (z₀ = c) or julia; anything else is a
	// formula written from our formula + z₀ + bailout.
	const formula = s.formulaKey === "0" ? "z^2 + c" : s.formulaKey === "custom" ? s.expr : PRESETS[s.formulaKey]?.formula || "";
	const k = s.z0.replace(/\s+/g, "").toLowerCase();   // pipeline.z0Key
	if (s.formulaKey === "0" && s.juliaOn) {
		cmds.push("type=julia", "params=" + s.juliaX + "/" + s.juliaY);
	} else if (s.formulaKey === "0" && (k === "" || k === "c")) {
		cmds.push("type=mandel");
	} else {
		const c = s.juliaOn ? "p1" : "pixel";
		const f = parseFormula(formula), z0 = s.juliaOn ? null : parseFormula(k === "" ? "0" : s.z0);
		if (f && (z0 || s.juliaOn)) {
			const l = fmtNum((s.bail ?? 2) * (s.bail ?? 2));
			cmds.push("type=formula", "formulaname=" + id);
			if (s.juliaOn) cmds.push("params=" + s.juliaX + "/" + s.juliaY);
			frm = "\nfrm:" + id + " {\n" + "z=" + (z0 ? frmExpr(z0, c) : "pixel") + ":\n" + "z=" + frmExpr(f, c) + "\n|z| < " + l + "\n}\n";
		} else {
			cmds.push("type=mandel");   // the formula or z₀ does not parse: the Fractint side falls back
		}
	}
	if (s.bail != null && !frm && s.bail !== 2) cmds.push("bailout=" + Math.max(1, Math.round(s.bail * s.bail)));   // rqlim is an integer

	// center-mag: the frame height is 2/Mag; Xmag carries the width/height ratio against 4:3
	// (snapped to 1 at 4:3, where Mag then comes from the width, as the importer reads it) and
	// the view's mirror.
	const xm = view.xmag || 1, A = Number(s.aspect);
	const W = view.spanX / Math.abs(xm), H = view.spanX / A;
	let X = (4 / 3) * H / W;
	if (Math.abs(X - 1) < 1e-6) X = 1;
	const mag = 8 / (3 * W * X);
	// Mag >= 1e13 is Fractint's bignum path (C2.1): the full DD center as a decimal; below,
	// Fractint reads a double.
	const deep = Number(mag.toExponential(1).split("e")[1]) + 4 > 16;
	const dec = (hi: number, lo: number): string => deep ? ddToDecimal(hi, lo) : String(hi);
	let cm = "center-mag=" + dec(view.cx, view.cxLo) + "/" + dec(view.cy, view.cyLo) + "/" + mag;
	if (X !== 1 || xm < 0 || view.rot || view.skew) cm += "/" + (xm < 0 ? -X : X) + "/" + (view.rot || 0) + "/" + (view.skew || 0);
	cmds.push(cm);

	cmds.push("float=y", "maxiter=" + Math.max(2, s.cap ?? FALLBACK_MAXIT), "inside=" + (s.paletteKey === "map" ? s.mapInside : 0));
	if (s.logmap !== 0) cmds.push("logmap=" + s.logmap);

	const lines: string[] = [];
	for (let i = 0, q = urlFromState(view, s).slice(1); i < q.length; i += LINE) lines.push("  ; mandeljs: " + q.slice(i, i + LINE));
	let row = "";
	for (const c of cmds) {
		if (row && row.length + 1 + c.length > LINE) { lines.push("  " + row); row = ""; }
		row += (row ? " " : "") + c;
	}
	lines.push("  " + row);
	lines.push(wrapped("colors=" + colorsFor(s)));
	return id + " {\n" + lines.join("\n") + "\n}\n" + frm;
}
