// bench/par-golden.mjs — the par golden runner: for every entry in goldens/par-goldens.json,
// import the .par through the app's importer (config.stateFromPar → the Fractint importer),
// render the whole frame through the headless engine (src/render/headless.ts) with AA off,
// and compare the iteration total, classification tallies and the mu/de/pixel hashes bit-
// for-bit. Regression net for the Fractint path end to end: importer → view affine (rotation)
// → z₀/bailout counting kernels (K1 seed c + pert; K2 translated formula) → logmap + map
// palette index coloring. Node baselines (transcendental Math is V8-version-specific).
// Rows are spread across worker_threads (goldenerror: ~0.4G iterations of two complex pow);
// the result is worker-count-independent.
//
//   npm run golden:par
//   PAR_GOLDEN_UPDATE=1 npm run golden:par   sanctioned re-baseline: record the measured values
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPar, renderGrid } from "./par-render.mjs";

const goldensPath = fileURLToPath(new URL("../goldens/par-goldens.json", import.meta.url));
const goldens = JSON.parse(readFileSync(goldensPath, "utf8"));
const UPDATE = !!process.env.PAR_GOLDEN_UPDATE;
const root = new URL("../", import.meta.url);

function fnv1a(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, "0");
}

function range(n) {
	return Array.from({ length: n }, (_, i) => i);
}

let failures = 0;
for (const g of goldens.pars) {
	const { state, rawView } = loadPar(fileURLToPath(new URL(g.par, root)), g.entry);
	const r = await renderGrid(state, rawView, g.w, g.h, range(g.w), range(g.h));
	const got = {
		maxIters: r.maxIters, iters: r.iters, esc: r.esc, ins: r.ins, per: r.per, cap: r.cap,
		muHash: fnv1a(new Uint8Array(r.mu.buffer)),
		deHash: fnv1a(new Uint8Array(r.de.buffer)),
		pixHash: fnv1a(new Uint8Array(r.out.buffer)),
	};
	const bad = [];
	for (const k of Object.keys(got)) if (got[k] !== g[k]) bad.push(k + " " + got[k] + " != " + g[k]);
	if (UPDATE) Object.assign(g, got);
	const line = g.par + "  " + g.w + "x" + g.h + "  (" + (r.iters / 1e6).toFixed(1) + "M iters, " + (r.ms / 1000).toFixed(1) + "s)";
	if (bad.length && !UPDATE) { failures++; console.error("FAIL  " + line + ": " + bad.join(", ")); }
	else console.log((bad.length ? "rec   " : "ok    ") + line);
}
if (UPDATE) {
	writeFileSync(goldensPath, "{\n\t\"note\": " + JSON.stringify(goldens.note) + ",\n\t\"pars\": [\n" + goldens.pars.map(p => "\t\t" + JSON.stringify(p)).join(",\n") + "\n\t]\n}\n");   // one row per par
	console.log("recorded goldens/par-goldens.json");
}
if (failures) { console.error(failures + " par(s) FAILED"); process.exit(1); }
console.log("all " + goldens.pars.length + " par goldens match (field + pixel level, Node baseline)");
