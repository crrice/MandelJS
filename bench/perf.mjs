// bench/perf.mjs — the standing perf CLI: deterministic kernel workloads timed min-of-7
// against a committed, machine-keyed baseline (bench/baselines.json). A perf run is also
// a correctness run — every workload's iteration total + classification tallies are
// asserted EXACTLY against the recorded expects (machine-independent), so drift in the
// compute shows up here even when no golden window covers the exercised path.
//
//   npm run bench                     compare against this machine's baseline
//   node bench/perf.mjs --update      write/refresh this machine's times (expects created if
//                                     absent). Direct invocation: PowerShell/npm drops flags
//                                     passed via `npm run bench -- --update`. Build first.
//   node bench/perf.mjs --rebaseline  sanctioned correctness re-baseline: rewrite expects too
//
// Method (per the perf-measurement doctrine): deterministic inputs, single-threaded Node,
// min-of-7 wall times per workload (min absorbs JIT warmup + scheduler noise), iteration
// counts as the correctness signal. Browser wall-clock stays out of scope — noisy.
// Workloads render the SAME windows the goldens pin, at bench-sized grids (identical
// complex window, fewer samples), each forcing one kernel path:
//   f64         seahorse — the heavy-periodicity f64 staple
//   dd          dd-baseline window through the pure exact-DD kernel (usePert off)
//   pert        dd-baseline window through the perturbation kernel (ref orbit prebuilt)
//   k2-formula  tierazon transcendental compiled formula (Kernel 2, Julia seed)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname, cpus } from "node:os";
import { performance } from "node:perf_hooks";
import * as M from "../dist/node-lib.js";

const RUNS = 7;
const WARN_PCT = 15;

const baselinePath = fileURLToPath(new URL("./baselines.json", import.meta.url));
const UPDATE = process.argv.includes("--update");
const REBASELINE = process.argv.includes("--rebaseline");

// Each workload: the golden window's URL (same complex window), a bench grid + cap sized
// for ~0.5–2s runs, and the forced kernel path. Grid aspect matches the golden canvas so
// spanY derives identically (W/H is what the URL restore uses).
const WORKLOADS = [
	{
		name: "f64", url: "?cx=-0.743643887037151&cy=0.13182590420533&span=0.000001",
		w: 320, h: 160, maxIters: 14159, path: "f64",
	},
	{
		name: "dd", url: "?cx=-0.7050815446907845&cy=-0.35135614735306503&span=1.82079224493306e-14",
		w: 96, h: 48, maxIters: 20000, path: "dd",
	},
	{
		name: "pert", url: "?cx=-0.7050815446907845&cy=-0.35135614735306503&span=1.82079224493306e-14",
		w: 240, h: 120, maxIters: 30000, path: "pert",
	},
	{
		name: "k2-formula", url: "?cx=0.5192304140682561&cy=0.7674373931280046&span=1.3382715312396376&f=custom&expr=%28z%5E2+%2B+c%29+*+sin%28z%5E%28c*i%29%29&j=1&jx=0.4206477290564087&jy=0.5647650444593624&ar=1.3333333",
		w: 120, h: 90, maxIters: 6819, path: "k2",
	},
];

function loadBaselines() {
	try { return JSON.parse(readFileSync(baselinePath, "utf8")); }
	catch { return { expect: {}, machines: {} }; }
}

function runWorkload(wl) {
	const { state, rawView } = M.stateFromUrl(wl.url);
	const W = wl.w, H = wl.h;
	const view = { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: rawView.span / (W / H) };

	let formulaBody = null;
	const preset = M.PRESETS[state.formulaKey];
	const src = state.formulaKey === "custom" ? state.expr : preset && preset.formula;
	if (src) {
		const res = M.compileFormula(src);
		if (!res.ok) throw new Error(wl.name + ": formula failed to compile");
		formulaBody = res.body;
	}
	M.installKernels(M.assembleAll({ usePeriod: true, formulaBody, filterId: 0, juliaMode: state.juliaOn }).srcs);

	const k2 = wl.path === "k2";
	const useDD = wl.path === "dd" || wl.path === "pert";
	const usePert = wl.path === "pert";
	M.setFrameState({
		usePeriod: true, periodEps2: M.periodEps2For(view, useDD), useDD, usePert,
		bandMap: 2,
		fractalMode: k2 ? 1 : 0, formulaId: formulaBody != null ? M.FORMULA_CUSTOM : 0,
		juliaMode: state.juliaOn, mSeedAtC: false, juliaCx: state.juliaX, juliaCy: state.juliaY,
		filterId: 0, ssaaOn: false,
	});
	if (usePert) M.computeRef(view, wl.maxIters);   // setup, untimed (once per generation in the app)

	const N = W * H;
	const out = new Uint32Array(N), mu = new Float32Array(N), de = new Float32Array(N);
	const lut = new Uint32Array(2);
	let iters = -1, tallies = null, best = Infinity;
	for (let r = 0; r < RUNS; r++) {
		M.resetTallies();
		const t0 = performance.now();
		M.renderRegion(out, mu, de, W, 0, 0, W, H, W, H, view, wl.maxIters, lut, 0, 1 / 32, true, 0);
		const dt = performance.now() - t0;
		if (dt < best) best = dt;
		const got = { iters: M.iterAcc, esc: M.escAcc, ins: M.inAcc, per: M.perAcc, cap: M.capAcc };
		if (iters === -1) { iters = got.iters; tallies = got; }
		else if (got.iters !== iters) throw new Error(wl.name + ": nondeterministic across runs (" + got.iters + " vs " + iters + ")");
	}
	return { ms: best, iters, tallies };
}

const base = loadBaselines();
const machine = hostname();
const mine = base.machines[machine];
if (!mine && !UPDATE && !REBASELINE) {
	console.log("no baseline for machine '" + machine + "' — report-only (record one with: npm run bench -- --update)");
}

let failures = 0;
const newTimes = {};
console.log("bench: " + RUNS + " runs/workload, min reported — " + machine + " (" + cpus()[0].model.trim() + ", node " + process.version + ")");
for (const wl of WORKLOADS) {
	const r = runWorkload(wl);
	newTimes[wl.name] = Math.round(r.ms * 10) / 10;
	const mips = (r.iters / 1e6 / (r.ms / 1000)).toFixed(0);

	// Correctness gate: exact iteration + tally match against the committed expects.
	const exp = base.expect[wl.name];
	let corr = "";
	if (!exp || REBASELINE) {
		if (UPDATE || REBASELINE) {
			base.expect[wl.name] = { iters: r.iters, ...r.tallies };
			corr = exp ? "REBASELINED" : "expect recorded";
		} else corr = "no expect (record with --update)";
	} else if (exp.iters !== r.iters || exp.esc !== r.tallies.esc || exp.ins !== r.tallies.ins || exp.per !== r.tallies.per || exp.cap !== r.tallies.cap) {
		corr = "ITERS/TALLIES MISMATCH (expect " + exp.iters + ", got " + r.iters + ") — kernel drift or intentional change (--rebaseline)";
		failures++;
	} else corr = "exact";

	let delta = "";
	if (mine && mine.ms[wl.name] != null) {
		const pct = ((r.ms - mine.ms[wl.name]) / mine.ms[wl.name]) * 100;
		delta = (pct >= 0 ? "+" : "") + pct.toFixed(1) + "% vs baseline " + mine.ms[wl.name] + "ms";
		if (pct > WARN_PCT) delta = "WARN " + delta;
	}
	console.log(
		"  " + wl.name.padEnd(11) +
		String(newTimes[wl.name]).padStart(8) + "ms  " +
		(r.iters / 1e6).toFixed(1).padStart(7) + "M iters  " +
		String(mips).padStart(5) + " Mi/s  [" + corr + "]" + (delta ? "  " + delta : "")
	);
}

if (failures) { console.error(failures + " workload(s) FAILED the correctness gate"); process.exit(1); }
if (UPDATE || REBASELINE) {
	base.machines[machine] = {
		cpu: cpus()[0].model.trim(), node: process.version,
		captured: new Date().toISOString().slice(0, 10), ms: newTimes,
	};
	writeFileSync(baselinePath, JSON.stringify(base, null, "\t") + "\n");
	console.log("baseline written for '" + machine + "' -> bench/baselines.json");
} else if (!mine) {
	console.log("(times not persisted — pass --update to record this machine's baseline)");
}
