# X-ray Rings — filter parameters & the histogram save model

The tweakable **filter** parameters for x-ray Rings (distinct from the coloring
layer — gradient, background, `dFactor`, the color-space method — which is downstream
of the filter and always applies instantly). For each parameter this lists its visual
effect, whether changing it needs a re-render or can be applied instantly from saved
data, and what values it should accept.

Parameters are ordered **highest-value → lowest**, where "value" is subjective but
means roughly *how much exposing this knob widens the range of possible images*.

---

## The instant-vs-re-render lever: what you save per pixel

Whether a filter parameter is "instant" is not fixed — it depends on how much you
save per pixel. Three regimes:

- **Minimal save** — just the final `(intensity, parity)` (2–3 floats/px). Cheap
  (~25 MB at 1080p). But any parameter that touched the accumulation is baked in →
  changing it needs a **re-render**.
- **Histogram save** — a small per-pixel 2D histogram of the orbit's `|z|` density,
  binned by radius and by `n mod K_max` (see the last section). Bounded size, and
  **independent of iteration count**. From it you can re-derive radius, width,
  falloff, and parity-modulus **instantly** — they become slider params, not
  re-renders.
- **Full-orbit save** — store every orbit point. Makes everything instant but is
  *linear in total iterations* → ~49 GB for a 1080p frame with a realistic deep-zoom
  iteration mix. Don't.

Each parameter below is marked for the minimal and histogram strategies.

---

## Tweakable parameters (highest value first)

### 1. Ring radius `R`  *(default `|c|`)*
The biggest lever. Currently welded to `|c|` (the seed magnitude); freeing it turns
the filter into a probe you can sweep across dynamical shells.

- **Visual effect:** relocates the entire bright structure. Small `R` highlights
  orbits that return near the origin; large `R` (→ escape radius) highlights orbits
  about to escape. The filaments physically move to different regions of the image.
- **Instant vs re-render:** minimal → **re-render**; histogram → **instant**.
- **Value:** continuous, `(0, ~2]` (nothing is hit above the escape radius). Presets:
  `|c|`, `1.0`.
- **Note:** in **Julia** mode `|c|` is constant, so free `R` is one global slider; in
  **Mandelbrot** mode `|c|` varies per pixel, so a free `R` means an *absolute* radius
  decoupled from the per-pixel seed — a genuinely different image.

### 2. Annulus width `W`  *(`dStrands`)*
- **Visual effect:** the "line weight" of the rings. Thin → crisp, delicate,
  selective filaments (sparse, high contrast). Wide → broad soft glow (more pixels
  lit, less fine detail).
- **Instant vs re-render:** minimal → **re-render**; histogram → **instant**.
- **Value:** continuous, `(0, R)`. Small default.

### 3. Parity modulus `k`  *(even/odd → period-`k`)*
The most conceptually powerful knob, but gated by coloring: `k > 2` means `k` color
channels, which the 1D/2D palette machinery only handles cleanly up to ~2–3.

- **Visual effect:** changes *what temporal rhythm* the filter detects. `k=2` → the
  familiar two-phase (red/cyan) look. `k=3` → three-phase structure detecting period-3
  rhythm (three color categories), etc.
- **Instant vs re-render:** minimal (only the saved `k=2`) → **re-render**; histogram
  (up to `K_max`) → **instant**.
- **Value:** discrete integer, `{2 … ~8}`; `k=2` default. Expose `{2, 3}` as usable;
  treat higher as experimental.

### 4. Falloff sharpness  *(the `log(2 + df/dist)` shape)*
- **Visual effect:** how peaked each ring is at its exact radius. Sharp → tight bright
  cores; soft → gradual halos. **Overlaps perceptually with width** — both soften the
  rings — so consider pairing them or picking one as primary to avoid a confusing
  two-knob mush.
- **Instant vs re-render:** minimal → **re-render**; histogram → **instant**.
- **Value:** continuous, positive, sane bounds (e.g. an exponent in `[0.25, 4]`).

### 5. Iteration depth / bailout  *(engine-level, but shapes the filter)*
Lowest value *as an aesthetic knob* — it's more a quality/completeness setting than a
look-changer, and it already exists engine-side.

- **Visual effect:** deeper → more ring interactions accumulate → generally more/
  brighter structure, especially for slow or bounded (interior) orbits. Converges
  (diminishing returns past enough iterations).
- **Instant vs re-render:** *increasing* depth = **incremental** (this is exactly
  progressive refinement — extend the orbit, keep accumulating); *decreasing*, or
  changing bailout, = **re-render**. Independent of save strategy.
- **Value:** cap = large int (10k–100M); bailout = radius `≥` escape radius (`≥ 2`).

### Summary

| # | Param | Visual effect | Minimal save | Histogram save | Value |
|---|---|---|---|---|---|
| 1 | Ring radius `R` | relocates the whole structure | re-render | instant | cont. `(0, 2]` |
| 2 | Width `W` | thin filaments ↔ broad glow | re-render | instant | cont. `(0, R)` |
| 3 | Parity `k` | rhythm detected + #color categories | re-render | instant (≤ `K_max`) | int `{2..8}` |
| 4 | Falloff | crisp cores ↔ soft halos | re-render | instant | cont. `[0.25, 4]` |
| 5 | Depth / bailout | more/brighter accumulation | incremental / re-render | (same) | int / radius |

*Not filter params (always instant):* the gradient, background color, `dFactor`, and
the color-space method — those live downstream in the coloring layer and never need a
re-render.

*Ordering caveat:* #2 (width) and #3 (parity) are close and could swap — width gives a
reliable broad visual range and is trivial to color; parity unlocks genuinely
different *structure* but is coloring-gated. Ranked width first for "reliable visual
range per unit effort."

---

## The histogram save model

The histogram is what promotes the ring-family params (#1–#4 above) from re-render to
instant. It is a **sufficient statistic** for the whole ring family: save it once, and
radius/width/falloff/parity all become re-weightings of the saved bins.

**What it stores (per pixel):** a 2D histogram `H[radial_bin][phase_bin]` — the
orbit's density of `|z|` values, binned into `Nr` radial buckets across `(0, R_max]`
and `Np = K_max` phase buckets by `n mod K_max`. To recolor for a chosen
`(R, W, falloff, k)`: sum the radial bins inside `[R−W, R+W]` weighted by the falloff,
then regroup the `K_max` phase bins into `k` groups — instant, no orbit re-run.

### Memory scaling

```
Memory  ≈  W · H · S · Nr · Np · b
```

| Factor | Meaning | Scaling |
|---|---|---|
| `W`, `H` | image dimensions | **linear** each |
| (uniform resolution scale `s`) | scaling both dims by `s` | **quadratic** (`s²`) |
| `Nr` | radial bins | **linear** |
| `Np` | phase bins (= max parity `k`) | **linear** |
| `b` | bytes per bin (f32 = 4, f16 = 2) | **linear** |
| `S` | SSAA multiplier | **O(1)** if sub-samples are averaged into one histogram/px; else linear in samples/px |
| iteration count / orbit depth | — | **O(1) — no dependence** |

**Derived (user-facing) knobs:**
- `Nr ≈ R_max / W_min` — radial bins are set by the *thinnest ring width* you want to
  dial. Memory is **inversely linear in the min ring width** (halve the thinnest
  ring → double memory). This is the knob you'll actually push.
- `Np ≈ K_max` — the largest parity modulus you want instant.

**Key takeaways:** memory is *flat in iterations* (that's why the histogram beats
full-orbit storage — the 1%-of-pixels deep orbits cost the same as shallow ones), and
the only quadratic term is uniformly enlarging the image (two linear factors at once).

### Sizing example: fullscreen 1080p under 100 MB

`1920 × 1080 = 2.07M px`; `100 MB / 2.07M ≈ 48 bytes/px`. Solving `Nr = Budget / (W·H·Np·b)`
with `S = 1` (averaged SSAA):

| Resolution | f32 (4 B) fits | f16 (2 B) fits |
|---|---|---|
| Full 1080p (2.07M px) | `Nr = 6 × Np = 2` | `Nr = 12 × Np = 2` |
| **Half-res 960×540 (0.52M px)** | `Nr = 24 × Np = 2` | **`Nr = 48 × Np = 2`** or `32 × 3` |
| Quarter-res 480×270 (0.13M px) | `Nr = 64 × Np = 3` | `Nr = 128 × Np = 3` |

Full 1080p in 100 MB forces very coarse radial resolution (6–12 bins). **Recommended:
decouple the preview histogram from the final render** — build the histogram at
half-res (960×540) for live sliders (f16, `Nr = 48 × Np = 2` ≈ 99.5 MB, radial
resolution ≈ 0.04, thin enough for crisp rings), and re-render the final image at full
1080p on slider release.

Escape hatch: if instant sliders aren't worth the memory, **minimal-save is ~25 MB at
full 1080p** — drop the histogram and re-render on filter changes.

*SSAA note:* accumulate all sub-samples into one histogram per pixel (histograms are
additive and the ring accumulation is linear in them) so SSAA costs 4× compute but 1×
storage. Keeping per-sub-sample histograms instead multiplies memory by your effective
samples-per-pixel.
