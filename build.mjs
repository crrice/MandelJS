// build.mjs — bundle src/ (ES modules) into dist/: main.js (the app), worker.js (the
// module worker), node-lib.js (Node-facing exports for the golden CLI + tests), plus the
// static shell copied alongside.
//
// No minification (deliberate: parity with the goldens' capture builds, and generated
// kernels stay readable). `--watch` rebuilds on change and serves dist/ on :8080
// (note: shell edits — index.html / index.css — need a re-run; only TS is watched).
//
import * as esbuild from "esbuild";
import { copyFile, mkdir, access } from "node:fs/promises";

const watch = process.argv.includes("--watch");

try {
	await access("src/main.ts");
} catch {
	console.error("build: src/main.ts not found — the src/ module tree lands in P0 step 2 (refactor-p0.md).");
	process.exit(1);
}

const options = {
	entryPoints: ["src/main.ts", "src/worker.ts", "src/node-lib.ts"],
	bundle: true,
	format: "esm",
	target: "es2020",
	outdir: "dist",
	sourcemap: true,
	logLevel: "info",
};

async function copyShell() {
	await mkdir("dist", { recursive: true });
	await copyFile("index.html", "dist/index.html");
	await copyFile("index.css", "dist/index.css");
}

if (watch) {
	const ctx = await esbuild.context(options);
	await copyShell();
	await ctx.watch();
	const { port } = await ctx.serve({ servedir: "dist", port: 8080 });
	console.log("serving dist/ on http://localhost:" + port + "/");
} else {
	await esbuild.build(options);
	await copyShell();
}
