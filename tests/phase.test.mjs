// The phase-machine transition table (pure decideNext) — the P2 invariants as tests.
import test from "node:test";
import assert from "node:assert/strict";
import { decideNext } from "../dist/node-lib.js";

const FF = { kind: "firstFrame" };
const pert = (stage) => ({ kind: "sharpen", sub: "pert", stage });
const dd = (stage) => ({ kind: "sharpen", sub: "dd", stage });

test("no capped pixels -> ssaa", () => {
	assert.deepEqual(decideNext({ phase: FF, capped: 0, prev: 0, stageMs: 10, maxIters: 1000 }), { action: "ssaa" });
});
test("first frame with capped -> first sharpen stage at x10", () => {
	assert.deepEqual(decideNext({ phase: FF, capped: 500, prev: 0, stageMs: 10, maxIters: 20000 }),
		{ action: "sharpen", sub: "dd", cap: 200000, stage: 1 });
});
test("pert productive below ceiling -> escalate pert", () => {
	assert.deepEqual(decideNext({ phase: pert(1), capped: 50, prev: 100, stageMs: 10, maxIters: 60000 }),
		{ action: "sharpen", sub: "pert", cap: 600000, stage: 2 });
});
test("pert escalation clamps at the reference-orbit ceiling", () => {
	assert.deepEqual(decideNext({ phase: pert(2), capped: 50, prev: 100, stageMs: 10, maxIters: 600000 }),
		{ action: "sharpen", sub: "pert", cap: 1000000, stage: 3 });
});
test("pert unproductive -> handoff to dd at the SAME cap and stage", () => {
	assert.deepEqual(decideNext({ phase: pert(3), capped: 995, prev: 1000, stageMs: 10, maxIters: 600000 }),
		{ action: "sharpen", sub: "dd", cap: 600000, stage: 3 });
});
test("pert at the ceiling -> handoff even when productive (no cheap clause)", () => {
	assert.deepEqual(decideNext({ phase: pert(3), capped: 10, prev: 1000, stageMs: 10, maxIters: 1000000 }),
		{ action: "sharpen", sub: "dd", cap: 1000000, stage: 3 });
});
test("dd unproductive but cheap -> free tickle, keep going", () => {
	assert.deepEqual(decideNext({ phase: dd(2), capped: 999, prev: 1000, stageMs: 50, maxIters: 100000 }),
		{ action: "sharpen", sub: "dd", cap: 1000000, stage: 3 });
});
test("dd unproductive and slow -> stop (ssaa)", () => {
	assert.deepEqual(decideNext({ phase: dd(2), capped: 999, prev: 1000, stageMs: 500, maxIters: 100000 }), { action: "ssaa" });
});
test("dd productive though slow -> keep going", () => {
	assert.deepEqual(decideNext({ phase: dd(2), capped: 500, prev: 1000, stageMs: 5000, maxIters: 100000 }),
		{ action: "sharpen", sub: "dd", cap: 1000000, stage: 3 });
});
test("dd at the precision ceiling -> stop", () => {
	assert.deepEqual(decideNext({ phase: dd(8), capped: 10, prev: 1000, stageMs: 50, maxIters: 100000000 }), { action: "ssaa" });
});
