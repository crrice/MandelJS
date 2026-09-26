# MandelJS

A from-scratch fractal explorer, drawn pixel-by-pixel on a `<canvas>` in TypeScript.
Escape-time iteration of `z ↦ z² + c` — plus user formulas `f(z, c)` compiled to
specialized kernels, Julia sets, orbit-trap filters, deep zoom via perturbation and
double-double arithmetic, and a drag-to-select box zoom. Drag a rectangle over the
canvas and hit **zoom** to descend into the boundary; **back** steps out exactly;
**reset** returns to the full view. The address bar always holds a full permalink.

Zero runtime dependencies — esbuild bundles `src/` into a static page (`dist/`).

## Develop

    npm install       # dev deps: esbuild + the TypeScript compiler (typecheck only)
    npm run build     # src/ -> dist/  (main.js + worker.js + node-lib.js + shell)
    npm run watch     # rebuild on change + serve dist/ on :8080
    npm run serve     # http-server on dist/ :8080

    npm run typecheck # tsc --noEmit over src/
    npm run test      # node:test component suites (phase machine, field scans, config)
    npm run golden    # bit-exact field regression against goldens/p0-goldens.json
    npm run bench     # standing perf gate: deterministic kernel workloads, min-of-7,
                      # machine-keyed baselines (bench/baselines.json); iteration counts
                      # asserted exactly. Record a machine: node bench/perf.mjs --update
    npm run golden:par # bit-exact renders of par/*.par against goldens/par-goldens.json
    npm run score     # Fractint reference score: par/*.par vs par/*.jpg (index agreement
                      # + negative controls), gated by goldens/par-scores.json

## Layout

- `src/kernel/` — the compute core: `assemble.ts` GENERATES specialized escape kernels
  (precision × formula × filter × periodicity baked in, DD primitives inlined);
  `kernel.ts` is the runtime half (frame state, dispatch, the one coloring transfer).
- `src/render/` — the pipeline: worker pool, explicit phase machine, field store,
  colorizer, telemetry, and a render-sink seam (`CanvasSink` on screen). `headless.ts`
  configures the same engine DOM-free for `render.mjs` (a permalink or `--par` → PNG) and
  the par runners.
- `src/filters/` — one `FilterDef` file per orbit-trap filter (kernel snippets + color
  readout + palette policy); the UI dropdown is generated from the registry.
- `src/config.ts` — the app-state schema: URL permalinks serialize through per-parameter
  rows; `.par` files dispatch to the lossless `; mandeljs:` query, the Fractint importer, or
  the legacy MandelJS dialect.
- `src/fractint/` — Fractint 20.04 `.par` support: the tokenizer, `colors=`/logmap codec,
  frm → MandelJS formula translator, the importer (`import.ts`) and the exporter
  (`export.ts`: a Fractint-valid entry plus the `; mandeljs:` line).
- `src/formula.ts` — the `f(z, c)` text → flat f64 codegen compiler.
- `src/ui/` — page glue: DOM handles, canvas geometry (`viewport.ts`), and the `.par`
  section (`par-import.ts`: load / drop / paste, the entry picker, the import report,
  save `.par`; `.frm` files picked alongside supply formulas the par does not carry).
- `src/main.ts` + `index.html` — the standalone shell and control wiring. The same
  engine is also embedded — wrapped in site chrome — on
  [fifthaleph.com/fractal-gen](https://fifthaleph.com/fractal-gen).

`goldens/` holds bit-exact reference renders (see its README for the determinism
scope); `bench/golden.mjs` replays them in Node against the same kernels the workers run.
`bench/par-golden.mjs` and `bench/par-score.mjs` do the same for the committed Fractint pars,
the latter scoring against the reference JPEGs (`docs/fractint/conventions.md` C6.5).

Extracted from [fifthaleph-site](https://github.com/crrice/fifthaleph-site), where an
earlier version of this lived under `src/pages/fractal-gen`.
