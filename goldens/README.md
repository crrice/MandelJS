# P0 golden records

Captured 2026-07-26 on the pre-refactor build (tsc `module:none` concat), per
`refactor-p0.md` step 0. The ported (ES modules + esbuild) build must reproduce every
record in `p0-goldens.json` **bit-for-bit**: `iters` and the pixel tallies exactly equal,
all three hashes identical. Any drift is a port bug — never re-baseline to make it pass.

## Protocol

For each window: load the `url`, then in the console `await mandelDump()` (the hook lives
in src/main.ts). The hook re-renders the current state with **sharpening off** — initial
frame only — and fingerprints:

- `iters` — total kernel iterations (deterministic, scheduling-independent sum)
- `esc / ins / per / cap` — pixel classification tallies (sum = w×h)
- `muHash` — FNV-1a 32 over the raw muField bytes
- `deHash` — FNV-1a 32 over the deField bytes **with IN_SET entries masked to 0**
- `pixHash` — FNV-1a 32 over the canvas ImageData after completion. **Shell-specific**:
  the provisional ramp and `subtle` palette bake from the page's `--ink`/`--paper` theme
  tokens, so these hashes hold on the STANDALONE shell (hardcoded dark fallback) only —
  the AlephSite-hosted page defines its own tokens and legitimately differs on pixels
  while matching every field-level value bit-for-bit (verified 2026-07-29).

The two tierazon windows can be reproduced either by loading the recorded URL or by
running `tierazon()` / `tierazon({rings:true})` — the states are identical (f64 values
round-trip exactly through the URL).

## Determinism scope (why the protocol is shaped this way)

- **Initial frame only**: the sharpening ladder consults wall-clock (`SHARPEN_CHEAP_MS`),
  so its stage count — and the final field — is not run-deterministic. The first pass at
  the probed/pert cap is.
- **deField mask — RETIRED in P3**: originally, the kernels wrote `deDist` only on
  escape/cap, so IN_SET pixels held a stale, scheduling-dependent side-channel value and
  the golden hashed those entries as 0. Since P3 the generated kernels DEFINE the
  side-channel as 0 on in-set returns, so the raw deField equals the old masked field
  byte-for-byte — deHashes are unchanged and now hash the raw bytes.
- **V8-only**: `Math.sin/log/...` precision is implementation-defined; these hashes hold
  for Chrome/Node (V8), not Firefox/Safari. Captured on Chrome 150, 20 cores (worker
  count does not affect results; verified by double-run and cross-reload matches).

## Cross-checks baked into the set

- `seahorse-f64` was captured twice in one session (different scheduling): all hashes
  matched. `home`, `dd-baseline`, `ship`, `julia`, `heuristic-map` matched across full
  page reloads.
- `distance` and `custom-palette` share `seahorse-f64`'s mu/de hashes exactly (same
  compute, recolor-only difference) — a wrong-compute regression shows up in all three.
- `tierazon-rings` shares `tierazon`'s iters/esc/cap exactly (the filter observes the
  orbit, never alters it) while mu/de/pix differ (fields carry intensity/parity).
