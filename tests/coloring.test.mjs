// The independent coloring toggles (discrete counts, palette blending, anti-aliasing, the
// Fractint logmap transfer, the map palette): their URL rows, the palette bakes, the one
// colorSample transfer, and the exact Fractint path (conventions C5.5–C5.9) end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../dist/node-lib.js";

const INK = [231, 231, 226], PAPER = [14, 15, 18];
const OFF = { discrete: false, logTable: null, mapLut: null };

function parColors(file) {
	const f = M.parseParFile(readFileSync(new URL("../par/" + file, import.meta.url), "utf8"));
	return M.parGet(f.entries[0], "colors");
}
const MIDGET = parColors("midgetbrot.par"), GOLDEN = parColors("goldenerror.par");

function viewOf(raw) {
	return { cx: raw.cx, cxLo: raw.cxLo, cy: raw.cy, cyLo: raw.cyLo, spanX: raw.span, spanY: 0, rot: raw.rot, skew: raw.skew, xmag: raw.xmag };
}

// A plain escape-time colorSample call (cyclic, levels unused).
function sample(mu, lut, inSet, densityMul) {
	return M.colorSample(mu, 0, lut, inSet, 0, true, densityMul, 1, 2, 0, 1);
}

test("defaults write no new URL rows; every toggle round-trips", () => {
	const base = "?cx=-1&cy=0&span=4";
	const { state } = M.stateFromUrl(base);
	assert.equal(state.discrete, false); assert.equal(state.logmap, 0);
	assert.equal(state.palBlend, true); assert.equal(state.aa, true);
	assert.equal(state.map, ""); assert.equal(state.mapInside, 0);
	const view = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 2 };
	assert.equal(M.urlFromState(view, state), base);
	for (const qs of [
		base + "&disc=1",
		base + "&lm=538",
		base + "&lm=-1&pb=0",
		base + "&aa=0",
		base + "&col=linear&disc=1&lm=2&pb=0&aa=0&cap=3200",
	]) {
		const r = M.stateFromUrl(qs);
		assert.equal(M.urlFromState(viewOf(r.rawView), r.state), qs);
	}
	assert.equal(M.stateFromUrl(base + "&lm=abc").state.logmap, 0);
});

test("the map palette travels verbatim (with its inside entry); a bad map is ignored", () => {
	const qs = "?cx=-1&cy=0&span=4&pal=map&map=" + encodeURIComponent(GOLDEN).replace(/%20/g, "+") + "&mapin=5&dens=64&disc=1";
	const { state, rawView } = M.stateFromUrl(qs);
	assert.equal(state.paletteKey, "map");
	assert.equal(state.map, GOLDEN);
	assert.equal(state.mapInside, 5);
	assert.equal(state.density, "64");
	const back = M.urlFromState(viewOf(rawView), state);
	assert.equal(back, "?" + new URLSearchParams(qs).toString());
	assert.equal(M.stateFromUrl(back).state.map, GOLDEN);
	// Default density for the map (255) is omitted.
	const d = M.stateFromUrl("?cx=0&cy=0&span=4&pal=map&map=" + encodeURIComponent(MIDGET));
	assert.equal(d.state.density, String(M.MAP_DENSITY));
	assert.ok(!M.urlFromState(viewOf(d.rawView), d.state).includes("dens="));
	// A map that does not decode leaves the default palette.
	assert.equal(M.stateFromUrl("?pal=map&map=@default.map").state.paletteKey, "escape");
	assert.equal(M.stateFromUrl("?pal=map").state.paletteKey, "escape");
	// The legacy .par dialect carries the map through the same rows.
	const par = M.parFromState("m", viewOf(rawView), state);
	const rt = M.stateFromPar(par);
	assert.equal(M.urlFromState(viewOf(rt.rawView), rt.state), back);
});

test("blending on is today's LUT; off holds the nearest stop", () => {
	const hexes = ["#180a04", "#6e1a10", "#c9420a", "#f5911d", "#ffd98a"];
	const p = M.customPalette(hexes, "#000000", true, 32);
	assert.deepEqual(p.build(INK, PAPER, true, true).lut, p.build(INK, PAPER, true).lut);
	const stopSet = new Set(hexes.map((h) => {
		const n = parseInt(h.slice(1), 16);
		return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255)) >>> 0;
	}));
	const off = p.build(INK, PAPER, true, false).lut;
	for (const c of off) assert.ok(stopSet.has(c));
	assert.equal(new Set(off).size, hexes.length);
	// Procedural palettes hold their curve at the nominal stops.
	for (const key of ["escape", "subtle"]) {
		const pal = M.PALETTES[key];
		assert.deepEqual(pal.build(INK, PAPER, pal.cyclic, true).lut, pal.build(INK, PAPER, pal.cyclic).lut);
		assert.ok(new Set(pal.build(INK, PAPER, pal.cyclic, false).lut).size <= 17, key);
	}
});

test("map palette: exact 256 entries, inside entry, gradient over 1..255", () => {
	const pal6 = M.decodeColors(MIDGET).pal6, pal8 = M.pal8FromPal6(pal6);
	const pack = (i) => ((255 << 24) | (pal8[i * 3 + 2] << 16) | (pal8[i * 3 + 1] << 8) | pal8[i * 3]) >>> 0;
	const b = M.mapPalette(MIDGET, 0, M.MAP_DENSITY).build(INK, PAPER, true, false);
	for (let i = 0; i < 256; i++) assert.equal(b.map[i], pack(i));
	assert.equal(b.inSet, pack(0));
	assert.equal(M.mapPalette(MIDGET, 7, M.MAP_DENSITY).build(INK, PAPER, true).inSet, pack(7));
	// Unblended gradient: cycle position k/255 is entry k (0 ≡ 255).
	for (const k of [1, 2, 100, 254]) assert.equal(b.lut[Math.round((k / 255) * 1023)], pack(k));
	assert.equal(b.lut[0], pack(255));
	assert.equal(M.mapPalette("@x.map", 0, 255), null);
	// A palette sampled as a map reads back as that palette (to 6-bit precision).
	const esc = M.PALETTES.escape.build(INK, PAPER, true);
	const m = M.mapPalette(M.mapColorsFrom(esc.lut, esc.inSet), 0, 255).build(INK, PAPER, true);
	for (const k of [1, 64, 128, 254]) {
		const want = esc.lut[Math.round((k / 255) * 1023)], got = m.map[k];
		for (let sh = 0; sh < 24; sh += 8) assert.ok(Math.abs(((want >> sh) & 255) - ((got >> sh) & 255)) <= 3);
	}
});

test("discrete: the integer count picks the color (density = iterations per cycle)", () => {
	const { lut, inSet } = M.PALETTES.escape.build(INK, PAPER, true);
	const dm = 1 / 32;
	const pos = (g) => { let t = g * dm; t -= t | 0; return lut[(t * 1023) | 0]; };
	M.setIndexState(OFF);
	assert.notEqual(sample(5.2, lut, inSet, dm), sample(5.9, lut, inSet, dm));   // smooth by default
	M.setIndexState({ discrete: true, logTable: null, mapLut: null });
	assert.equal(sample(5.2, lut, inSet, dm), sample(5.9, lut, inSet, dm));
	assert.equal(sample(5.9, lut, inSet, dm), pos(5));
	assert.equal(sample(0.4, lut, inSet, dm), pos(1));   // an escaper's count 0 reads 1
	assert.equal(sample(Infinity, lut, inSet, dm), inSet);
	// logmap replaces the count: table[min(count, maxit)].
	const table = M.logmapTable(538, 3200);
	M.setIndexState({ discrete: true, logTable: table, mapLut: null });
	assert.equal(sample(702.5, lut, inSet, dm), pos(164));
	assert.equal(sample(9999, lut, inSet, dm), sample(3200, lut, inSet, dm));
	// Smooth logmap interpolates between table entries.
	M.setIndexState({ discrete: false, logTable: table, mapLut: null });
	assert.equal(sample(702.5, lut, inSet, dm), pos(164.5));
	M.setIndexState(OFF);
});

// calcmandfp (C3.2): z₀ = 0, step then test |z|² ≥ rqlim; count k in 1..maxit−1, maxit = inside.
function calcmandfp(cr, ci, maxit, rqlim) {
	let x = 0, y = 0;
	for (let k = 1; k < maxit; k++) {
		const x2 = x * x, y2 = y * y;
		y = 2 * x * y + ci; x = x2 - y2 + cr;
		if (x * x + y * y >= rqlim) return k;
	}
	return maxit;
}

test("discrete + map + blend off reproduces Fractint: pal8[wrap(logmap[count])], inside = entry 0", () => {
	const W = 64, H = 48, maxit = 3200;
	const view = { cx: -0.7453, cxLo: 0, cy: 0.1127, cyLo: 0, spanX: 0.02, spanY: 0.015 };
	M.installKernels(M.assembleAll({ usePeriod: false, formulaBody: null, filterId: 0, juliaMode: false, ...M.escapeSpec("0", 2, false, false) }).srcs);
	M.setFrameState({ usePeriod: false, periodEps2: M.PERIOD_EPS2, useDD: false, usePert: false, bandMap: 2, ssaaOn: false });
	const b = M.mapPalette(GOLDEN, 0, M.MAP_DENSITY).build(INK, PAPER, true, false);
	const pal8 = M.pal8FromPal6(M.decodeColors(GOLDEN).pal6);
	const rgb = (i) => ((255 << 24) | (pal8[i * 3 + 2] << 16) | (pal8[i * 3 + 1] << 8) | pal8[i * 3]) >>> 0;
	// With logmap=538, and without (raw counts past 255 exercise the wrap).
	for (const table of [M.logmapTable(538, maxit), null]) {
		M.setIndexState({ discrete: true, logTable: table, mapLut: b.map });
		const out = new Uint32Array(W * H), mu = new Float32Array(W * H), de = new Float32Array(W * H);
		M.renderRegion(out, mu, de, W, 0, 0, W, H, W, H, view, maxit, b.lut, b.inSet, 1 / 255, true, 0);
		let escaped = 0, inside = 0, wrapped = 0;
		for (let py = 0; py < H; py++) {
			for (let px = 0; px < W; px++) {
				const cr = view.cx + ((px + 0.5) / W - 0.5) * view.spanX, ci = view.cy + (0.5 - (py + 0.5) / H) * view.spanY;
				const count = calcmandfp(cr, ci, maxit, 4);
				const p = py * W + px;
				const idx = table ? table[Math.min(count, maxit)] : count;
				const want = count === maxit ? rgb(0) : rgb(M.colorWrap(idx));
				assert.equal(out[p], want, "px " + px + "," + py + " count " + count);
				// Instant recolor from the stored Float32 field gives the same color.
				assert.equal(sample(mu[p], b.lut, b.inSet, 1 / 255), want);
				if (count === maxit) inside++; else escaped++;
				if (count < maxit && idx > 255) wrapped++;
			}
		}
		assert.ok(escaped > 100 && inside > 0);
		if (!table) assert.ok(wrapped > 0);
	}
	M.setIndexState(OFF);
});

test("anti-aliasing off (aa=0) renders 1 sample per pixel, like --noaa", () => {
	const dir = mkdtempSync(join(tmpdir(), "mandeljs-aa-"));
	const script = fileURLToPath(new URL("../render.mjs", import.meta.url));
	const q = "?cx=-0.75&cy=0.1&span=0.5&disc=1&pb=0";
	const run = (query, out, extra) => {
		execFileSync(process.execPath, [script, query, join(dir, out), "--size", "64x32", "--iters", "400", ...extra]);
		return readFileSync(join(dir, out));
	};
	const off = run(q + "&aa=0", "a.png", []);
	assert.deepEqual(off, run(q, "b.png", ["--noaa"]));
	assert.notDeepEqual(off, run(q, "c.png", []));
});
