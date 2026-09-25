# Applying a palette to the x-ray Rings filter

The x-ray Rings filter is a *two-axis* filter: each pixel carries more than a
single scalar, so a plain 1D gradient can't color it directly. This doc gives two
ways to stretch a palette (a gradient + one background color) over that 2D data,
their tradeoffs, and what makes a palette good or bad under each.

---

## The data each pixel carries

From the filter, reduce every pixel to three things:

```ts
type RingData = {
  trapped:   boolean;  // did the orbit ever enter the ring band?
  intensity: number;   // [0,1] — how closely/how much the orbit hugged the ring
  parity:    number;   // [0,1] — even/odd balance: 0 = all-even, 0.5 = balanced, 1 = all-odd
};
```

- **intensity** is the polar *magnitude* of the (even, odd) accumulators (`√(even²+odd²)`,
  or `-log(min ring-distance)` in the scale-free form), passed through a **fixed,
  scale-free transfer** into `[0,1]`. Keep the transfer fixed (no per-frame max) so
  coloring stays zoom-independent.
- **parity** is the polar *angle* of the same pair (`atan2(odd, even)` normalized to
  `[0,1]`). It is intrinsically bounded, so it needs no normalization.
- **trapped = false** is the "no data" case → always paint the background color.

The palette is:

```ts
type Palette = {
  gradient: (t: number) => RGB;  // t in [0,1]
  bg: RGB;                        // single background color
};
```

Both methods below map `(intensity, parity)` → RGB, and both send untrapped pixels
straight to `bg`. They differ in how they build the 2D color space.

---

## Method A — bg-anchored blend ("triangle")

**Idea:** parity picks a color from the gradient; intensity blends from the
background *up to* that color. The background is the anchor of the second axis.

```ts
function colorA(d: RingData, pal: Palette): RGB {
  if (!d.trapped) return pal.bg;
  const g = pal.gradient(d.parity);        // hue from parity
  return lerpRGB(pal.bg, g, d.intensity);  // intensity blends bg -> gradient
}
```

**The color space it generates.** Sweep `parity ∈ [0,1]` and `intensity ∈ [0,1]`:
at intensity 0 everything collapses to the single `bg` point; at intensity 1 you
get the full gradient curve; in between, each pixel sits on the segment from `bg`
to its gradient color. The result is a **triangle/fan** with corners at
`bg`, `gradient(0)`, `gradient(1)` — two straight sides (the blends toward bg) and
one possibly-curved side (the gradient). **Every output is a blend of the
background and one gradient color, so it never leaves the palette's gamut.**

Behaviorally: dim pixels fade toward `bg` and *lose* their parity distinction
(which is fine — parity is unreliable when the orbit barely touched the ring).

### Ideal palette for A

An **iso-luminant** gradient (all stops at the same lightness) with distinct,
saturated endpoints and a distinct midpoint, plus a background clearly separated
from the gradient.

- Concrete: `bg = #000000`; gradient = blue → light-neutral → orange, all tuned to
  equal OKLCH lightness `L≈0.72`, e.g. `≈#6C93D6 → ≈#B4B4B4 → ≈#D69A5A`.
- Why it's good: because the gradient's lightness is **constant**, the blend's
  brightness is driven purely by `intensity` — the two data axes stay clean and
  independent. Distinct saturated endpoints make even vs odd separable; the neutral
  middle makes "balanced" its own thing; a black bg makes untrapped/weak read as
  dark and distinct.

### Really bad palette for A

A gradient with **large lightness swings** and/or **endpoints near the bg color**.

- Concrete: `bg = #101820` (dark slate); gradient = `#05080F → #0A1428 → #14283C`
  (all dark, low-chroma blues).
- Why it's bad: (1) the gradient is dark, so even *high-intensity* pixels come out
  dark — the intensity axis becomes unreadable because the gradient's own low
  luminance fights it. (2) The gradient colors sit near `bg`, so trapped pixels
  blend into the background — the trapped/untrapped boundary vanishes. (3) Low
  chroma throughout means even/odd/balanced are barely different hues. The image
  collapses to a flat dark blue.

**A's Achilles heel is lightness variation in the gradient** — because A rides the
gradient's own brightness, any luminance structure there contaminates the
intensity read.

---

## Method B — luminance-override ("curtain")

**Idea:** take only the gradient's *hue and chroma* for parity, and synthesize
lightness from intensity yourself. The background is not part of this construction
at all — it only colors untrapped pixels.

```ts
function colorB(d: RingData, pal: Palette, Lmin = 0.05, Lmax = 0.95): RGB {
  if (!d.trapped) return pal.bg;
  const g = pal.gradient(d.parity);          // sample the gradient
  const { C, H } = rgbToOKLCH(g);            // keep chroma + hue, DISCARD its lightness
  const L = lerp(Lmin, Lmax, d.intensity);   // impose lightness from intensity
  return oklchToRGB(L, C, H);                 // convert (gamut-clamp here)
}
```

**The color space it generates.** Sweep the same square: parity moves you along the
gradient's hue/chroma shape; intensity moves you up/down in lightness. Nothing
collapses (as long as `Lmin > 0`), so you get a **rectangle/curtain** — think of a
2D swatch whose horizontal axis is parity (blue → gray → orange) and vertical axis
is intensity (dark → bright). Because lightness is *imposed*, the curtain can reach
brighter and darker than any gradient color, so **it may extend outside the
palette's gamut.**

Behaviorally: dim pixels stay *colored* (a dim-blue is still blue), so parity
remains visible at all intensities. The two axes are perceptually orthogonal
(hue ⟂ lightness), which is what makes B robust.

### Ideal palette for B

A gradient with **strong, well-separated hue/chroma** across parity. Lightness is
irrelevant (it's discarded), which is liberating — you only design hue.

- Concrete: gradient = blue `≈#3A6EA5` → neutral `≈#808080` → orange `≈#C8823C`
  (any lightness); `bg = #000000`, chosen to match the curtain's dark end so
  trapped-dim fades continuously into untrapped.
- Why it's good: blue↔orange is the maximally-distinct, colorblind-safe hue pair,
  so even vs odd are unmistakable; the neutral center gives a clean "balanced"; and
  because B supplies luminance itself, intensity is a clean independent axis no
  matter what the gradient's native brightness was.

### Really bad palette for B

A **grayscale** (or near-zero-chroma) gradient.

- Concrete: gradient = `#000000 → #808080 → #FFFFFF`.
- Why it's catastrophic: B throws away the gradient's lightness and replaces it with
  intensity, so a grayscale gradient contributes **nothing** — every pixel becomes
  neutral gray at its intensity-lightness, and parity is *completely invisible*. The
  two-axis filter renders as a flat monochrome intensity map. (A softer version of
  the same failure: a gradient whose two endpoints share a hue "loops back," which
  collapses even↔odd even if the middle has chroma.)

**B's Achilles heel is lack of chroma variation** — it relies on the gradient
*only* for hue/chroma, so a gradient that doesn't vary in hue has nothing to give.

---

## Tradeoffs

| | **A — bg-anchored ("triangle")** | **B — luminance-override ("curtain")** |
|---|---|---|
| Color space shape | triangle/fan, apex = bg | rectangle/curtain along the lightness axis |
| Role of bg | structural — a defining corner | external — only colors untrapped pixels |
| Stays in palette gamut? | yes (blends of {bg, gradient}) | no (imposed lightness can exceed gradient) |
| Intensity axis | rides the gradient's own brightness | synthesized, fully decoupled |
| Parity at low intensity | erased (fades to bg) | preserved (dim but colored) |
| Robustness across palettes | palette-sensitive | robust (any non-grayscale gradient) |
| Fails when | gradient has big lightness swings, or endpoints ≈ bg | gradient is grayscale / low-chroma / loops |
| Preview honesty | what you see in the gradient is what you get | discards gradient lightness (preview ≠ result) |

**The reconciliation:** the two methods *converge* if you feed A an **iso-luminant**
gradient. With constant gradient lightness, A's blend luminance depends only on
intensity — it gains B's clean axis separation while keeping the triangle geometry,
the in-gamut guarantee, and bg-as-anchor. So:

- Want **in-gamut, bg woven in, dim→background fade**, and you're willing to author
  iso-luminant gradients → **Method A**.
- Want **maximum robustness across arbitrary palettes** and don't mind leaving gamut
  or handling bg/continuity separately → **Method B**.

Each method is vulnerable to the palette lacking variation in the dimension it
leans on the gradient for: **A breaks on lightness-varying gradients, B breaks on
chroma-lacking gradients.** A palette that is *both* iso-luminant and
strongly-hued (e.g. the diverging blue–neutral–orange above) is close to optimal
under **either** method — which is the safe default to ship.

---

## Recommended default

Ship an **iso-luminant, diverging blue → neutral → orange** gradient with a **black
background**, and use **Method A**. It is in-gamut, matches the palette preview,
fades cleanly to background at low intensity, and — because it's iso-luminant —
keeps intensity and parity as clean, independent axes. Offer **Method B** as an
alternate mode for users who want arbitrary (including non-iso-luminant) gradients
to stay robust.

---

## Appendix: the original (Tierazon) method, for reference

The source program this filter came from colors x-ray Rings differently — and it's
neither A nor B. It has **no fix-point gradient and no background-color concept**.
Instead:

- The filter's three raw channels — `rj = magnitude + even`, `gj = magnitude + odd`,
  `bj = magnitude` — each map **directly to one screen primary** via its own scale +
  offset:
  ```
  red = rj * incR + startR
  grn = gj * incG + startG
  blu = bj * incB + startB
  ```
  So the entire "palette" is **six numbers** (three starts + three increments), not a
  gradient. A channel-order permutation picks which filter channel feeds which primary.
- Instead of clamping, each channel is folded with a **triangle-wave wrap**
  (`if ((v & 0x1FF) > 0xFF) v ^= 0xFF; v &= 0xFF`), so colors **cycle** as values grow
  rather than saturating — a procedural repeating gradient with no lookup table.
- Untrapped pixels are **hardcoded to black**; there is no configurable background.

Compared to A/B, this is a **multi-channel direct map** (three data channels → three
primaries) rather than a two-axis map through a 1D palette. It's expressive in its own
way — the even/odd/magnitude split lands on R/G/B automatically — but gives the user far
less control (six scalars and a permutation instead of an arbitrary gradient) and can't
stay inside a chosen palette, since each primary is scaled and wrapped independently. In
the `(intensity, parity)` framing: parity's even/odd split is what separates red from
green, magnitude is the shared floor on all three channels (which is why the output is
always somewhat desaturated), and the triangle wrap turns intensity into repeating
brightness bands.
