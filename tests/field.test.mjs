// FieldStore scans + BufferSink on synthetic fields.
import test from "node:test";
import assert from "node:assert/strict";
import { FieldStore, CAPPED, BufferSink } from "../dist/node-lib.js";

test("scanCapped finds capped pixels, LPT-ordered", () => {
	const f = new FieldStore();
	f.resize(40, 20);
	f.mu.fill(1);
	// tile (0,0): 2 capped; tile (20,0): 5 capped
	f.mu[0] = CAPPED; f.mu[41] = CAPPED;
	for (let i = 0; i < 5; i++) f.mu[i * 40 + 25] = CAPPED;
	const { count, tiles } = f.scanCapped(20, 20);
	assert.equal(count, 7);
	assert.equal(tiles.length, 2);
	assert.equal(tiles[0].idx.length, 5);   // hardest tile first
	assert.equal(tiles[0].ox, 20);
	assert.equal(tiles[1].idx.length, 2);
});

test("computeLevels: uniform ramp classifies and levels sanely", () => {
	const f = new FieldStore();
	f.resize(40, 20);
	for (let i = 0; i < f.mu.length; i++) f.mu[i] = (i % 100) + 1;
	f.mu[3] = CAPPED; f.mu[7] = Infinity;
	const lv = f.computeLevels();
	assert.equal(lv.esc, 40 * 20 - 2);
	assert.equal(lv.cap, 1);
	assert.equal(lv.ins, 1);
	assert.ok(lv.muLo >= 1 && lv.muLo <= 5);
	assert.ok(lv.muHi >= 95 && lv.muHi <= 100);
	assert.ok(lv.p50 > 0 && lv.p90 >= lv.p50);
});

test("scanEdges flags the boundary columns via the color callback", () => {
	const f = new FieldStore();
	f.resize(40, 20);
	for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) f.mu[y * 40 + x] = x < 20 ? 10 : 200;
	const colorOf = (mu) => (mu > 100 ? 0xffffffff : 0xff000000);
	const { count, tiles } = f.scanEdges(colorOf, 30, 20, 20);
	assert.equal(count, 40);          // two boundary columns × 20 rows
	assert.equal(tiles.length, 2);    // one column in each tile
});

test("updatePoints resolves capped cells and grows muMax", () => {
	const f = new FieldStore();
	f.resize(20, 20);
	f.mu.fill(CAPPED);
	const idx = Int32Array.from([0, 1, 2]);
	const { resolvedIdx } = f.updatePoints(0, 0, 20, idx, Float32Array.from([42, CAPPED, 7]), Float32Array.from([0, 0, 0]));
	assert.deepEqual(resolvedIdx, [0, 2]);
	assert.equal(f.mu[0], 42);
	assert.equal(f.mu[1], CAPPED);
	assert.equal(f.muMax, 42);
});

test("BufferSink blit + edit round-trip", () => {
	const s = new BufferSink(8, 8);
	const tile = new Uint32Array([1, 2, 3, 4]);
	s.blitTile(tile.buffer, 2, 2, 2, 2);
	assert.equal(s.frame[2 * 8 + 2], 1);
	assert.equal(s.frame[3 * 8 + 3], 4);
	const edit = s.editTile(2, 2, 2, 2);
	assert.deepEqual(Array.from(edit.data32), [1, 2, 3, 4]);
	edit.data32[0] = 99;
	edit.commit();
	assert.equal(s.frame[2 * 8 + 2], 99);
});
