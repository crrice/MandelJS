# Filter: Stalks (min-distance orbit trap on the coordinate axes)

**Recommended first filter to migrate.** Best value-per-difficulty: it reveals
interior structure that escape-time + log coloring cannot show, it exercises the
renderer's filter interface end-to-end on the simplest possible payload, and once
it works the entire orbit-trap family (bubbles, rings, hi/lo) is a one-line locus
swap. It also *cooperates* with this engine's optimizations (cycle detection,
progressive refinement, parallelism) instead of fighting them.

It plugs into the renderer's existing filter interface — the
`init / onIteration / complete` hooks.

---

## What it computes

A "stalk" trap measures how closely the orbit skims the **coordinate axes**. For
each orbit point `z = (re, im)`, its distance to the nearer axis is
`min(|re|, |im|)` (this traps on the cross/plus shape formed by both axes). The
pixel's value is the **running minimum** of that distance over the whole orbit:

```
trap = min over all orbit points of  min(|re|, |im|)
```

Small `trap` = the orbit passed very close to an axis at some point = bright
filament. Pixels whose orbit never comes near an axis stay dark. Those filaments
are the pullback of the axes under the iterated map, and they thread through
both the exterior *and the interior* of the set.

### Two-channel variant (recommended, richer color)

Track the two axes separately instead of collapsing them with `min`:

```
trapX = min over orbit of |re|     // closeness to the imaginary axis
trapY = min over orbit of |im|     // closeness to the real axis
```

Map `trapX → one channel`, `trapY → another`. This gives the classic
complementary-color stalk look. Start with the single-channel `min(|re|,|im|)` to
get it working, then split.

---

## In the interface

```ts
const stalks: Filter<{tx:number, ty:number}> = {
  init(ctx) {
    return { tx: Infinity, ty: Infinity };   // running minima
  },
  onIteration(s, z /*, n, ctx */) {
    const ax = Math.abs(z.re), ay = Math.abs(z.im);
    if (ax < s.tx) s.tx = ax;
    if (ay < s.ty) s.ty = ay;
    // no return -> never halts; pure observer
  },
  complete(s /*, ctx */) {
    // single-channel: d = Math.min(s.tx, s.ty)
    // two-channel below. Map small distance -> bright.
    const R = intensity(s.tx);
    const G = intensity(s.ty);
    const B = intensity(Math.min(s.tx, s.ty));
    return { r: R, g: G, b: B };            // never returns null: every pixel has a nearest approach
  },
};
```

`intensity()` maps a distance in `[0, ∞)` to brightness (small → bright); see
"Turning the distance into color" below. Note this filter **always** produces a
value — every orbit has *some* closest approach to the axes, so there's no
"un-trapped" background case (some other trap shapes do have one, and would
return `null` for pixels the orbit never reaches).

---

## Why running-minimum, not Tierazon's sum

Tierazon's actual stalks (filters 1/9) *accumulate* a weighted sum:
`xtot += 100 * pow(1 - d/dStrands, n_color)`. Do **not** port that form. The
minimum formulation is strictly better for this engine, on four independent axes:

- **High iteration caps.** `pow(base<1, n)` underflows to exactly 0 once `n` is
  in the hundreds. Tierazon's weights are silently calibrated to `NMAX ≈ 128`.
  At this engine's 10k–100M caps, the sum would ignore all but the first few
  hundred iterations. A `min` has no `n` term — depth-independent.
- **Progressive refinement.** A `min` only tightens as the orbit iterates deeper;
  the color sharpens and never drifts. A growing sum would make the image
  "breathe" (shift color) every refinement pass.
- **Streaming / memory.** Two scalars per pixel, O(1). Nothing stored. (Contrast
  the FDimension/stddev filters, which naively store the whole orbit — infeasible
  at 100M; those need Welford-style online reformulation.)
- **Iteration-count independence.** Different pixels iterate to wildly different
  depths here (escape, cycle detection, refinement). A `min` is well-defined
  regardless; a sum is not comparable across pixels with different depths.

---

## Engine-specific notes

### Interior coloring (a free bonus)
Because `onIteration` runs on **every** orbit point — including bounded orbits
that never escape — interior pixels accumulate a real trap value instead of a
flat "max-iteration" color. This is the mechanism that makes the interior of the
set legible. Escape-time alone can't do this; the filter gives it to you for free.

### Cycle detection — cooperates, doesn't conflict
When a pixel is detected as cyclic (interior), its orbit is periodic, so the
minimum distance to the axes is **fully determined by one period**. Once the
detector has seen a full period (which is when it fires), the running `min` is
already exact — you get the correct value *and* stop early. Two refinements:

- **Evaluate over the detected cycle for exactness.** If you have the `p` cycle
  points, you can compute the trap minimum over the true attracting cycle
  directly, rather than over the transient approach. (At detection the orbit is
  still spiraling *into* the cycle, so the transient min can be a hair larger
  than the true infimum — negligible unless the axis grazes the limit cycle.)
- **Don't couple color to the detector's stop cadence.** A `min` doesn't care
  exactly when you stop, so this filter is immune to detector epsilon / check
  frequency. (Sum/length-based filters are not — another reason to avoid them.)

### Progressive refinement
Interior (cycle-detected) pixels are finalized at detection and won't refine —
fine, because the `min` is already converged there. Exterior pixels keep
tightening their `min` as background iteration deepens; the trap just sharpens.
No special handling needed.

### Perturbation (defer; test on the direct path first)
The one real caveat. Under perturbation `z = Z + δ` with `δ` in low precision, a
trap test near a locus is where precision is worst. For stalks the locus is an
axis, so the danger is when **one** component of `z` is near zero (e.g.
`re ≈ 0` ⇒ `Re(Z) ≈ −Re(δ)`, cancellation in the real part only). This is
**milder** than an origin/point trap (which cancels *both* components), so stalks
are among the more perturbation-friendly traps — but it still softens on deep
`z²+c` zooms. Guidance:

- **Develop and test on the direct (non-perturbation) path**, where it's exact.
  Also note perturbation is `z²+c`-only, so any custom formula (like `111hd`) is
  on the direct path anyway and unaffected.
- Treat perturbation robustness (extended-precision trap component, or rebasing)
  as a **separate later task**, not part of the first migration.

### Parallelization
Purely per-pixel; embarrassingly parallel; no neighbor data. The only
cross-pixel step is **frame-level normalization** (below), which is a reduction
across all pixels — needs a barrier after the orbit pass, and (because of
progressive refinement) a recomputed or running max each refinement round.

---

## Turning the distance into color

The raw trap distance is unbounded in scale and clusters near 0, so map it before
display:

- **Compress:** `v = -log(d + eps)` (bright where close to an axis), or
  `v = 1 / (1 + k*d)`, or `v = exp(-k*d)`.
- **Normalize per frame:** find the per-channel max across the frame and scale to
  `[0,255]`. With progressive refinement this max moves, so recompute it (or keep
  a running estimate) each refinement round.
- **Optional smooth trap:** instead of a hard `min`, keep a smooth-minimum
  (e.g. `-log(sum of exp(-k*dᵢ))/k`) for softer gradients. Not needed for a first
  pass; the hard `min` is refinement-stable and simpler.

---

## Color design & palette choice

Stalks lands very differently from x-ray Rings on the color question, and the
difference drives everything below: **x-ray Rings is inherently 2D** (the even/odd
parity split *is* the filter), whereas **stalks is inherently 1D** — its essential
quantity is a single scalar, how close the orbit came to the nearest axis. That
makes the palette problem *easy* here.

### What the colors should highlight
The **stalk filament network** — the pullbacks/preimages of the coordinate axes
under the iteration, drawn as thin bright threads weaving through the set (interior
*and* exterior). The read you want is simple: **bright where the orbit skimmed an
axis, fading to background where it didn't.** That's a one-axis, near→far story.

### How Tierazon does it
Tierazon runs stalks through the *same* machinery as x-ray Rings — it **forces a 2D
reading** onto a 1D filter. Its two accumulators become `red = proximity to the
imaginary axis`, `green = proximity to the real axis`, `blue = overall magnitude`,
mapped to screen channels by a **six-number palette** — a *start* offset and an
*increment* per RGB channel — as `out = value * increment + start`, then folded with
a triangle-wave wrap (`if ((v & 0x1FF) > 0xFF) v ^= 0xFF; v &= 0xFF`) so colors
*cycle* as values grow rather than clamping (a procedural repeating gradient, not a
lookup table; untrapped pixels are hardcoded to black). So it over-parameterizes
stalks the same way, splitting by *which* axis even though the filament structure is
really a single closeness scale.

### Generalizing a single palette (the easy case)
Because stalks is fundamentally 1D, **you don't need the x-ray Method A/B
machinery.** Just:

- Index the gradient by normalized closeness (`intensity()` above): near end =
  "on a stalk," far end = background.
- Use **bg as the far anchor** — pixels whose orbits stay far from the axes fade to
  bg. Ideally the gradient's far end blends into bg so the background reads as one
  coherent field.

That's ordinary 1D orbit-trap coloring — the same shape as escape-time gradient
coloring. (If you opt into the two-channel *axis-split* variant, you're back to a
2D map and should reuse x-ray Rings' Method A/B, with "which axis" playing the role
parity did. But that axis is coordinate-frame-dependent and weak, so default to 1D.)

### The big gotcha — the palette requirement *flips* from x-ray Rings
This is the key thing to internalize. In x-ray Rings the gradient encodes a
**categorical** axis (even / balanced / odd), so you wanted **visually distinct
endpoint hues** and a distinct midpoint — three separable colors. **Stalks is the
opposite:** the gradient encodes a **continuous closeness ramp**, so:

- **Hue distinctness of the endpoints does *not* matter.** A single-hue gradient is
  perfectly fine — even ideal.
- **Monotonic luminance/contrast along the gradient is what matters** — a clear
  light→dark (or vivid→muted) progression so "close" vs "far" reads at a glance.
- **The far end should resemble bg**, not contrast with it — the reverse of x-ray,
  where you wanted the two ends maximally different from each other.
- **Matched/looping endpoints:** not inherently wanted (closeness is a one-shot
  ramp, not a cyclic quantity). Only loop it — via a continuous cyclic transfer on
  `-log(distance)` — if you deliberately want escape-time-style *banding along the
  filaments*.

So the very palette that's ideal for x-ray Rings is bad for stalks, and vice versa.

### Good / bad examples

- **Ideal:** `bg = #000000`; gradient `#000000 → #1A3A6E → #4FC3F7 → #FFFFFF`
  (black → blue → cyan → white). Strong monotonic lightness, far end = bg, so
  filaments **glow** brightly against a coherent black field and closeness reads
  instantly. Single/low hue-count is a feature here, not a limitation.
- **Really bad:** a near-iso-luminant **rainbow** gradient, e.g.
  `#FF0000 → #00FF00 → #0000FF`. Because it barely changes lightness, closeness
  maps to *hue* instead of brightness — filaments don't get brighter as they near an
  axis, they just shift hue confusingly, and there's no clean "bright thread vs dark
  ground" separation. (This same palette is *great* for x-ray Rings' categorical
  parity — which is exactly the point: the requirement flipped.)

---

## Generalizing to the trap family (after this works)

Everything above is fixed except the per-point distance. Swap only that line in
`onIteration` and you get the rest of the family:

| Filter        | Locus                | Per-point distance                         |
|---------------|----------------------|--------------------------------------------|
| Stalks        | coordinate axes      | `min(|re|, |im|)`                          |
| Bubbles       | origin / a point `p` | `hypot(re - p.re, im - p.im)`             |
| Rings         | circle radius `r`    | `abs(hypot(re, im) - r)`                   |
| Hi/Lo         | a box / offset lines | `min(abs(|re| - a), abs(|im| - b))`       |

(Bubbles has the worst perturbation cancellation — both components near zero —
so it's the least deep-zoom-friendly; stalks and rings are gentler.)

So one validated `min`-trap implementation → a whole family via a distance
function parameter. Design `onIteration` to take a pluggable `distanceToLocus(z)`
from the start.

---

## First-implementation checklist

1. Add the `Filter` object above with a single-channel `min(|re|,|im|)`.
2. Wire the three hooks into the per-pixel loop via the existing filter interface.
3. Add a frame-level normalization pass (per-channel max → scale/compress).
4. Test on the **direct path**, non-deep zoom, `z²+c` Julia or Mandelbrot.
5. Confirm interior structure appears (it should — that's the tell it's working).
6. Then: split to two channels, add the distance-function parameter, and the
   family (bubbles/rings/hi-lo) falls out.

Defer: perturbation-path precision, smooth trap, cycle-exact evaluation.

---

## Source reference

- Tierazon stalks: `rsx_filt.c`, `Do_Filter()` cases 1 and 9 (`|zx/zy|` form),
  completion in the `case 1/9/13/39/40/41/42/43` group of `Filter_Complete()`.
- Port intentionally deviates from the source: **min, not weighted sum** — for
  the engine reasons above.
