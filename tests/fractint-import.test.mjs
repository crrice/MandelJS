// The Fractint par importer (fractint/import.ts) and the .par dispatcher: the two sample
// pars land on the expected ordinary settings, corners= agrees with center-mag, deep centers
// keep their decimal precision, and unsupported entries are refused with a reason.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	stateFromPar, compileFormula, compileZ0, logmapTable, colorWrap, viewFrame, ddFromDecimal, ddToDecimal,
	parFromState, parseParFile, parGet, parBlock, stateFromUrl, z0NeedsK2, escapeSpec,
} from "../dist/node-lib.js";

const read = (name) => readFileSync(new URL("../par/" + name, import.meta.url), "utf8");
const colorsOf = (text) => /colors=([\s\S]*?)\s*\}/.exec(text)[1].replace(/\\\r?\n\s*/g, "");

// The frame as plane vectors (math/frame.ts), spanY from the aspect as main.ts derives it.
function frameOf(raw, aspect) {
	return viewFrame({ cx: raw.cx, cxLo: raw.cxLo, cy: raw.cy, cyLo: raw.cyLo, spanX: raw.span, spanY: raw.span / Number(aspect), rot: raw.rot, skew: raw.skew, xmag: raw.xmag });
}

test("midgetbrot.par: mandel, rotated, map palette, Fractint counting", () => {
	const text = read("midgetbrot.par");
	const { state: s, rawView: v, report, error } = stateFromPar(text);
	assert.equal(error, undefined);
	assert.deepEqual(v, {
		cx: -1.415381481413331, cxLo: 0, cy: 0.00122318048670787, cyLo: 0,   // double path: centre rounded (C2.7)
		span: 8 / (3 * 4.017087e12), rot: -77.5, skew: 0.00994833980292832848, xmag: 1,
	});
	assert.equal(s.aspect, "1.3333333");
	assert.equal(s.formulaKey, "0");
	assert.equal(s.z0, "c");
	assert.equal(s.bail, 2);
	assert.equal(s.cap, 1000);
	assert.equal(s.paletteKey, "map");
	assert.equal(s.map, colorsOf(text));
	assert.equal(s.mapInside, 0);
	assert.equal(s.density, "255");
	assert.equal(s.logmap, 0);
	assert.equal(s.discrete, true);
	assert.equal(s.palBlend, false);
	assert.equal(s.coloring, "linear");
	assert.equal(s.aa, true);
	const keys = report.map((r) => r.key + ":" + r.level);
	assert.ok(keys.includes("periodicity:ignored"));
	assert.ok(keys.includes("mathtolerance:ignored"));
	assert.ok(!report.some((r) => r.level === "unsupported"));
});

test("goldenerror.par: formula translated from its frm: block, logmap", () => {
	const text = read("goldenerror.par");
	const { state: s, rawView: v, report, error } = stateFromPar(text);
	assert.equal(error, undefined);
	assert.equal(v.cx, -0.2534710260140118);
	assert.equal(v.cy, -0.06584079426330404);
	assert.equal(v.span, 8 / (3 * 1.505545e10));
	assert.equal(v.rot, 72.5);
	assert.equal(v.skew, 0.00237908003330774415);
	assert.equal(s.formulaKey, "custom");
	assert.equal(s.expr, "-(z^1.68) + z^1.4142 + c");
	assert.ok(compileFormula(s.expr).ok);
	assert.equal(s.z0, "0.5231078513927684");
	assert.ok(compileZ0(s.z0).ok);
	assert.equal(s.bail, 10);
	assert.equal(s.cap, 3200);
	assert.equal(s.logmap, 538);
	assert.equal(s.map, colorsOf(text));
	assert.equal(s.discrete, true);
	assert.equal(s.palBlend, false);
	const keys = report.map((r) => r.key + ":" + r.level);
	assert.ok(keys.includes("formulafile:ignored"));
	assert.ok(keys.includes("passes:ignored"));
	assert.ok(!report.some((r) => r.level === "unsupported"));
});

test("corners= (with a third corner) matches the same window as center-mag", () => {
	// cvtcorners (C2.2) of the midget's rotation/skew at a shallow Mag (deep corners carry
	// double-rounding noise that Fractint itself sees, C2.4).
	const X = -1.415381481413331, Y = 0.00122318048670787, mag = 1000, rot = -77.5, skew = 0.00994833980292832848;
	const h = 1 / mag, w = h / 0.75, t = Math.tan(skew * Math.PI / 180), R = rot * Math.PI / 180;
	const at = (x, y) => [x * Math.cos(R) + y * Math.sin(R) + X, -x * Math.sin(R) + y * Math.cos(R) + Y];
	const tl = at(-w + h * t, h), br = at(w - h * t, -h), bl = at(-w - h * t, -h);
	const cm = stateFromPar("A { reset=2004 type=mandel center-mag=" + [X, Y, mag, 1, rot, skew].join("/") + " }");
	const co = stateFromPar("B { reset=2004 type=mandel corners=" + [tl[0], br[0], br[1], tl[1], bl[0], bl[1]].join("/") + " }");
	assert.equal(co.error, undefined);
	assert.equal(co.state.aspect, "1.3333333");
	assert.ok(Math.abs(co.rawView.rot - rot) < 1e-6);
	assert.ok(Math.abs(co.rawView.skew - skew) < 1e-6);
	const a = frameOf(cm.rawView, cm.state.aspect), b = frameOf(co.rawView, co.state.aspect), span = cm.rawView.span;
	for (const k of ["ux", "uy", "vx", "vy"]) assert.ok(Math.abs(a[k] - b[k]) < 1e-6 * span, k);
	assert.ok(Math.abs(co.rawView.cx - X) < 1e-6 * span && Math.abs(co.rawView.cy - Y) < 1e-6 * span);
	// An axis-aligned 2:1 window: Xmag goes into the aspect, unrotated.
	const ax = stateFromPar("C { reset=2004 type=mandel corners=-2/2/-1/1 }");
	assert.equal(ax.state.aspect, "2");
	assert.deepEqual([ax.rawView.cx, ax.rawView.cy, ax.rawView.span, ax.rawView.rot, ax.rawView.skew, ax.rawView.xmag], [0, 0, 4, 0, 0, 1]);
});

test("deep center-mag (Mag >= 1e13) keeps the decimal centre as double-double", () => {
	const xs = "-1.41538148141333100123456789012345", ys = "+0.0012231804867078712345678901";
	const { rawView: v } = stateFromPar("D { reset=2004 type=mandel center-mag=" + xs + "/" + ys + "/4e20 }");
	assert.deepEqual([v.cx, v.cxLo], ddFromDecimal(xs));
	assert.deepEqual([v.cy, v.cyLo], ddFromDecimal(ys));
	assert.notEqual(v.cxLo, 0);
	assert.ok(ddToDecimal(v.cx, v.cxLo).startsWith("-1.4153814814133310012345678901"));
	assert.deepEqual(ddFromDecimal(ddToDecimal(v.cy, v.cyLo)), [v.cy, v.cyLo]);
	// Below 1e13 the same strings round to plain doubles.
	const s = stateFromPar("S { reset=2004 type=mandel center-mag=" + xs + "/" + ys + "/4e12 }").rawView;
	assert.deepEqual([s.cx, s.cxLo, s.cy, s.cyLo], [parseFloat(xs), 0, parseFloat(ys), 0]);
});

test("mandel params / bailout, julia, inside=maxiter through logmap", () => {
	const m = stateFromPar("M { reset=2004 type=mandel params=0.1/-0.2 bailout=16 maxiter=500 }").state;
	assert.equal(m.z0, "c + (0.1 - 0.2*i)");
	assert.ok(compileZ0(m.z0).ok);
	assert.equal(m.bail, 4);
	assert.equal(m.cap, 500);
	const j = stateFromPar("J { reset=2004 type=julia params=-0.8/0.156 center-mag=0/0/0.6667 }");
	assert.equal(j.state.juliaOn, true);
	assert.deepEqual([j.state.juliaX, j.state.juliaY, j.state.bail, j.state.z0, j.state.cap], [-0.8, 0.156, 2, "", 150]);
	assert.ok(j.report.some((r) => r.key === "type" && r.level === "applied" && /julia convention/.test(r.msg)));
	const map = "000zzz<253>000";
	const lm = stateFromPar("L { reset=2004 type=mandel maxiter=1000 inside=maxiter logmap=538 colors=" + map + " }").state;
	assert.equal(lm.mapInside, logmapTable(538, 1000)[1000]);
	assert.equal(stateFromPar("N { reset=2004 type=mandel maxiter=1000 inside=maxiter colors=" + map + " }").state.mapInside, colorWrap(1000));
	assert.equal(stateFromPar("I { reset=2004 type=mandel inside=7 colors=" + map + " }").state.mapInside, 7);
	// A numeric inside ≥ 256 wraps onto 1..255 as plot_pixel does (C5.8).
	assert.equal(stateFromPar("I { reset=2004 type=mandel inside=300 colors=" + map + " }").state.mapInside, 45);
	assert.equal(stateFromPar("I { reset=2004 type=mandel inside=256 colors=" + map + " }").state.mapInside, 1);
	// bailout= is an integer rqlim (fractional parts truncated), at least 1.
	assert.equal(stateFromPar("R { reset=2004 type=mandel bailout=4.5 }").state.bail, 2);
	assert.match(stateFromPar("R { reset=2004 type=mandel bailout=0.5 }").error, /at least 1/);
	// A skew outside ±90° cannot frame a window: reported, read as 0.
	const sk = stateFromPar("K { reset=2004 type=mandel center-mag=0/0/1/1/0/90 }");
	assert.equal(sk.rawView.skew, 0);
	assert.ok(sk.report.some((r) => r.key === "center-mag" && r.level === "unsupported"));
	const bof = stateFromPar("B { reset=2004 type=mandel inside=bof60 outside=real potential=255/2000/0 }").report;
	assert.deepEqual(bof.filter((r) => r.level === "unsupported").map((r) => r.key), ["inside", "outside", "potential"]);
});

test("refusals and warnings: unsupported type, missing frm block, missing reset=", () => {
	const ly = stateFromPar("L { reset=2004 type=lyapunov }");
	assert.match(ly.error, /type=lyapunov is not supported/);
	assert.equal(ly.rawView, null);
	const nf = stateFromPar("F { reset=2004 type=formula formulaname=Nope }");
	assert.match(nf.error, /Nope is not in this file/);
	const ok = stateFromPar("F { type=formula formulaname=Sq }\nfrm:Sq { z=pixel: z=sqr(z)+pixel, |z|<4 }");
	assert.equal(ok.error, undefined);
	assert.equal(ok.state.expr, "z^2 + c");
	assert.equal(ok.state.z0, "c");
	assert.equal(ok.state.bail, 2);
	assert.ok(ok.report.some((r) => r.key === "reset" && r.level === "approximated"));
	// A symmetry suffix on the block header is not part of its name; comments may hold braces.
	const sym = stateFromPar("F { type=formula formulaname=Sq }\nfrm:Sq(XAXIS) { ; note {x}\n z=pixel: z=sqr(z)+pixel, |z|<4 }");
	assert.equal(sym.error, undefined);
	assert.equal(sym.state.expr, "z^2 + c");
	const bad = stateFromPar("F { reset=2004 type=formula formulaname=If }\nfrm:If { z=0: if(z<1) z=z*z+pixel endif, |z|<4 }");
	assert.match(bad.error, /cannot be translated/);
	assert.ok(bad.report.some((r) => r.level === "unsupported"));
});

test("multi-entry files: pick an entry by name; the ; mandeljs: line wins over the Fractint part", () => {
	const text = "A { reset=2004 type=mandel maxiter=100 }\nB { reset=2004 type=mandel maxiter=200 }\n";
	assert.equal(stateFromPar(text).state.cap, 100);
	assert.equal(stateFromPar(text, "b").state.cap, 200);
	const both = stateFromPar("E {\n  ; mandeljs: cx=-0.5&cy=0&span=3&cap=77\n  reset=2004 type=mandel maxiter=100\n}");
	assert.equal(both.state.cap, 77);
	assert.equal(both.state.discrete, false);
	assert.deepEqual(both.report, []);
});

test("export: Fractint-safe names, the engine's escape radius, the heuristic seed", () => {
	const par = (qs, name = "t", seedAtC = false) => {
		const { state, rawView } = stateFromUrl(qs);
		const view = { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: 0 };
		return parseParFile(parFromState(name, view, state, seedAtC));
	};
	// Names: [A-Za-z0-9_.-] only, at most 18 characters (ITEMNAMELEN), entry and formula alike.
	const named = par("?cx=0&cy=0&span=4&f=cubic", "A long (name); {x}");
	assert.equal(named.entries[0].name, "A_long__name____x_");
	assert.equal(parGet(named.entries[0], "formulaname"), "A_long__name____x_");
	assert.ok(parBlock(named, "frm", "A_long__name____x_"));
	assert.equal(par("?cx=0&cy=0&span=4", "A_long_descriptive_name").entries[0].name, "A_long_descriptive");
	// The radius the engine escapes at: 16 on Kernel 1, 2 on Kernel 2, else the bailout.
	const rq = (qs) => parGet(par(qs).entries[0], "bailout");
	assert.equal(rq("?cx=0&cy=0&span=4"), "256");
	assert.equal(rq("?cx=0&cy=0&span=4&z0=c"), "256");
	assert.equal(rq("?cx=0&cy=0&span=4&z0=c&bail=2"), null);
	assert.equal(rq("?cx=0&cy=0&span=4&j=1&jx=-0.8&jy=0.156"), null);
	assert.equal(rq("?cx=0&cy=0&span=4&bail=3"), "9");
	assert.match(par("?cx=0&cy=0&span=4&z0=0").blocks[0].body, /\|z\| < 256/);
	assert.match(par("?cx=0&cy=0&span=4&f=cubic").blocks[0].body, /\|z\| < 4/);
	// A blank z₀ writes the seed the renderer used (z₀ = c for a formula singular at 0).
	const inv = "?cx=0&cy=0&span=4&f=custom&expr=1%2Fz+%2B+c";
	assert.match(par(inv).blocks[0].body, /^z=0:/m);
	assert.match(par(inv, "t", true).blocks[0].body, /^z=pixel:/m);
});

test("z₀ = c under a radius below 2 runs on Kernel 2; skew stays inside ±90°", () => {
	assert.equal(z0NeedsK2("c"), false);
	assert.equal(z0NeedsK2("c", 2), false);
	assert.equal(z0NeedsK2("c", 1), true);
	assert.equal(z0NeedsK2("0", 1), false);
	assert.deepEqual(escapeSpec("c", 1, true, false), { bailR: 1, z0Body: compileZ0("c").body });
	assert.equal(stateFromUrl("?cx=0&cy=0&span=4&skew=90").rawView.skew, 0);
	assert.equal(stateFromUrl("?cx=0&cy=0&span=4&skew=-1e300").rawView.skew, 0);
	assert.equal(stateFromUrl("?cx=0&cy=0&span=4&skew=89.5").rawView.skew, 89.5);
});
