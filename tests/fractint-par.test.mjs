// The Fractint .par container (conventions C1): entries, continuations, comments, raw
// frm: blocks and dialect detection, against the two sample pars and small synthetic files.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseParFile, parGet, parBlock, parFromState, stateFromUrl } from "../dist/node-lib.js";

const read = (name) => readFileSync(new URL("../par/" + name, import.meta.url), "utf8");

test("midgetbrot.par: one Fractint entry, continuations joined", () => {
	const f = parseParFile(read("midgetbrot.par"));
	assert.deepEqual(f.errors, []);
	assert.equal(f.entries.length, 1);
	assert.equal(f.blocks.length, 0);
	const e = f.entries[0];
	assert.equal(e.name, "Mandelbrot_Midget");
	assert.equal(e.dialect, "fractint");
	assert.equal(e.mandeljs, null);
	assert.deepEqual(e.comments, ["time=0:00:06.43--SF5 on a P200"]);
	const cm = parGet(e, "center-mag").split("/");
	assert.deepEqual(cm, ["-1.41538148141333100", "+0.00122318048670787", "4.017087e+012", "1", "-77.5", "0.00994833980292832848"]);
	assert.equal(parGet(e, "type"), "mandel");
	assert.equal(parGet(e, "reset"), "2004");
	assert.equal(parGet(e, "maxiter"), "1000");
	assert.equal(parGet(e, "mathtolerance"), "0.05/1");
	assert.equal(parGet(e, "colors").length, 256 * 3);
	assert.ok(parGet(e, "colors").endsWith("GMjGLiIIi"));
	assert.deepEqual(e.tokens.slice(0, 3).map((t) => t.key), ["reset", "type", "center-mag"]);
});

test("goldenerror.par: entry plus its frm: block, captured raw", () => {
	const f = parseParFile(read("goldenerror.par"));
	assert.deepEqual(f.errors, []);
	assert.equal(f.entries.length, 1);
	const e = f.entries[0];
	assert.equal(e.name, "The_Golden_Error");
	assert.equal(e.dialect, "fractint");
	assert.equal(parGet(e, "formulaname"), "MandAutoCritInZ");
	assert.equal(parGet(e, "FUNCTION"), "ident");
	assert.equal(parGet(e, "center-mag"), "-0.25347102601401180/-0.06584079426330404/1.505545e+010/1/72.5/0.00237908003330774415");
	assert.equal(parGet(e, "params"), "-1/1.68/1/1.4142/0/0/0/0");
	assert.equal(parGet(e, "logmap"), "538");
	assert.equal(parGet(e, "colors").length, 256 * 3);
	assert.equal(f.blocks.length, 1);
	const b = parBlock(f, "frm", "mandautocritinz");
	assert.equal(b.kind, "frm");
	assert.equal(b.name, "MandAutoCritInZ");
	assert.ok(b.body.startsWith("; Jim Muth\na=real(p1), b=imag(p1)"));
	assert.ok(b.body.includes("z=k*((a*(z^b))+(d*(z^f)))+c,"));
	assert.ok(b.body.trimEnd().endsWith("|z| < l"));
	assert.equal(parBlock(f, "frm", "Nope"), null);
});

test("continuation: only a backslash that is the LAST char, next line's leading blanks skipped", () => {
	const f = parseParFile("A {\r\n  x=12\\\r\n\t  34 y=5\\ \r\n z=6 ; c \\\n  w=7\n}\n");
	const e = f.entries[0];
	assert.equal(parGet(e, "x"), "1234");
	assert.equal(parGet(e, "y"), "5\\");
	assert.equal(parGet(e, "z"), "6");
	assert.equal(parGet(e, "w"), "7");
	assert.deepEqual(e.comments, ["c \\"]);
});

test("multi-entry files, bare tokens, last value wins, '}' inside a comment", () => {
	const f = parseParFile("; header\nOne { type=julia ; not } here\n  float=y maxiter=10 maxiter=20 }\nTwo{type=mandel}\nfrm:F { z=pixel:\n z=z*z+pixel, |z|<4 }\n");
	assert.deepEqual(f.entries.map((e) => e.name), ["One", "Two"]);
	assert.equal(parGet(f.entries[0], "maxiter"), "20");
	assert.equal(parGet(f.entries[1], "type"), "mandel");
	assert.deepEqual(f.blocks, [{ kind: "frm", name: "F", body: " z=pixel:\n z=z*z+pixel, |z|<4 " }]);
	const bare = parseParFile("B { reset nothing=1 }").entries[0];
	assert.deepEqual(bare.tokens, [{ key: "reset", value: null }, { key: "nothing", value: "1" }]);
	assert.equal(bare.dialect, "fractint");
	assert.equal(parseParFile("C { maxiter=5 }").entries[0].dialect, "unknown");
	assert.deepEqual(parseParFile("D { x=1\n").errors, ["\"D\": missing closing }"]);
});

test("MandelJS dialects: legacy parameter set and the ; mandeljs: line", () => {
	const { state, rawView } = stateFromUrl("?cx=-0.75&cy=0.1&span=2.5&f=z%5E3+%2B+c");
	const view = { cx: rawView.cx, cxLo: 0, cy: rawView.cy, cyLo: 0, spanX: rawView.span, spanY: 0 };
	const legacy = parseParFile(parFromState("My set", view, state)).entries[0];
	assert.equal(legacy.name, "My_set");
	assert.equal(legacy.dialect, "mandeljs");
	assert.ok(legacy.lines.includes("cx=-0.75"));
	assert.equal(parseParFile("X {\n  cx=1\n  cy=2\n  span=3\n}").entries[0].dialect, "mandeljs");
	const exp = parseParFile("E { ; mandeljs: cx=-0.5&cy=0&span=3\n  reset=2004 type=mandel\n}").entries[0];
	assert.equal(exp.dialect, "mandeljs");
	assert.equal(exp.mandeljs, "cx=-0.5&cy=0&span=3");
	assert.equal(parGet(exp, "type"), "mandel");
});
