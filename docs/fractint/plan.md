# Fractint .par import — implementation plan (draft v1, for review)

Branch: `future`. Companion spec: [`conventions.md`](conventions.md), the canonical Fractint 20.04 rules with
source quotes and measurements. Every semantic rule below cites a spec clause (C*n.n*).

## 1. Goal and what "reproduce" can mean

The goal is to load `par/midgetbrot.par` and `par/goldenerror.par` in the MandelJS UI and render them
so they match `par/midgetbrot.jpg` and `par/goldenerror.jpg`.

The investigation settled what can and cannot be matched:

- **Every convention is pinned down**, both from source and by measurement. Rotation, count
  convention, bailout, wrap, logmap, palette scaling and geometry all agree with the JPEGs. Removing
  any one of them collapses the match:

  | Variant | Index agreement |
  |---|---|
  | All conventions correct: midget | 80% |
  | All conventions correct: golden | 63% |
  | Rotation sign flipped | 5–10% |
  | Iteration count ±1 | 3–6% |

- **The references are not raw Fractint output.** Registration shows both were rendered at a native
  **4800×3600** and then downscaled (3×, sRGB averaging). They are also JPEGs (q≈70–80, 4:2:0).
- **Pixel-exact is impossible, and not a meaningful target.**
  - The midget residual is sub-pixel chaotic filament detail plus the JPEG noise floor. Flat regions
    agree 98.3% at the index level.
  - For golden, rounding alone moves about 10% of escape counts between any two IEEE
    implementations (C7). Neither Fractint parser can be matched bit for bit in JS doubles.
- **Measured ceiling** with a faithful render and a reference-style downscale:

  | Image | Index agreement | Index agreement ±1 | jsim mean |
  |---|---|---|---|
  | midget | 82% | 92% | 8.05 |
  | golden | 74% | 83% | 13.66 |

**Acceptance criteria (proposed, C6.5).**
- **Tier 1 (semantics).** Render with AA off at the JPEG size, point-sampled.
  - Index agreement: midget ≥ 0.79, golden ≥ 0.62.
  - Negative controls (rotation flip, count ±1) must stay < 0.10.
- **Tier 2 (appearance).** Render at ≥3× and downscale.
  - jsim mean: midget ≤ 8.6, golden ≤ 14.5.
- **UI.** In headless Chromium: import each par through the real UI, wait for "done", and score the
  canvas.

## 2. Design principles (non-negotiable)

1. **Opt-in, zero drift.** Nothing changes for existing state:
   - generated kernel source for every existing `KernelSpec` stays byte-identical,
   - the 13 bit-exact goldens stay identical,
   - every existing permalink round-trips byte-identically.

   All new behaviour hangs off new state that defaults to off.
2. **Bake, don't branch.** Fractint semantics (bailout, count convention, frm body) enter through
   `KernelSpec` and the assembly key, as generated source. The loop never gets a new per-iteration
   config branch.
3. **Codegen plus whitelist.** The frm dialect compiles to flat f64 pair arithmetic, as `formula.ts`
   does. It gets its own front end (the precedence and semantics differ, C4), with no eval of user
   text.
4. **One pixel→plane mapping.** Rotation, skew and xmag become a 2×2 basis in the View, consumed by
   `escapeAtPt`. Every other geometry consumer goes through the same helper.
5. **One state→engine mapping.** Imported state is ordinary `AppState` plus URL rows, applied by
   `applyEngineState`. A par import therefore *is* a permalink, and the exporter works unchanged.
6. **MandelJS-native where fidelity allows.** We keep:
   - exact per-pixel c (DD/perturbation),
   - MandelJS's own periodicity check,
   - full per-pixel computation (no solid guessing),
   - MandelJS's adaptive edge SSAA (it averages mapped colours in sRGB, which is what the references
     did).

   Each of these was measured as no worse than the Fractint emulation (C2.7, C3.6, C4.14).

## 3. Architecture at a glance

```
par text ──► src/fractint/par.ts ─ entries, tokens, frm: blocks, dialect detect
                │
                ▼
         src/fractint/import.ts ─ entry → {AppState, RawView, report}
                │   ├─ center-mag/corners → affine view (C2)      src/math/frame.ts
                │   ├─ colors= / logmap / inside → map palette    src/fractint/colors.ts
                │   └─ formula text + params/fn → frm compile     src/fractint/frm.ts
                ▼
         AppState + URL rows (config.ts) ──► applyEngineState (main.ts)
                ▼
  RenderPipeline ─ KernelSpec.escape (fractint count/bailout) + KernelSpec.frm (init/loop/bailout)
                ▼
  field: integer counts (mu) ──► colorSample mode 2: pal8[idxLUT[count]] (instant recolour)
```

## 4. Work items

Sizes are S/M/L/XL. File lists are the expected footprint, used to plan conflict-free parallel
waves.

| ID | Item | Size | Depends on | Files (primary) |
|---|---|---|---|---|
| W0 | Guard rails: kernel-source snapshot + permalink corpus + browser pixHash baseline | S | – | `tests/kernel-src.test.mjs`, `tests/url-corpus.test.mjs`, `goldens/kernel-src.json` |
| W1 | Fractint par tokenizer: entries, continuations, comments, `frm:` blocks, dialect detect (C1) | M | – | `src/fractint/par.ts` + tests |
| W2 | `colors=` decode, (v<<2)\|(v>>4), `<n>`, logmap table, wrap, version gates (C5) | S | – | `src/fractint/colors.ts` + tests |
| W3 | frm compiler: Fractint dialect → init/loop/bailout f64 codegen (C4) | XL | – | `src/fractint/frm.ts`, `frm-funcs.ts` + tests |
| W4 | View affine (rot/skew/xmag) end to end: mapping, probes, pert ref, box zoom, URL rows (C2) | L | W0 | `src/math/frame.ts`, `kernel.ts`, `pipeline.ts`, `config.ts`, `main.ts`, `render.mjs` |
| W5 | Fractint escape semantics baked into K1 f64/dd/pert + K2 (C3.2–C3.5) | L | W0, W4 | `assemble.ts`, `pipeline.ts` + tests |
| W6 | Indexed dwell colouring: 256-entry map palette, index LUT, instant recolour, AA toggle (C5.9) | L | W2, W4 | `palette.ts`, `kernel.ts`, `colorizer.ts`, `protocol.ts`, `worker.ts`, `pipeline.ts` |
| W7 | K2 frm kernel variant + pipeline plumbing (params, fn binding, overflow escape) | L | W3, W5 | `assemble.ts`, `kernel.ts`, `pipeline.ts` + tests |
| W8 | Importer + AppState/URL rows + `.par` dispatcher (legacy dialect byte-identical) | L | W1, W2, W4 | `src/fractint/import.ts`, `config.ts` + tests |
| W9 | Headless setup, `render.mjs --par`, par goldens, JPEG scoring harness (Tier 1/2) | L | W4–W8 | `src/render/headless.ts`, `bench/par-*.mjs`, `goldens/par-*.json` |
| W10 | App wiring + UI: load/drag-drop/paste, entry picker, report pill, Fractint-mode switch, frm editor, rotation field | L | W4, W6–W8 | `main.ts`, `src/ui/par-import.ts`, `index.html`, `index.css` |
| W11 | Docs: support matrix, fidelity notes, harness usage | S | W8–W10 | `README.md`, `docs/fractint/*.md` |
| W12 | *(optional)* Re-export an imported par with the current view | M | W8 | `src/fractint/export.ts` |

Per-item notes (the implementing agent reads the spec clause, not this summary):

- **W0.** This lands first and is the tripwire for everything after it:
  - a djb2 snapshot of `assembleAll(spec).srcs` over the existing spec matrix,
  - a permalink corpus beyond the goldens,
  - a Chromium `mandelDump()` pixHash baseline recorded on the current `future` HEAD (Playwright +
    the preinstalled Chromium), so browser-side colour paths gain a gate too.
- **W3.** A separate front end. The Fractint rules to implement:
  - `^` and unary minus share a precedence level and are left-associative;
  - `|x|` is the squared modulus;
  - `abs` works per component;
  - there is no implicit multiplication;
  - `c` is not predefined;
  - `if/elseif/else/endif` emits as JS if/else.

  Built-ins, predefined variables and quirks are in C4.2–C4.12. Per-pixel state is reset each pixel,
  with a read-before-write warning (C4.5). The DOS fast parser's constant-exponent rewrites (^2 →
  sqr, …) are emulated (C4.7).
- **W4.** `View` gains an optional basis, with the legacy expression kept when the view is
  axis-aligned (bit-exact goldens). The midget par's centre is rounded to a double, as Fractint's
  double path does (C2.7); the bignum path (Mag ≥ 1e13) uses the DD centre from the decimal string.
- **W5.** Semantics, from C3.2:
  - z starts at `c + p`,
  - the test `|z|² ≥ rqlim` comes after each step,
  - counts run 1..maxit−1, and maxit means inside.

  The integer count goes into the `mu` field (Float32 is exact to 2^24). The DE side-channel is
  unused in this mode. The iteration cap is fixed at `maxit` (the existing forced-cap path; no probe,
  no sharpening).
- **W6.** colorSample mode 2 is `pal8[idxLUT[min(count,maxit)]]`, with inside → the inside index.
  SSAA maps subsamples to RGB and then averages in sRGB. `colorizer.ssaaAverage` already does this;
  keep raw integer subsamples in `ssaaMu`.
- **W8.** Details:
  - An import yields `{state, rawView, report}`. The report lists every key as applied, approximated,
    ignored or unsupported.
  - A missing `reset=` is treated as 2004, with a warning.
  - Types in v1: `mandel`, `julia`, `formula`. Others are refused with a clear message.
- **W9.** The scoring runs in Node against the committed JPEGs and uses the Tier 1/2 metrics from
  C6.5.
- **W10.** Imported views land in "Fractint mode":
  - Fractint counts, bailout and fixed maxiter,
  - the indexed map palette,
  - the 4:3 aspect.

  Toggling Fractint mode off keeps the framing (including rotation) and hands the view to
  MandelJS-native rendering. The imported map stays available as a smooth palette.

## 5. Execution waves (agent orchestration)

Each wave runs its items in parallel in isolated worktrees. Merges are sequential, in the order
listed. Then the **gate** runs before the next wave: `typecheck`, `npm test`, `npm run golden`, the
W0 snapshots, and bench (baseline recorded for this machine first). After the gate, an adversarial
review agent checks each diff against the spec clauses and principles §2. You and I review between
waves.

| Wave | Items | Why this grouping |
|---|---|---|
| 0 | W0 | the tripwires must exist before any engine edit |
| 1 | W1, W2, W3, W4 | W1–W3 are new files only. W4 is the only item touching the hot files (`kernel.ts`, `pipeline.ts`, `config.ts`, `main.ts`) |
| 2 | W5, W6, W8 | W5 and W6 both touch `pipeline.ts` (disjoint hunks) and `kernel.ts` (W6 only). Merge W5 → W6 → W8 |
| 3 | W7 | needs W3 + W5; it is the golden-error engine path |
| 4 | W9, W10 | harness plus UI. W10 ends with the Chromium end-to-end import test |
| 5 | W11 (+W12 if wanted), final full-gate + Tier 1/2 scoring report | |

`src/node-lib.ts` is append-only for every item, so its conflicts are trivial.

## 6. Recommended defaults for open decisions

These are my recommendations; the chat lists the questions. Each one is changeable before Wave 1.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Default look of an imported par | Indexed Fractint colouring **with** MandelJS edge-SSAA on (closer to the references, which are supersampled). An "aliased (Fractint-exact)" toggle provides the Tier 1 view |
| D2 | Rotation | First-class: URL rows `rot` (+`skew`/`xmag`, only when non-default). A degrees field in *render*. Box zoom, pan and zoom-out respect it. Reset clears it; Julia entry starts unrotated |
| D3 | Mode switch | One `fx` switch for the kernel semantics (count, bailout, fixed maxiter). Indexed colouring is on by default under `fx` but stays a separate choice. The imported 256-colour map doubles as a smooth palette in native mode |
| D4 | URL encoding | Verbatim `colors=` string and frm text, percent-encoded (about 1.5 KB links; transparent, synchronous) |
| D5 | Formula UI | Formula dropdown gains "Fractint formula": an editable textarea plus p1..p5 and fn1..fn4 fields. Julia toggle and filters are disabled under it |
| D6 | Import UX | A "load par" button (accepts .par + .frm), drag-drop on the canvas, and paste. An entry picker for multi-entry files. A report pill for unsupported or approximated keys |
| D7 | v1 scope | Types mandel/julia/formula. The frm subset is everything except `rand/srand` and `scrnpix/scrnmax/whitesq` (resolution-dependent). 20.04 parse bugs are rejected with a warning. Version gates are limited to the cheap ones (logmap <2002, wrap ≤1950, pow <1900). `float=n` renders as float, with a note |
| D8 | Periodicity / guessing | MandelJS Brent check; no emulation of guessing or of Fractint periodicity (measured no-ops) |
| D9 | Precision | Double-rounded centre on Fractint's double path; exact per-pixel c; MandelJS's own DD/pert gates |
| D10 | Span convention | Resolution-independent (corners on the frame edges). This is ≤0.5 px at the edges versus Fractint's (dots−1) grid, and fixes a resolution-dependent quirk |
| D11 | Export to Fractint | Deferred (W12 optional). MandelJS's own `.par` dialect export stays |
| D12 | JPEG decoding for the harness | `jpeg-js` as a **devDependency** (runtime stays zero-dep; avoids ~6 MB of committed PNG decodes) |
| D13 | CI tiers | `npm run golden:par` (bit-exact hashes of our own par renders at 640×480) + `npm run score` (Tier 1). Tier 2 is a manual script |
| D14 | Reference images | Stay at `par/<name>.jpg` next to their pars (committed in 2317a58) |

## 7. Risks

| Risk | Mitigation |
|---|---|
| W4/W5/W6 touch the hot path (`escapeAtPt`, `colorSample`, emitters) | Legacy expressions are kept verbatim behind codegen-time or view-shape checks. The W0 source snapshot + goldens + bench gate every wave |
| The frm dialect is large (W3 is XL) | Split its tests by clause. Cross-check the compiled golden-error kernel against the prototype's count field at a small size (spec C4.13 numbers) |
| `pipeline.ts` contention (W4, W5, W6, W7) | Waves are sequenced so that at most two items touch it at once, with disjoint hunks |
| Performance of frm renders (two complex `pow` per iteration) | The prototype measured about 5 min for 4800×3600 single-threaded. At screen size with the worker pool this is seconds. Measure it in W9 |
