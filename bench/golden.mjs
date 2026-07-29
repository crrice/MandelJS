// bench/golden.mjs — the Node golden runner: for every window in goldens/p0-goldens.json,
// parse its URL with the SAME config schema the app uses, configure the SAME kernel the
// workers run, render the field single-threaded at the recorded cap, and compare the
// iteration total, classification tallies, and mu/de hashes bit-for-bit. Browserless
// regression net for the kernel + config layers (pixel hashes stay a browser check —
// they include the provisional overlay + level-snap paint paths).
//
//   npm run golden
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "../dist/node-lib.js";

const goldensPath = fileURLToPath(new URL("../goldens/p0-goldens.json", import.meta.url));
const goldens = JSON.parse(readFileSync(goldensPath, "utf8"));
// GOLDEN_UPDATE_DE=1: sanctioned deHash re-baseline mode (P3 defined the de side-channel
// as 0 on in-set returns, retiring the old stale-entry mask) — deHash mismatches become
// recorded updates; everything else still fails hard.
const UPDATE_DE = !!process.env.GOLDEN_UPDATE_DE;
const deUpdates = new Map();

function fnv1a(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, "0");
}

let failures = 0;
for (const g of goldens.windows) {
	const { state, rawView } = M.stateFromUrl(g.url);
	const W = g.w, H = g.h;
	const view = { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: rawView.span / (W / H) };

	// Formula: presets and custom both compile through the same path as the app; the
	// generated kernel set for this window's spec is assembled + installed like the app does.
	let formulaBody = null;
	const preset = M.PRESETS[state.formulaKey];
	const src = state.formulaKey === "custom" ? state.expr : preset && preset.formula;
	if (src) {
		const res = M.compileFormula(src);
		if (!res.ok) { console.error(g.name + ": formula failed to compile"); failures++; continue; }
		formulaBody = res.body;
	}
	const filterId = Number(state.filterId) || 0;
	M.installKernels(M.assembleAll({ usePeriod: true, formulaBody, filterId, juliaMode: state.juliaOn }).srcs);
	const k2 = formulaBody != null || state.juliaOn || filterId !== 0;
	const useDD = k2 ? false : M.useDDFor(view, W);
	const usePert = useDD;   // pert follows the DD gate (no overrides in the goldens)
	const frame = {
		usePeriod: true, periodEps2: M.periodEps2For(view, useDD), useDD, usePert,
		bandMap: 2,
		fractalMode: k2 ? 1 : 0, formulaId: formulaBody != null ? M.FORMULA_CUSTOM : 0, juliaMode: state.juliaOn, mSeedAtC: false,
		juliaCx: state.juliaX, juliaCy: state.juliaY,
		filterId, trapDStrands: Number(state.strands), filterDFactor: Number(state.exposure),
		filterBlend: Number(state.blend), filterDensity: 1,
		ssaaOn: false,   // the 1-sample first pass — what the goldens fingerprint
	};
	// Windows with node* baselines use them: transcendental Math (sin/exp/log) differs
	// between Chrome's and Node's V8 versions, so those windows gate against a Node-captured
	// reference (browser hashes stay the browser gate). Everything else is engine-identical.
	const ref = g.nodeIters != null
		? { maxIters: g.nodeMaxIters, iters: g.nodeIters, muHash: g.nodeMuHash, deHash: g.nodeDeHash, tallies: false }
		: { maxIters: g.maxIters, iters: g.iters, muHash: g.muHash, deHash: g.deHash, tallies: true };

	M.setFrameState(frame);
	if (k2 && !state.juliaOn && M.decideSeedAtC(view)) M.setFrameState({ ...frame, mSeedAtC: true });
	if (usePert) M.computeRef(view, ref.maxIters);
	M.resetTallies();

	const N = W * H;
	const out = new Uint32Array(N), mu = new Float32Array(N), de = new Float32Array(N);
	M.renderRegion(out, mu, de, W, 0, 0, W, H, W, H, view, ref.maxIters, new Uint32Array(2), 0, 1 / 32, true, 0);

	// deField is hashed RAW since P3 (the generated kernels define the in-set side-channel
	// as 0 — the old stale-entry mask is retired).
	const got = {
		iters: M.iterAcc, esc: M.escAcc, ins: M.inAcc, per: M.perAcc, cap: M.capAcc,
		muHash: fnv1a(new Uint8Array(mu.buffer)),
		deHash: fnv1a(new Uint8Array(de.buffer)),
	};
	const bad = [];
	if (got.iters !== ref.iters) bad.push("iters " + got.iters + " != " + ref.iters);
	if (ref.tallies && (got.esc !== g.esc || got.ins !== g.ins || got.per !== g.per || got.cap !== g.cap)) bad.push("tallies");
	if (got.muHash !== ref.muHash) bad.push("muHash " + got.muHash + " != " + ref.muHash);
	if (got.deHash !== ref.deHash) {
		if (UPDATE_DE) deUpdates.set(ref.deHash, got.deHash);
		else bad.push("deHash " + got.deHash + " != " + ref.deHash);
	}
	if (bad.length) { failures++; console.error("FAIL  " + g.name + ": " + bad.join(", ")); }
	else console.log("ok    " + g.name + "  (" + (ref.iters / 1e6).toFixed(1) + "M iters" + (ref.tallies ? "" : ", node baseline") + ")");
}
if (UPDATE_DE && deUpdates.size) {
	let text = readFileSync(goldensPath, "utf8");
	for (const [oldH, newH] of deUpdates) text = text.split('"' + oldH + '"').join('"' + newH + '"');
	writeFileSync(goldensPath, text);
	console.log("re-baselined " + deUpdates.size + " deHash value(s) in goldens/p0-goldens.json");
}
if (failures) { console.error(failures + " window(s) FAILED"); process.exit(1); }
console.log("all " + goldens.windows.length + " golden windows match (field-level; pixel hashes are a browser check)");
