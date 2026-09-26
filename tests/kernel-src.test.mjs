// Generated kernel source snapshot: a djb2 of every assembleAll(spec).srcs entry over a
// matrix of the existing KernelSpecs, pinned in goldens/kernel-src.json. New features bake
// in through NEW spec fields, so the source for every spec that exists today must never
// change — any drift here is a regression in the default path.
//
//   KERNEL_SRC_UPDATE=1 npm test   deliberately re-record goldens/kernel-src.json
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assembleAll, compileFormula, compileZ0, PRESETS } from "../dist/node-lib.js";

const snapPath = fileURLToPath(new URL("../goldens/kernel-src.json", import.meta.url));
const UPDATE = !!process.env.KERNEL_SRC_UPDATE;

function djb2(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16).padStart(8, "0");
}

// Formula axis: null = the z²+c fast path; everything else compiles like the app does.
const FORMULAS = {
	"mandel": null,
	"cubic": PRESETS.cubic.formula,
	"ship": PRESETS.ship.formula,
	"cosine": PRESETS.cosine.formula,
	"tierazon": "(z^2 + c) * sin(z^(c*i))",
	"z2c": "z^2 + c",
};

function snapshot() {
	const out = {};
	for (const usePeriod of [true, false]) {
		for (const [name, src] of Object.entries(FORMULAS)) {
			let formulaBody = null;
			if (src != null) {
				const res = compileFormula(src);
				assert.ok(res.ok, name + ": " + res.error);
				formulaBody = res.body;
			}
			for (const filterId of [0, 1]) {
				for (const juliaMode of [false, true]) {
					const label = "p" + (usePeriod ? 1 : 0) + "|" + name + "|t" + filterId + "|j" + (juliaMode ? 1 : 0);
					const { srcs } = assembleAll({ usePeriod, formulaBody, filterId, juliaMode });
					const row = {};
					for (const k of Object.keys(srcs)) row[k] = djb2(srcs[k]);
					out[label] = row;
				}
			}
		}
	}
	// Formula escape settings (Fractint counting): NEW labels only, the rows above unchanged.
	const ESC = {
		"b2c": { bailR: 2, seedC: true },
		"b10": { bailR: 10 },
		"b10z": { bailR: 10, z0Body: compileZ0("0.5231078513927684").body },
	};
	for (const usePeriod of [true, false]) {
		for (const name of ["mandel", "tierazon"]) {
			const formulaBody = FORMULAS[name] != null ? compileFormula(FORMULAS[name]).body : null;
			for (const filterId of [0, 1]) {
				for (const [escName, esc] of Object.entries(ESC)) {
					const label = "p" + (usePeriod ? 1 : 0) + "|" + name + "|t" + filterId + "|j0|" + escName;
					const { srcs } = assembleAll({ usePeriod, formulaBody, filterId, juliaMode: false, ...esc });
					const row = {};
					for (const k of Object.keys(srcs)) row[k] = djb2(srcs[k]);
					out[label] = row;
				}
			}
		}
	}
	// Fractint counting on a Julia (type=julia's count for z²+c, C8): NEW labels only.
	for (const usePeriod of [true, false]) {
		for (const name of ["mandel", "tierazon"]) {
			const formulaBody = FORMULAS[name] != null ? compileFormula(FORMULAS[name]).body : null;
			const label = "p" + (usePeriod ? 1 : 0) + "|" + name + "|t0|j1|b2";
			const { srcs } = assembleAll({ usePeriod, formulaBody, filterId: 0, juliaMode: true, bailR: 2 });
			const row = {};
			for (const k of Object.keys(srcs)) row[k] = djb2(srcs[k]);
			out[label] = row;
		}
	}
	return out;
}

test("generated kernel source is unchanged for every existing spec", () => {
	const now = snapshot();
	if (UPDATE) {
		writeFileSync(snapPath, JSON.stringify(now, null, "\t") + "\n");
		console.log("kernel-src: re-recorded " + Object.keys(now).length + " specs");
		return;
	}
	const pinned = JSON.parse(readFileSync(snapPath, "utf8"));
	assert.deepEqual(Object.keys(now), Object.keys(pinned));
	for (const label of Object.keys(pinned)) assert.deepEqual(now[label], pinned[label], label);
});
