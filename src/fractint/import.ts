// fractint/import.ts — a Fractint 20.04 par entry → MandelJS state. Every Fractint feature
// lands on an ordinary setting (the view affine, z₀, bailout, iteration cap, the map palette,
// discrete coloring, logmap …), so an imported par IS a permalink: the result feeds the same
// applier as a URL. The report lists each command as applied, approximated, ignored or
// unsupported; nothing is dropped silently.
//
// Scope (v1): type=mandel, julia and formula (the formula TRANSLATED into MandelJS syntax by
// frm-translate.ts, from the file's own frm: block). Other types are refused.
//---------------------------------------------------------------------------\\

import { AppState, RawView, defaultState, validSkew, MAP_DENSITY } from "../config";
import { ParEntry, ParFile, parGet, parBlock } from "./par";
import { decodeColors, parseLogmap, logmapTable, colorWrap } from "./colors";
import { translateFrm, fmtNum } from "./frm-translate";
import { ddFromDecimal } from "./decimal";

export type ParLevel = "applied" | "approximated" | "ignored" | "unsupported";
export interface ParNote { key: string; level: ParLevel; msg: string; }
// error: the entry was refused (state is then the defaults and rawView null).
export interface ParImport { state: AppState; rawView: RawView | null; report: ParNote[]; error?: string; }

// Commands that only steer how Fractint computes, not what the image is.
const NOTED: { [k: string]: string } = {
	passes: "MandelJS computes every pixel",
	periodicity: "MandelJS uses its own periodicity check",
	mathtolerance: "MandelJS picks its own precision (f64 / double-double / perturbation)",
	formulafile: "only frm: blocks in the loaded files are read",
	symmetry: "MandelJS computes every pixel",
	savename: "not used",
};
// Colouring and calculation modes with no MandelJS setting.
const UNSUPPORTED: { [k: string]: 1 } = {
	potential: 1, distest: 1, decomp: 1, biomorph: 1, finattract: 1, ranges: 1, invert: 1, fillcolor: 1,
	olddemmcolors: 1, logmode: 1, cyclerange: 1, orbitdelay: 1, orbitinterval: 1, initorbit: 1, usegrid: 1,
};
const INSIDE_MODES: { [k: string]: 1 } = {
	zmag: 1, bof60: 1, bof61: 1, epscross: 1, startrail: 1, period: 1, fmod: 1, atan: 1,
};

// params= as numbers; missing entries read as 0 (C1.4).
function numList(v: string | null): number[] {
	return v ? v.split("/").map((x) => { const n = parseFloat(x); return isFinite(n) ? n : 0; }) : [];
}

// A complex constant as formula.ts text (plain decimals, no exponent syntax).
function constText(re: number, im: number): string {
	const r = fmtNum(Math.abs(re)), i = fmtNum(Math.abs(im)) + "*i";
	if (im === 0) return (re < 0 ? "-" : "") + r;
	if (re === 0) return (im < 0 ? "-" : "") + i;
	return (re < 0 ? "-" : "") + r + (im < 0 ? " - " : " + ") + i;
}

// The Fractint window → the view. center-mag (C2.1/C2.2) or corners= (C2.3, converted back
// to center-mag, then C2.4's Xmag snap); Xmag's aspect goes into the frame aspect (square pixels), its sign into
// the view's mirror. Mag < 1e13 is Fractint's double path: the center is a correctly
// rounded double (C2.7); deeper, the decimal string's full precision is kept (lo limb).
function viewFrom(e: ParEntry, type: string, note: (key: string, level: ParLevel, msg: string) => void): { raw: RawView; aspect: string } | string {
	let cx: [number, number], cy: [number, number], mag: number, xmag = 1, rot = 0, skew = 0;
	const cm = parGet(e, "center-mag"), co = parGet(e, "corners");
	if (cm) {
		const f = cm.split("/");
		mag = parseFloat(f[2]);
		if (f.length < 3 || !(mag > 0)) return "center-mag=" + cm + ": needs Xctr/Yctr/Mag";
		xmag = parseFloat(f[3]) || 1;
		rot = parseFloat(f[4]) || 0;
		skew = parseFloat(f[5]) || 0;
		if (!validSkew(skew)) { note("center-mag", "unsupported", "skew " + f[5] + " is outside ±90°; using 0"); skew = 0; }
		const deep = Number(mag.toExponential(1).split("e")[1]) + 4 > 16;   // dec > DBL_DIG+1: the bignum path
		cx = deep ? ddFromDecimal(f[0]) : [parseFloat(f[0]), 0];
		cy = deep ? ddFromDecimal(f[1]) : [parseFloat(f[1]), 0];
		if (!isFinite(cx[0]) || !isFinite(cy[0])) return "center-mag=" + cm + ": bad center";
		note("center-mag", "applied", deep ? "deep center kept at double-double precision" : "center rounded to a double, as Fractint's double path does");
	} else if (co) {
		const c = co.split("/").map(parseFloat);
		if (c.length < 4 || c.some((x) => !isFinite(x))) return "corners=" + co + ": needs xmin/xmax/ymin/ymax[/x3rd/y3rd]";
		const [x0, x1, y0, y1] = c, x3 = c.length >= 6 ? c[4] : x0, y3 = c.length >= 6 ? c[5] : y0;
		// Frame edges from the bottom-left corner: U → bottom-right, V → top-left.
		const ux = x1 - x3, uy = y0 - y3, vx = x0 - x3, vy = y1 - y3;
		let w = Math.hypot(ux, uy), r = -Math.atan2(uy, ux);
		let p = vx * Math.cos(r) - vy * Math.sin(r), h = vx * Math.sin(r) + vy * Math.cos(r);
		if (h < 0) { w = -w; r += Math.PI; p = -p; h = -h; }   // a mirrored frame: negative Xmag
		if (!(h > 0) || w === 0) return "corners=" + co + ": empty window";
		cx = [(x0 + x1) / 2, 0]; cy = [(y0 + y1) / 2, 0];
		mag = 2 / h;
		xmag = (4 / 3) * h / w;
		rot = r * 180 / Math.PI || 0;   // no -0 (it would serialize)
		skew = Math.atan(p / h) * 180 / Math.PI || 0;
		note("corners", "applied", "converted to center-mag");
	} else {
		cx = [type === "mandel" ? -0.5 : 0, 0]; cy = [0, 0]; mag = 2 / 3;
		note("center-mag", "approximated", "no center-mag= or corners=: Fractint's default window");
	}
	// adjust_corner (C2.4): an Xmag within 2% of ±1 snaps to it, the frame rebuilt from Mag.
	if (Math.abs(xmag) !== 1 && Math.abs(Math.abs(xmag) - 1) <= 0.02) {
		xmag = Math.sign(xmag);
		note("center-mag", "applied", "Xmag within 2% of 1 snapped to " + xmag + ", as Fractint does");
	}
	const aspect = String(Number((4 / (3 * Math.abs(xmag))).toPrecision(8)));
	const raw: RawView = {
		cx: cx[0], cxLo: cx[1], cy: cy[0], cyLo: cy[1],
		span: 8 / (3 * mag * Math.abs(xmag)),   // the frame width: 2w of cvtcorners
		rot, skew, xmag: xmag < 0 ? -1 : 1,
	};
	return { raw, aspect };
}

// One Fractint entry (from parseParFile) → state + raw view + report. frm: blocks are looked
// up in the same file.
export function importFractint(file: ParFile, e: ParEntry): ParImport {
	const report: ParNote[] = [];
	const note = (key: string, level: ParLevel, msg: string): void => { report.push({ key, level, msg }); };
	const refuse = (error: string): ParImport => ({ state: defaultState(), rawView: null, report, error });
	const s = defaultState();

	const type = (parGet(e, "type") || "mandel").toLowerCase();
	if (type !== "mandel" && type !== "julia" && type !== "formula") return refuse("type=" + type + " is not supported (MandelJS imports mandel, julia and formula)");
	note("type", "applied", type);

	const reset = parGet(e, "reset");
	if (reset == null) note("reset", "approximated", "no reset=: read as reset=2004");
	else if (Number(reset) < 2004) note("reset", "approximated", "saved by release " + reset + "; read with 20.04 semantics");

	const view = viewFrom(e, type, note);
	if (typeof view === "string") return refuse(view);
	s.aspect = view.aspect;

	// Escape: Fractint counting (z₀ + bailout set) with the iteration cap at maxiter (C3.2).
	const params = numList(parGet(e, "params"));
	const bailout = parGet(e, "bailout");
	const rq = bailout != null ? Math.trunc(parseFloat(bailout)) : 4;   // rqlim is a long (cmdfiles.c)
	if (!(rq >= 1)) return refuse("bailout=" + bailout + ": must be at least 1");
	if (bailout != null && String(rq) !== bailout) note("bailout", "applied", "read as the integer " + rq + ", as Fractint does");
	const maxit = Math.round(Number(parGet(e, "maxiter") ?? "150"));
	if (!(maxit > 1)) return refuse("maxiter=" + parGet(e, "maxiter") + ": must be > 1");
	s.cap = maxit;
	if (type === "mandel") {
		const p = [params[0] || 0, params[1] || 0];
		s.z0 = p[0] || p[1] ? "c + (" + constText(p[0], p[1]) + ")" : "c";
		s.bail = Math.sqrt(rq);
	} else if (type === "julia") {
		s.juliaOn = true;
		s.juliaX = params[0] || 0;
		s.juliaY = params[1] || 0;
		s.bail = Math.sqrt(rq);
		note("type", "applied", "escape counts follow Fractint's julia convention (conventions C8)");
	} else {
		const name = parGet(e, "formulaname");
		if (!name) return refuse("type=formula needs formulaname=");
		const block = parBlock(file, "frm", name);
		if (!block) return refuse("formula " + name + " is not in this file (add its frm:" + name + " block, or load its .frm file with the par)");
		const fns = (parGet(e, "function") || "").split("/").filter((f) => f !== "");
		const t = translateFrm(block.body, params, fns);
		const levels: { [k: string]: ParLevel } = { info: "applied", warn: "approximated", unsupported: "unsupported" };
		for (const r of t.report) note("frm:" + name, levels[r.level], r.msg);
		if (t.formula === "") return refuse("formula " + name + " cannot be translated");
		s.formulaKey = "custom";
		s.expr = t.formula;
		s.z0 = t.z0;
		s.bail = t.bailout;
		if (bailout != null) note("bailout", "ignored", "a formula's bailout is its own test");
	}
	if ((parGet(e, "float") || "n")[0].toLowerCase() !== "y") note("float", "approximated", "rendered in floating point (Fractint would use integer math)");

	// Colour: the map palette, indexed by the integer count (discrete through the linear
	// transfer, no blending).
	s.discrete = true;
	s.coloring = "linear";
	s.palBlend = false;
	const logv = parGet(e, "logmap");
	if (logv != null) {
		const lf = parseLogmap(logv);
		if (lf == null) note("logmap", "ignored", "unreadable value " + logv);
		else {
			s.logmap = lf;
			if (lf === 2 || lf === -2) note("logmap", "approximated", "the automatic form is read as a fixed offset of " + lf);
		}
	}
	const insv = (parGet(e, "inside") ?? "1").toLowerCase();
	let inside = 1;
	if (insv === "maxiter" || insv === "-1") {
		const table = logmapTable(s.logmap, maxit);
		inside = table ? table[maxit] : colorWrap(maxit);   // inside = maxit, through logmap (C5.5)
	} else if (/^\d+$/.test(insv)) inside = colorWrap(Number(insv));
	else note("inside", "unsupported", "inside=" + insv + (INSIDE_MODES[insv] ? " is a colouring mode MandelJS lacks" : " is not understood") + "; using entry 1");
	const colors = parGet(e, "colors");
	if (colors != null) {
		const res = decodeColors(colors);
		if (res.ok) {
			s.paletteKey = "map";
			s.map = colors;
			s.mapInside = inside;
			s.density = String(MAP_DENSITY);
		} else note("colors", "unsupported", res.error + "; keeping the default palette");
	} else note("colors", "approximated", "no colors=: Fractint's default palette is not available, keeping the default palette");

	// Everything else, once per key.
	const handled: { [k: string]: 1 } = {
		type: 1, reset: 1, "center-mag": 1, corners: 1, params: 1, bailout: 1, maxiter: 1, formulaname: 1,
		function: 1, float: 1, logmap: 1, inside: 1, colors: 1,
	};
	const seen: { [k: string]: 1 } = {};
	for (const t of e.tokens) {
		const k = t.key.toLowerCase();
		if (handled[k] || seen[k]) continue;
		seen[k] = 1;
		if (k === "outside" && (t.value === "-1" || (t.value || "").toLowerCase() === "iter")) continue;
		if (k === "bailoutest" && (t.value || "").toLowerCase() === "mod") continue;
		if (NOTED[k]) note(k, "ignored", NOTED[k]);
		else if (UNSUPPORTED[k] || k === "outside" || k === "bailoutest") note(k, "unsupported", k + "=" + t.value + " has no MandelJS equivalent");
		else note(k, "ignored", "not read by the importer");
	}
	return { state: s, rawView: view.raw, report };
}
