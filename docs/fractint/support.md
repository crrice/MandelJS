# Fractint .par support

MandelJS reads and writes Fractint 20.04 parameter files. This page lists what an import understands,
how a Fractint formula becomes a MandelJS formula, what an export writes, and how close the renders
come to Fractint's own. The rules themselves (with source quotes) are in [`conventions.md`](conventions.md),
cited here as C*n.n*.

There is no "Fractint mode". An import sets ordinary settings — the view (with rotation), the formula,
z₀, the bailout, the iteration cap, discrete coloring, logmap and the map palette — and every one of
them stays editable afterwards. The resulting state is a normal permalink.

## Loading and saving

- **In the app:** the `.par files` section loads `.par` / `.frm` / `.txt` files (several at once), takes
  a pasted entry, or accepts a file dropped on the canvas. A file with several entries shows an entry
  picker. A `.frm` file picked with a par supplies the formulas that the par does not carry itself.
  After an import, a report lists every command that was approximated, ignored or unsupported.
  **save .par** downloads the current state.
- **Headless:** `node render.mjs --par <file> [--entry name] out.png` renders an entry to a PNG. Import
  notes other than "applied" go to stderr.
- **Dev console:** `mandelPar()` returns the current state as a par entry; `mandelPar(text)` imports it
  and returns the report (or the reason the entry was refused).

A `.par` file is read entry by entry, in this order:

1. An entry with a `; mandeljs: <query>` comment line is a MandelJS export. The query is the complete
   state, so the rest of the entry is not read and the round trip is lossless.
2. An entry with Fractint commands (`type=`, `reset=`, `center-mag=`, `corners=`) goes through the
   importer (`src/fractint/import.ts`).
3. Anything else is the legacy MandelJS parameter set (one URL key per line), read unchanged.

## Container (C1)

Supported: several entries per file, `;` comments, `\` line continuations, several commands per line
(the last one wins), and `frm:Name { … }` blocks in the same file. An entry or block name ends at `(`
or whitespace, as in Fractint, so `frm:Name(XAXIS) {` is the formula `Name`. Other block kinds
(`lsys:`, `ifs:` …) are skipped. A missing closing `}` is reported as a parse error.

## Par commands

| Command | Import |
|---|---|
| `type=` | `mandel`, `julia` and `formula`. Every other type is refused with a reason. |
| `center-mag=` | Xctr/Yctr/Mag[/Xmag/Rot/Skew] → the view, its rotation and skew. Below Mag 1e13 the centre is rounded to a double as Fractint's double path does (C2.7); deeper, the decimal string's precision is kept as double-double. An Xmag within 2% of ±1 snaps to it (C2.4). Xmag ≠ 1 becomes the aspect ratio (square pixels); its sign mirrors the view. A skew outside ±90° is reported and read as 0. |
| `corners=` | xmin/xmax/ymin/ymax[/x3rd/y3rd], converted back to center-mag. |
| neither | Fractint's default window, reported as approximated. |
| `params=` | mandel: z₀ = c + p. julia: the seed. formula: p1…p5 become constants. |
| `bailout=` | The radius R = √bailout for mandel and julia. It is truncated to an integer as Fractint does; values below 1 are refused. A formula's own bailout test wins (the command is reported as ignored). |
| `maxiter=` | The iteration cap. |
| `function=` | fn1…fn4 for a formula (defaults sin/sqr/sinh/cosh). |
| `inside=` | A number → that palette entry (wrapped as Fractint wraps colours ≥ 256, C5.8). `maxiter`/`-1` → the maxit colour, through logmap (C5.5). The named modes (`zmag`, `bof60` …) are unsupported and fall back to entry 1. |
| `colors=` | The map palette, verbatim (C5.2, `<n>` interpolation included). `@file.map` is unsupported and keeps the default palette. |
| `logmap=` | The logmap transfer (C5.6). The automatic forms `2`/`-2` are read as fixed offsets and reported as approximated. |
| `reset=` | Missing is read as 2004 (approximated); an older release is read with 20.04 semantics (approximated). |
| `float=` | Anything but `y` is approximated: MandelJS always renders in floating point. |
| `outside=` | Only `-1` / `iter` (the default). Other outside modes are unsupported. |
| `bailoutest=` | Only `mod` (the default). Other tests are unsupported. |
| `passes`, `periodicity`, `mathtolerance`, `symmetry`, `formulafile`, `savename` | Ignored with a reason: they steer how Fractint computes, not what the image is. |
| `potential`, `distest`, `decomp`, `biomorph`, `finattract`, `ranges`, `invert`, `fillcolor`, `olddemmcolors`, `logmode`, `cyclerange`, `orbitdelay`, `orbitinterval`, `initorbit`, `usegrid` | Unsupported (no MandelJS setting). |
| any other key | Ignored, and listed in the report. |

Every import also turns on discrete coloring through the linear transfer, turns palette blending off,
and sets the iteration cap to `maxiter`, so the colours are Fractint's `pal8[wrap(logmap[count])]`
(C5.9). Anti-aliasing stays on; switch it off in the coloring section to get Fractint's single sample
per pixel.

### Escape counts

Setting z₀ or a bailout switches the generated kernels to Fractint's counting. The escape test
`|z|² ≥ R²` runs after each step, and the count is the number of steps. Counts run from 1 to maxit − 1,
and maxit means inside.

- **mandel** (C3.2): z₀ = c + p. With p = 0 this runs on the z² + c fast path, so double-double and
  perturbation still apply. With a radius below 2, or p ≠ 0, it runs on the general kernel.
- **julia** (C8, calmanp5 `dojulia_p5`): z₀ = the pixel. The escape at step k counts max(1, k − 1),
  and z at step maxit is still tested.
- **formula** (C4.4): the init block gives z₀, then iterate and test. z₀ itself is never tested.

## Formula translation (frm → MandelJS)

A Fractint formula is **translated** into the normal formula settings — f(z, c), z₀ and the bailout
radius — which stay editable (`src/fractint/frm-translate.ts`). Nothing is evaluated as code. The
output goes through the same whitelist compiler as a typed formula.

The parse follows Fractint's rules (C4.1–C4.3):

- `^` and unary minus share one left-associative level;
- `|x|` is the squared modulus;
- there is no implicit multiplication;
- `c` is an ordinary variable (the pixel is `pixel`);
- `(re,im)` is a complex constant.

The 20.04 parse quirks are reproduced and reported as warnings (C4.11): `-(3)` reads 0, and `1e-3`
reads as `1e` followed by `-3`.

**Shape.** The formula must have the form `init : loop, bailout`.

- The init block becomes z₀.
- The loop must reduce to one carried variable, renamed `z`. Loop temporaries are inlined.
- The last statement must be `|z| < l` (R = √l) or `cabs(z) < R`, where the limit is a positive
  constant. `<=` is accepted as `<`.

**Constants.** `pixel` becomes `c`. `p1`…`p5`, `pi` and `e` become literals. Numeric subexpressions are
folded with Fractint's power and division rules (C4.7, C4.8), including the fast parser's
constant-exponent rewrites.

**Built-ins.** Each is rewritten into the existing MandelJS functions (no new functions are added):

| Fractint | MandelJS |
|---|---|
| `sin cos tan sinh cosh tanh exp log sqrt conj` | same name |
| `real`, `imag`, `cabs` | `re`, `im`, `abs` |
| `\|x\|` | `abs(x)^2` |
| `sqr(x)` | `(x)^2` |
| `abs(x)` (per component) | `abs(re(x)) + abs(im(x))*i` |
| `flip(x)` | `im(x) + re(x)*i` |
| `cosxx(x)` | `conj(cos(x))` |
| `cotan(x)`, `cotanh(x)` | `cos(x)/sin(x)`, `cosh(x)/sinh(x)` |
| `ident`, `recip`, `zero`, `one` (via `function=`) | `x`, `1/x`, `0`, `1` |

**Reported, not translated.** These are listed in the report, and the import is refused when the
formula cannot be translated:

- `if/elseif/else/endif`;
- a comparison anywhere but the final bailout;
- a loop that carries more than one variable;
- a bailout that is not on the iterated variable;
- the functions `asin asinh acos acosh atan atanh floor ceil trunc round srand`;
- the predefined `lastsqr rand whitesq scrnpix scrnmax maxit ismand center magxmag rotskew`;
- assigning `pixel`, `pi`, `e` or `p1`…`p5`;
- a constant that overflows.

**Warned.** A variable that is read before it is written reads 0. Fractint would carry it over from the
previous pixel (C4.5).

## Export (save .par)

The export (`src/fractint/export.ts`) writes a Fractint-valid 20.04 entry, followed by `; mandeljs:`
comment lines that carry the exact query string.

- **Name:** only `[A-Za-z0-9_.-]`, at most 18 characters (Fractint's ITEMNAMELEN). The formula block
  uses the same name.
- **Type:** z² + c is `type=mandel` (z₀ blank or `c`) or `type=julia`. Anything else is
  `type=formula` with its own `frm:` block, which is fully parenthesized; the initial z is the z₀
  field, or the seed the renderer used when the field is blank (z₀ = c for a formula singular at 0).
- **Bailout:** the radius the engine escapes at (the bailout field, else 16 for z² + c and 2
  otherwise), written as `bailout=R²` or as the frm test `|z| < R²`.
- **Always written:** `center-mag=` (with Xmag/Rot/Skew when needed; a double-double centre in full on
  the bignum path), `maxiter=` (the forced cap, else 1000), `inside=`, `logmap=`, and `colors=`. For a
  palette other than a map, `colors=` is the palette sampled into 256 entries.

The Fractint part is the closest Fractint rendering of the state. MandelJS-only settings (filters,
smooth coloring, the transfer, anti-aliasing …) live only in the `; mandeljs:` line, which MandelJS
reads first.

## Measured fidelity

The references in `par/*.jpg` are Fractint renders at 4800×3600, downscaled 3× and JPEG-compressed
(C6.1), so a pixel-exact match is not possible. `npm run score` renders each par at its JPEG size with
anti-aliasing off, point-sampled, and scores it with the C6.5 Tier 1 metrics:

| Par | idx exact (gate) | idx ±1 | flat regions | raw RGB distance (median / mean) | controls: count +1 / −1 / rotation flipped (gate < 0.10) |
|---|---|---|---|---|---|
| midgetbrot (stride 2) | **0.8025** (≥ 0.79) | 0.9109 | 0.9968 | 4.58 / 20.65 | 0.0478 / 0.061 / 0.0952 |
| goldenerror (stride 3) | **0.636** (≥ 0.62) | 0.6988 | 0.9111 | 38.13 / 60.93 | 0.0512 / 0.0301 / 0.0505 |

These match the ceilings measured in the investigation (plan §1: 80% / 63% index agreement). The
negative controls collapse to 3–10%, so each convention (count, rotation sign) is pinned. The remaining
gap is sub-pixel chaotic detail, JPEG noise and, for goldenerror, f64 rounding. Rounding alone moves
about 10% of that formula's escape counts between IEEE implementations (C7).

In the browser, the imported pars reach the same idx with anti-aliasing off (0.8025 / 0.636). With
anti-aliasing on, as imported, they reach 0.779 / 0.597.

## Running the harness

    npm run golden:par   # bit-exact renders of par/*.par (640×480, AA off) vs goldens/par-goldens.json
                         # re-baseline: PAR_GOLDEN_UPDATE=1 npm run golden:par
    npm run score        # Tier 1 score vs par/*.jpg, gated by goldens/par-scores.json
                         # record the measured numbers: PAR_SCORE_UPDATE=1 npm run score

`bench/par-render.mjs` holds the shared importer and renderer: a point-sampled grid across worker
threads, bit-identical to `render.mjs --par` with anti-aliasing off. `npm run score` decodes the JPEGs
the way libjpeg does, and its thresholds were measured with that decoder. Tier 2 (a supersampled
appearance score) is not implemented.
