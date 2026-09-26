// Fractint colour maps (conventions C5): colors= decode/encode, 6→8-bit expansion, the
// logmap table (golden spot values from C5.6) and the colour wrap.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseParFile, parGet, decodeColors, encodeColors, expand6, pal8FromPal6, parseLogmap, logmapTable, colorWrap } from "../dist/node-lib.js";

const colorsOf = (name) => parGet(parseParFile(readFileSync(new URL("../par/" + name, import.meta.url), "utf8")).entries[0], "colors");

test("both pars decode to 256 explicit entries and re-encode verbatim", () => {
	for (const name of ["midgetbrot.par", "goldenerror.par"]) {
		const s = colorsOf(name);
		const r = decodeColors(s);
		assert.ok(r.ok, name + ": " + r.error);
		assert.equal(r.count, 256, name);
		const pal8 = pal8FromPal6(r.pal6);
		assert.equal(encodeColors(pal8), s, name);
		const packed = encodeColors(pal8, true);
		assert.ok(packed.length <= s.length, name);
		assert.deepEqual(decodeColors(packed).pal6, r.pal6, name);
	}
	const g = decodeColors(colorsOf("goldenerror.par")).pal6;
	assert.deepEqual([...g.slice(0, 6)], [0, 0, 0, 14, 45, 11]);   // "000" "EhB"
});

test("alphabet and (v<<2)|(v>>4)", () => {
	const r = decodeColors("09AZ_`az0");
	assert.deepEqual([...r.pal6.slice(0, 9)], [0, 9, 10, 35, 36, 37, 38, 63, 0]);
	assert.equal(r.count, 3);
	assert.deepEqual([...r.pal6.slice(9, 12)], [40, 40, 40]);   // missing entries
	assert.equal(expand6(63), 255);
	assert.equal(expand6(32), 130);
	assert.equal(expand6(49), 199);
	assert.equal(expand6(0), 0);
});

test("<n> interpolation with Fractint's integer rounding", () => {
	const r = decodeColors("000<3>z0K");
	assert.ok(r.ok);
	assert.equal(r.count, 5);
	// R: 0 → 63 over spread 4: (c*63 + 2) div 4; G: equal ends copied; B: 0 → 20
	assert.deepEqual([...r.pal6.slice(0, 15)], [0, 0, 0, 16, 0, 5, 32, 0, 10, 47, 0, 15, 63, 0, 20]);
	assert.equal(encodeColors(pal8FromPal6(r.pal6).slice(0, 15), true), "000<3>z0K");
});

test("colors= errors", () => {
	for (const bad of ["<3>000000", "000<3>", "000<1>111", "000<2><2>111", "00", "00!", "000".repeat(257), "@default.map"]) {
		assert.equal(decodeColors(bad).ok, false, bad);
	}
	assert.equal(decodeColors("000".repeat(256)).ok, true);
});

test("logmap values", () => {
	assert.equal(parseLogmap("yes"), 1);
	assert.equal(parseLogmap("no"), 0);
	assert.equal(parseLogmap("old"), -1);
	assert.equal(parseLogmap("538"), 538);
	assert.equal(parseLogmap("-4"), -4);
	assert.equal(parseLogmap("x1"), null);
	assert.equal(logmapTable(0, 100), null);
});

test("golden logmap=538, maxit 3200 (C5.6)", () => {
	const t = logmapTable(538, 3200);
	assert.equal(t.length, 3201);
	for (const ci of [0, 1, 538, 539]) assert.equal(t[ci], 1, "citer " + ci);
	assert.equal(t[540], 2);
	assert.equal(t[702], 164);
	assert.equal(t[703], 165);
	assert.equal(t[3199], 254);
	assert.equal(t[3200], 255);
	for (let ci = 540; ci <= 702; ci++) assert.equal(t[ci], ci - 538);
	const pre = logmapTable(538, 3200, 256, 1960);
	assert.equal(pre[540], 3);
	assert.equal(pre[703], 165);
});

test("logmap old and sqrt forms", () => {
	const old = logmapTable(-1, 1000);
	const mlf = 255 / Math.log(1000);
	assert.equal(old[0], 1);
	assert.equal(old[1], 1);
	assert.equal(old[500], Math.floor(mlf * Math.log(500)) + 1);
	const sq = logmapTable(-10, 1000);
	const m2 = 254 / Math.sqrt(990);
	assert.equal(sq[10], 1);
	assert.equal(sq[11], 2);
	assert.equal(sq[20], 11);
	assert.equal(sq[600], Math.floor(m2 * Math.sqrt(590)) + 1);
	const yes = logmapTable(1, 1000);
	assert.equal(yes[0], 1);
	assert.equal(yes[1], 1);
	assert.equal(yes[2], 2);
});

test("colour wrap onto 1..255", () => {
	assert.equal(colorWrap(0), 0);
	assert.equal(colorWrap(255), 255);
	assert.equal(colorWrap(256), 1);
	assert.equal(colorWrap(510), 255);
	assert.equal(colorWrap(511), 1);
	assert.equal(colorWrap(20, 16), 5);
	assert.equal(colorWrap(9, 8), 1);
});
