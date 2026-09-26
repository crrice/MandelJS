> **Provenance.** Reconciled from four source-research passes (Fractint 20.04 C/asm via the
> Iterated Dynamics repo history + a patchlevel-16 mirror) and two empirical prototypes scored
> against `par/*.jpg`, 2026-09-26. `S/…` paths refer to that session's scratch directory and are
> **not preserved** in the repo; the rules and measured numbers below are the durable record.

# Fractint 20.04 conventions spec for MandelJS PAR import (reconciled v1)

**Status.** This is the canonical reference that MandelJS implementers code against.

**Target semantics.** Fractint 20.04 with `reset=2004` (save_release = 2004), DOS build on a 386+/387+ CPU. The par comments name a P200 and a P4. Where Iterated Dynamics (ID) behaves differently, this spec gives the 20.04 behaviour and notes the ID difference.

**Inputs.**
- `par/midgetbrot.par` with `par/midgetbrot.jpg` (1600x1200).
- `par/goldenerror.par` with `par/goldenerror.jpg` (1500x1125). This par carries its `frm:MandAutoCritInZ` block.
- Both JPEGs are already committed on branch `future` (commit 2317a58).

## 0. Sources, abbreviations, evidence legend

| Abbrev | Source |
|---|---|
| P00 | Fractint 20.04p00, tag `fractint-20-04p00` in the ID repo, flat layout: `https://github.com/LegalizeAdulthood/iterated-dynamics/blob/fractint-20-04p00/fractint/<file>#L<n>` |
| P04 | Fractint 20.04p04: `https://github.com/LegalizeAdulthood/iterated-dynamics/blob/fractint-20-04p04/fractint/common/<file>` (asm in `/dos/`, headers in `/headers/`) |
| JH | Fractint 20.4 patchlevel 16 SVN mirror: `https://github.com/jhol/fractint/blob/master/<path>` (commit 9239882e) |
| ID | Iterated Dynamics master: `https://github.com/LegalizeAdulthood/iterated-dynamics/blob/1874ec377bdb8a62119aaf9975b1444bf087d478/<path>` |

- Line numbers are P00 unless marked otherwise.
- S = `/tmp/claude-0/-home-user-MandelJS/585ed8cd-2365-54b7-a2ed-de499043e7ce/scratchpad`.
- Local source copies:
  - P00: `S/mandel-iter/f2004/fractint`
  - P04: `S/proto-goldenerror/fr2004`
  - JH: `S/color/jhol`
  - ID: `S/proto-midget/id-src`
- Reconciliation runs are in `S/reconcile`.

**Tags.**
- **[SRC]**: verified in source.
- **[EMP]**: verified by measurement.
- **[SRC+EMP]**: both.
- **[INFERRED]**: follows from measurements but is not proven.
- **[UNVERIFIED]**: stated without evidence.

**Metrics.**
- **idx-exact (±1).** Fraction of unambiguous JPEG pixels whose nearest palette entry equals the rendered index (or is within ±1 of it). A pixel is unambiguous when the nearest palette distance is ≤25 and the second-nearest is ≥1.5× the nearest.
- **raw / jsim distance.** Per-pixel Euclidean RGB distance to the JPEG, reported as median/mean. For jsim, the candidate is first re-encoded with the reference's own quantisation tables at 4:2:0.
- **MAE.** Mean absolute per-channel error, used in the geometry report.
- **Registration.** Phase correlation of blurred luma, tile by tile. The fitted shift is d = offset + slope·(p − centre), with slope in units of 1e-4 per px. A positive slope means the reference is magnified relative to the candidate.

---
## 1. PAR container and parameter parsing

**C1.1 Entries, tokens and line continuation [SRC+EMP]**

Rule:
- An entry has the form `Name { ... }`.
- `;` starts a comment that runs to the end of the line.
- Whitespace or `;` ends a command token.
- A backslash that is the **last** character of a physical line (after CR is dropped) joins the next line. The next line's leading characters ≤ ' ' are skipped, and the two parts are concatenated with no separator.
- The PAR writer emits a backslash only when it breaks inside a token. A break between tokens is written as a new line indented by two spaces.

Source:
- P00/cmdfiles.c#L925: `&& *(lineptr+1) == 0) {` … `/* skip white space @ start next line */`.
- `file_gets` drops CR: `if (c != '\r') buf[len++] = (char)c;` (the geometry report checked this).

Empirical: every result below depends on the joined values, e.g. midget Yctr = `+0.00122318048670787`.

MandelJS: `stateFromPar` (src/config.ts) reads one key=value per line and has no continuation handling. It needs a Fractint tokenizer.

**C1.2 reset=, save_release, defaults [SRC]**

`reset=N` calls `initvars_fractal()` and then sets save_release = N. `reset=0` gives 1730. `release=N` also sets save_release. A PAR with no `reset=` leaves save_release at the running release and does **not** reset any parameters.

Defaults after reset (DOS build):
- type mandel, maxit 150, inside 1, outside -1 (ITER)
- passes g (solid guessing), periodicity 1
- float=n (the XFRACT build defaults to float=y)
- bailout 0 (use the type's default), bailoutest mod
- all params 0; logmap 0; ranges cleared; potential, decomp and distest off; biomorph -1
- fn1..fn4 = sin/sqr/sinh/cosh; ismand 1

Source:
- P00/cmdfiles.c#L1280: `if (numval>=0) save_release = numval;`
- L1283: `save_release = 1730; /* before start of lyapunov wierdness */`
- L627: `save_release = release; /* this release number */`
- initvars_fractal L716-L779: `usr_periodicitycheck = 1;` `inside = 1;` `outside = -1;` `maxit = 150;` `usr_stdcalcmode = 'g';` `usr_floatflag = 0; /* turn off the float flag */` (under `#ifndef XFRACT`) `set_trig_array(0,s_sin);` `bailoutest = Mod;`

Importer: treat a missing `reset=` as `reset=2004` and show a warning. [UNVERIFIED equivalence]

**C1.3 Numeric parsing [SRC+EMP]**

Float parameters are parsed into a `double floatval[16]` with `sscanf("%lg")`. Mag is re-read from its string at long-double precision.

Source:
- P00/cmdfiles.c#L995: `double  floatval[16];`
- L1067-1073: `sscanf(argptr,"%lg%c",&ftemp,&tmpc)` … `floatval[totparms] = ftemp;`

Empirical: the midget reference measurably used the double-rounded centre (C2.7).

**C1.4 params, function=, formula lookup [SRC]**

- `params=` fills param[0..9]; unspecified entries are 0.
- For mandel, p = (P0,P1) is added to z0.
- For formula: p1=(P0,P1), p2=(P2,P3), p3=(P4,P5), p4=(P6,P7), p5=(P8,P9).
- `function=a/b/c/d` binds fn1..fn4 in order. Names are lowercased and cut to 6 characters; unknown names are silently ignored.
- Formula lookup order: `formulafile=` first, then `frm:<name>` in the PAR file itself. MandelJS can only use the embedded block.

Source:
- cmdfiles.c#L1715: `param[k] = (k < totparms) ? floatval[k] : 0.0;`
- parser.c#L2430: `v[1].a.d.x = param[0];`
- cmdfiles.c#L1508: `if(set_trig_array(k++,value)) goto badarg;`
- miscres.c#L588: `BYTE trigndx[] = {SIN,SQR,SINH,COSH};`
- miscres.c#L1495: `strcpy(parsearchname, "frm:");`

---
## 2. Geometry

**C2.1 center-mag fields and precision path [SRC+EMP]**

Rule:
- Format: `center-mag=Xctr/Yctr/Mag[/Xmag/Rot/Skew]`.
- Xmag defaults to 1, and 0 also means 1. Rot and Skew default to 0 and are in degrees.
- dec = exponent of Mag (from `%+.1Le`) + 4.
- If dec ≤ DBL_DIG+1 = 16 (Mag < 1e13), the **double path** is used: Xctr and Yctr are doubles, and cvtcorners runs in double.
- Otherwise the bignum `cvtcornersbf` path is used.

Source:
- P00/cmdfiles.c#L1963: `dec = getpower10(Magnification) + 4; /* 4 digits of padding sounds good */`
- L1965: `if((dec <= DBL_DIG+1 && debugflag != 3200) || debugflag == 3400) { /* rough estimate that double is OK */`
- L1966: `Xctr = floatval[0];`

Empirical: midget dec = 16 and golden dec = 14, so both take the double path.

**C2.2 cvtcorners [SRC+EMP]**

```
h = 1/Mag;  w = h / (0.75f * Xmag)       // DEFAULTASPECT is a float constant, y/x
if Rot==0 && Skew==0: xmin=x3=Xctr-w; xmax=Xctr+w; ymin=y3=Yctr-h; ymax=Yctr+h; done
t = tan(Skew*pi/180)
xmin=-w+h*t; xmax=w-h*t; x3=-w-h*t; ymax=h; ymin=y3=-h
R = Rot*pi/180
for each corner (x,y) in TL=(xmin,ymax), BR=(xmax,ymin), BL=(x3,y3):
    X = x*cosR + y*sinR + Xctr;   Y = -x*sinR + y*cosR + Yctr
```

What this means:
- At Xmag = 1 the corner-to-corner frame is 2w × 2h, which is exactly 4:3. In general the x/y aspect is 4/(3·Xmag), and a negative Xmag mirrors x.
- The sampling frame is Rot(−R). On screen, with Im pointing up, the content appears rotated counter-clockwise by Rot.
- Midget: screen-right points to +77.5° in the plane.
- Golden: screen-right points to −72.5°.

Source:
- P00/miscres.c#L265-266: `h = (double)(1/Magnification);` `w = h / (DEFAULTASPECT * Xmagfactor);`
- L278: `tanskew = tan(deg_to_rad(Skew));`
- L291: `x = xxmin * cosrot + yymax *  sinrot;`
- P00/fractint.h#L82: `#define DEFAULTASPECT ((float)0.75)/* Assumed overall screen dimensions, y/x  */`
- ID libid/engine/convert_corners.cpp is identical.

Empirical:

| Variant | midget | golden |
|---|---|---|
| as specified | MAE 10.77, idx 80.1% | MAE 31.12, idx 63.2% |
| rotation sign flipped | MAE 43.07, idx 9.6% | MAE 73.85, idx 5.0% |
| rotation ignored | MAE 44.87 | MAE 74.33, idx 4.4% |
| rotation ±0.5° | MAE 18.22 / 18.43 | MAE 44.86 / 44.67 |
| scale ±1% | MAE 18.10 / 18.42 | MAE 46.91 / 48.39 |
| skew 0 | MAE 10.81, idx 79.88% | idx 63.16% |

Skew is present only at round-trip noise level (0.0099° and 0.0024°, ≤0.1 px at the frame edge), so the source rule decides.

**C2.3 corners= form [SRC] (not exercised)**

`corners=xmin/xmax/ymin/ymax[/x3rd/y3rd]`. x3rd = xmin and y3rd = ymin unless six values are given. Corners are TL=(xmin,ymax), BR=(xmax,ymin), BL=(x3rd,y3rd).

Source: cmdfiles.c: `xx3rd = xxmin = floatval[0]; xxmax = floatval[1]; yy3rd = yymin = floatval[2]; yymax = floatval[3]; if (totparms == 6) { xx3rd = floatval[4]; yy3rd = floatval[5]; }`

**C2.4 adjust_corner at calc init [SRC+EMP]**

Rule:
1. Convert the corners back to center-mag in double.
2. If |Xmag| ≠ 1 and lies within 1 ± aspectdrift (0.02), set Xmag = sign(Xmag) and run cvtcorners again.
3. Snap the third corner when an edge's off-axis extent is < 1e-4 of the other. This only happens for near-axis frames (rotation below about 0.004–0.008°).

Source (P00/fracsubr.c#L615-650):
- `if (ftemp != 1 && ftemp >= (1-aspectdrift) && ftemp <= (1+aspectdrift))`
- `if (ftemp*10000 < ftemp2 && yy3rd != yymax) xx3rd = xxmin;`

Empirical:
- Both pars trigger the Xmag re-snap. Midget round-trips to Xmag = 1.0000107733 and Rot = −77.50138667.
- The corners move by ≤4e-19, which is ≤0.03 px.
- A render with adjust_corner vs one without scores 79.87% vs 80.08% idx.
- Only needed for fidelity on near-axis frames.

**C2.5 Pixel grid: corners are pixel centres, (dots−1) denominators [SRC+EMP]**

Rule (steps in LDBL):
```
delxx  = (xmax-x3)/(xdots-1)    delyy  = (ymax-y3)/(ydots-1)
delxx2 = (x3-xmin)/(ydots-1)    delyy2 = (y3-ymin)/(xdots-1)
Re(col,row) = xmin + col*delxx + row*delxx2
Im(col,row) = ymax - row*delyy - col*delyy2
```
- The result is rounded to double. When use_grid applies, it is computed as dx0[col]+dx1[row], with each table entry rounded to double; otherwise as `(double)(xxmin+col*delxx+row*delxx2)`.
- The par centre is the image centre. There is no half-pixel offset.

Source:
- P00/framain2.c#L231: `dxsize = xdots - 1;            /* convert just once now */`
- P00/fracsubr.c#L328: `delxx  = (LDBL)(xxmax - xx3rd) / (LDBL)dxsize; /* calculate stepsizes */`
- P00/fractals.c#L3368: `return(dx0[col]+dx1[row]);`
- P00/fractals.c#L3380: `return(dy0[row]+dy1[col]);`

Empirical:
- Midget full-resolution shift sweep: (0,0) gives MAE 10.66; ±0.25 px gives 10.81–10.87.
- Golden: (dots−1) gives idx 63.15%, dots gives 61.66%.
- Midget at 1x slightly prefers dots (80.17% vs 80.08%). This is explained by the reference being rendered at 3x native (C6.1): its effective span lies between the two conventions.

**C2.6 MandelJS mapping [SRC+EMP]**

Rule:
```
u = (px+0.5)/W - 0.5,  v = 0.5 - (py+0.5)/H,  c = centre + M*(u,v)
M = [[(xmax-x3)*kx, (xmin-x3)*ky], [(ymin-y3)*kx, (ymax-y3)*ky]]
  = Rot(-R) * [[1, tanS],[0, 1]] * diag(2w*kx, 2h*ky)
```
Choices for kx and ky:
- **Fractint-exact at a native grid N×Ny:** kx = N/(N−1), ky = Ny/(Ny−1).
- **Resolution-independent limit:** kx = ky = 1, i.e. corners on the frame edges.
- **Matching these reference JPEGs:** N×Ny = 4800×3600 (C6.1), then downscale.

Numbers:
- Midget, kx=1600/1599 and ky=1200/1199: M = [[1.4376916958078537e-13, −4.864582985843738e-13], [6.485008157924808e-13, 1.07933827485486e-13]].
- Golden, 1500/1499 and 1125/1124: M = [[5.32974488792573e-11, 1.2680829209659003e-10], [−1.690379118446715e-10, 3.997671210668109e-11]].

How much the kx choice matters:
- dots vs dots−1 moves the edge pixels by 0.4997 px (x, 1600) and 0.4996 px (y, 1200).
- kx = 4800/4799 vs kx = 1 differs by 0.17 px at the edge of a 1600-wide frame.
- Fractint-exact pixels are not square: the pitch ratio is (4/3)(Ny−1)/(N−1) = 0.99979 at 1600×1200.

MandelJS code that assumes an axis-aligned (u·spanX, v·spanY) mapping and must switch to M:
- kernel.ts:303-304 (escapeAtPt)
- kernel.ts:223 (perturbation reference search)
- pipeline.ts:373-375 (probe)
- main.ts:764-765 (box zoom)
- the `pixelSize = spanX*invW` uses in kernel.ts and colorizer.ts

**C2.7 Centre precision on the double path [SRC+EMP] (new; resolves an open question)**

Rule:
- On the double path the par centre is an IEEE double: the decimal is correctly rounded, and digits beyond double precision are dropped.
- Corner offsets are computed in double relative to that centre.
- On the bignum path the centre keeps its full precision.

Source: C1.3 and C2.1 (`Xctr = floatval[0];`, floatval is double).

Empirical (`S/reconcile/register_midget_center.py` and `midget_center_score.py`): native 4800×3600, box-downscaled to 1600×1200, registered against midgetbrot.jpg.

| Candidate | offset_x (px) | offset_y (px) | jsim mean (3x, Gaussian 0.45) |
|---|---|---|---|
| exact decimal centre (DD) | −0.0099±0.0017 | −0.0500±0.0015 | 8.177 |
| **double-rounded centre, exact per-pixel offsets** | −0.0007±0.0014 | −0.0036±0.0015 | **8.165** |
| Fractint double grid (fdbl-dd / fdbl-x87) | −0.0014 / −0.0016 | −0.0037 / −0.0038 | 8.397 / 8.397 |

- If the reference used the double centre, the predicted offset of the exact-centre candidate is (−0.0118, −0.0531) px: Xctr's dropped lo limb of −2.26e-17 mapped through M⁻¹. That matches the measurement, so the reference used the double-rounded centre (about 30σ in y).
- It did **not** show Fractint's per-pixel double quantisation of Re(c), which is 0.535 px at 1600 and 1.6 native px at 4800. The double-grid renders score worse (8.397 vs 8.165). [INFERRED; the gap is modest]
- MandelJS: on the double path, parse the centre to a double (lo limb = 0). On the bignum path keep a DD or string centre. In both cases iterate an exact per-pixel c around the centre (DD or perturbation).
- The effect here is ≤0.06 px.

**C2.8 NOROTATE, viewwindows, aspect [SRC]**

- Only the bifurcation and julibrot types ignore rotation; mandel and formula honour it. (`grep NOROTATE` fractalp.c: only HT_BIF and HT_JULIBROT.)
- viewwindows and aspectratio_crop are never applied on par load. aspectratio_crop is called only from prompts1.c/prompts2.c.
- Fractint pins the corners to the pixel grid and stretches when the pixel aspect ≠ 4/(3·Xmag).
- Both JPEGs are exactly 4:3.

**C2.9 Pixel-c precision in 20.04 [SRC+EMP]**

- c is a double.
- Midget: Re(c) is quantised to one ulp at 1.415, which is 2.22e-16 = 0.535 px at 1600. Only 2,837 distinct Re values occur. The emulated grid differs from the ideal one by at most 0.60 px (rms 0.23 px).
- Golden: at most 0.0008 px.
- Exact vs double-rounded c changes 13.6% of midget counts (quad iteration).
- The reference does not favour the double grid (C2.7). Recommendation: use exact c.

---
## 3. type=mandel, float=y

**C3.1 Calc routine [SRC]**

- Fractint uses calcmandfp, which runs `calcmandfpasm_p5` on a 386+ CPU with a 387+ FPU. This requires all of: inside ≥ −1, outside ≥ −6, bailoutest = mod, and no distest, decomp, biomorph, useinitorbit=1, jiim or orbitsave&2.
- Otherwise StandardFractal runs. Counting is the same in both.

Source (P00/frasetup.c#L233-246): `&& using_jiim == 0 && bailoutest == Mod` … `calctype = calcmandfp; /* the normal case - use calcmandfp */` … `if (cpu >= 386 && fpu >= 387)` … `calcmandfpasm_p5`.

**C3.2 z0, escape count, maxit [SRC+EMP]**

```
z = c + p                       // p = (param[0],param[1]); c = pixel (double)
for k = 1 .. maxit-1:
    z = z*z + c
    if |z|^2 >= rqlim: escaped, count = k     // rqlim = 4 unless bailout=/potential
inside (count = maxit)
```
- k is the textbook escape index minus 1. The textbook orbit starts at z0 = 0 and the first index tested is n = 2.
- For |c| ≥ 2 the count is 1.
- Counts range from 1 to maxit−1 (999 for midget).

Source:
- fractals.c mandelfp_per_pixel: `old.x = init.x + parm.x;`
- P00/calmanp5.asm#L89: `initx EQU <qword ptr init>`
- L225: `dec ecx ; always do one already`
- L445-446: `mov eax,maxit` / `sub eax,ecx ; leave 'times through loop' in eax`
- L450: `inc eax ; if (eax == 0 ) eax = 1`
- P00/calcfrac.c#L1750: `while (++coloriter < maxit)`

Empirical (midget idx-exact):
- as specified: 80.08%
- textbook count (+1): 5.07%
- −1: 5.62%

The colour report's flat-pixel agreement is 0.892 vs ≤0.081 for ±1. Measured count range: 135–967, with 576 inside pixels.

**C3.3 Bailout comparison [SRC+EMP] (reconciled)**

Rule:
- The Pentium-class path escapes when |z|² ≥ rqlim. An unordered (NaN) compare continues.
- The pre-386 8087/287 asm escapes on |z|² > rqlim.
- StandardFractal uses ≥.

Source:
- P00/calmanp5.asm#L349: `fcomp   st(5)                   ;  {y^2, x^2, y, x, b, Cy, Cx}`
- L378-379: `shr     ah,1` / `jnc     short overbailout_p5`. C0 = (mag < b); the jump is taken when C0 = 0.
- P00/calmanfp.asm#L385-388: `fcomp   st(7)` … `sahf` / `ja      over_bailout_287` (strict >).
- P04/fractals.c#L184-191: `if(magnitude >= rqlim) return(1);`

Empirical: the two comparisons are indistinguishable (midget 79.92% for both; golden 63.15% for both).

**C3.4 Iteration arithmetic [SRC+EMP]**

- 20.04 on DOS keeps z on the x87 stack and loads c as a double. The precision-control word is assumed to be extended (64-bit mantissa). [UNVERIFIED in source; supported empirically]
- ID on x64 iterates in double (libid/engine/calmanfp.cpp).

Empirical (midget):
- f64 vs 80-bit iteration: 19.3% of pixels differ (research:mandel C emulator); 18.6% in proto-midget.
- 80-bit vs quad: 0.62%. x87 emulation vs DD: 0.6%.
- The reference rejects plain f64 iteration:
  - 3x, Gaussian: jsim mean 8.40 for x87 vs 9.08 for f64.
  - research:mandel metric: exact-c quad 4.668, 80-bit 4.713, double 5.176.

MandelJS:
- Iterate midget-class views in DD or with perturbation. MandelJS already picks k1pert here, because the step 4.15e-16 is below 8·ulp(1.415).
- Plain f64 adds visible noise.

**C3.5 MandelJS Fractint-count kernel variant [SRC+EMP]**

Rule:
- Test `!(mag2 < rqlim)` at the same point in the loop as today. Keep z0 = 0 and the existing n counter.
- Set maxIters = maxit + 1, so that z_maxit is tested.
- On escape, count = max(1, n−1).
- Capped, shortcut and periodicity outcomes all mean inside.
- Store the integer in the field. Float32 is exact up to 2^24.
- When params ≠ 0 the textbook shift no longer holds, so implement the C3.2 loop directly (z0 = c + p).

Evidence:
- assemble.ts L32: `const BAILOUT2 = 256;` and L136: `if (mag2 > ${BAILOUT2})`.
- The Fractint count cannot be recovered from (n256, mu):
  - n256 − n4 is 1, 2 or 3 (9.8% / 73.9% / 16.2%).
  - The best formula from the smooth value is right for only 74–79% of pixels (research:mandel conv.py).

**C3.6 passes=g solid guessing [SRC+EMP]: compute every pixel**

Rule:
- 20.04 defaults to passes=g.
- The block size doubles as rows grow: 32 at 1200 rows, 64 at 3600.
- There is no edge guessing, and no symmetry for rotated frames.
- Guessing works on palette indices.

Source:
- cmdfiles.c#L722: `usr_stdcalcmode = 'g';`
- calcfrac.c#L3495: `|| xxmin!=xx3rd || yymin!=yy3rd)` (the setsymmetry early exit).

Empirical:
- 1600×1200, 80-bit emulation: the guessed render equals the full one in every pixel (58.55% of pixels computed).
- 4800×3600 (`S/reconcile`, emu_ld in guess mode):
  - 40.36% of pixels computed.
  - 4,786 native pixels (0.028%) differ. 4,587 of them are computed pixels that a later guess fill overwrote, which may be an emulator artefact above 2048 px. [UNVERIFIED]
  - After a 3x box downscale, raw mean distance is 13.980 with full computation vs 14.011 with guessing.
- Not worth emulating. goldenerror uses passes=1, so no guessing applies.

**C3.7 calcmandfp periodicity (the p5 asm scheme) [SRC+EMP]**

Rule:
- closenuff = ddelmin·2^−|periodicity|, where ddelmin = min(max(|delxx|,|delxx2|), max(|delyy|,|delyy2|)).
- periodicity = 0: checking is off.
- Start of the checking window (oldcoloriter), per pixel:
  - on reset: maxit−250;
  - after an escape with ecx left: ecx−10, or 0 (never) if that is negative;
  - after an inside or caught pixel: −1 (check at once).
- Checking is active while ecx < oldcoloriter, compared unsigned.
- savedand and savedincr both start at 1.
- When (ecx & savedand) == 0, save z (as a double). Every nextsavedincr saves, savedand = 2·savedand + 1.
- A hit is |Δx| ≤ closenuff and |Δy| ≤ closenuff. It gives the inside colour when periodicity > 0, or colour 7 when periodicity < 0.

Source:
- P00/calcfrac.c#L689: `closenuff = ddelmin*pow(2.0,-(double)(abs(periodicitycheck)));`
- P00/fracsubr.c#L480-491: `/*     min(max(delx,delx2),max(dely,dely2)      */`
- calmanp5.asm#L157-158: `mov eax,maxit ; yup.  reset oldcolor to maxit-250`
- L169: `mov     savedand_p5,1`

Empirical (midget):
- closenuff = 4.053e-16/1024 = 3.96e-19.
- 80-bit emulation: 0 detections.
- Double emulation: 222 detections, all on truly inside pixels.
- ID-logic emulation: 194 hits, all inside.
- No effect on the image.

---
## 4. type=formula, float=y (frm dialect)

This dialect must be a separate front end. It is incompatible with `src/formula.ts` in several places: `^` associativity, unary minus, `abs`, `|z|`, `re`/`im` vs `real`/`imag`, implicit multiplication, and predefined `c`.

**C4.1 Lexing [SRC+EMP]**

- Spaces, tabs and CR are deleted everywhere.
- Everything is lowercased.
- `;` starts a comment; a backslash joins lines; a newline becomes `,`.

Source:
- P00/parser.c#L2998-3018: `case ' ' : case '\t' : break;` … `return tolower(c);`
- L3363: `this_token->token_str[0] = ',';`

Harness: `my var = 1 5` stores 15 into `myvar`.

**C4.2 Statements [SRC+EMP]**

- `,` and newline separate statements; runs of separators collapse.
- At most one `:`. It splits the per-pixel init from the per-iteration loop. With no `:`, everything is loop.
- Identifiers are `[a-z_][a-z0-9_]*`, at most 32 characters.
- Assignment is allowed only at the start of a statement.
- Predefined names can be assigned.

Source:
- parser.c#L2535: `case ',': case ';': if(!ExpectingArg) {`
- L2546: `case ':': … o[posp].f = EndInit;`

**C4.3 Precedence [SRC+EMP]**

Lower p binds tighter. Each enclosing paren or `|..|` level, and each preceding `=` in the statement, subtracts 15. Equal p is left-associative.

| p | Operators |
|---|---|
| 1 | function call, load |
| 2 | unary −, `^`, modulus bars |
| 3 | `*` `/` |
| 4 | `+` `-` |
| 5 | `=` (right side lowered, so assignment is right-associative and yields its value) |
| 6 | `< <= > >= == !=` |
| 7 | `&&` and `\|\|` (same level) |

Source:
- parser.c#L2615-2616: `o[posp].f = StkPwr; o[posp++].p = 2 - (paren + Equals)*15;`
- L2164: `while(o[ThisOp].p > o[NextOp].p && NextOp < posp)`
- help2.src#L2562

Harness results:
- `2^3^2` = 64
- `-a^b` = `(-a)^b`, so `-a^2` = +a²
- `-2^2` = 4 (a numeric literal absorbs the minus)
- `1<2 || 3<2 && 5<4` = 0
- no implicit multiplication (`2z` is an error)
- `2^-3` is an error; `2^(-3)` is fine

**C4.4 Execution, bailout, escape count [SRC+EMP]**

```
per pixel: pixel=c(col,row); scrnpix=(col,row); whitesq=((col+row)&1,0); overflow=0
  run INIT once (never tested)
  for k = 1 .. maxit-1:
     run LOOP; last = value left by the last EXECUTED statement (if/elseif conditions count)
     if real(last) == 0 or overflow: escaped, count = k
     StandardFractal periodicity check on z (C4.14)
  inside (count = maxit)
```
- There is no default bailout: the parser never reads `bailout=` or rqlim (0 grep hits in parser.c and parserfp.c).

Source:
- parser.c#L2753: `return(Arg1->d.x == 0.0);`
- calcfrac.c#L1750: `while (++coloriter < maxit)`
- calcfrac.c#L1800: `|| overflow) break;`
- fractalp.c#L1129: `Formula, form_per_pixel, fpFormulaSetup, StandardFractal,`

Empirical (golden idx-exact):
- count as specified: 63.15%
- −1: 3.03%; +1: 5.43%; ±2: under 3%

The colour report's flat-pixel agreement is 0.9995 vs ≤0.062 for ±1.

**C4.5 State persistence [SRC+EMP]**

User variables, z and reassigned predefined names are **not** reset per pixel. They carry over from the previous pixel in traversal order. Only pixel, scrnpix and whitesq are set per pixel.

Source: parser.c#L1947: `v[vsp].a.d.x = v[vsp].a.d.y = 0.0;` runs at parse time only.

Harness: `k=k+1` gives 3, 4, 5 on successive pixels.

MandelJS should reset per pixel and warn on read-before-write (see owner decisions).

**C4.6 Modulus, comparisons, logic [SRC+EMP]**

- Modulus bars return (x²+y², 0): the **squared** modulus.
- Comparisons and `&&`/`||` look only at real parts and return (1,0) or (0,0). Both sides are always evaluated (no short circuit).
- There is no `!` and no `%`.

Source:
- parser.c#L959: `Arg1->d.x = (Arg1->d.x * Arg1->d.x) + (Arg1->d.y * Arg1->d.y);`
- L1498: `Arg2->d.x = (double)(Arg2->d.x < Arg1->d.x); Arg2->d.y = 0.0;`

**C4.7 Power [SRC]**

- x^w = exp(w·Log x), with Log = (ln|x|, atan2(y,x)).
- For save_release ≥ 1900, a zero base gives (0,0) with no overflow, in both the C parser and the DOS fast parser.
- ID master's formula_power instead sets overflow for a zero base when g_version ≥ 1900. That differs from 20.04.
- The DOS fast parser rewrites real **constant** exponents: 2 → sqr (without updating lastsqr), 1 → ident, 0 → one, −1 → recip. p1..p5 count as constants only if never assigned.

Source:
- mpmath_c.c#L206: `if(ldcheck == 0)` … `z.x = z.y = 0.0; return(z);`
- loadfile.c#L1009-1013: `(save_release < 1900 || debugflag == 94)) ldcheck = 1; else ldcheck = 0;`
- P00/parsera.asm#L1106-1113: `test _ldcheck, 1 ; user wants old pwr?` … `fldz` `fldz` `EXIT_OPER Pwr ; return (0,0)`
- parserfp.c#L1071: `/* change ^[-1,0,1,or 2] to recip,one,ident,sqr */`
- ID libid/fractals/interpreter.cpp#L154-157: `if (base.x == 0.0 && base.y == 0.0 && !(g_version < 1900)) { g_overflow = true;`

Not exercised: golden's z is never 0, and its exponents are assigned variables.

**C4.8 Division and overflow [SRC+EMP]**

Rule:
- m = |y|². yr = y.re/m, yi = −y.im/m. Result = (x.re·yr − x.im·yi, x.re·yi + x.im·yr).
- On DOS, division by 0 returns (1e300, 1e300) and sets overflow.
- recip, tan, tanh, cotan and cotanh set overflow when |denominator| ≤ DBL_MIN.
- Overflow makes the pixel escape at the current iteration.

Source:
- allegro/fpu087.c#L52-53: `yxmod = y->x/mod;` `yymod = - y->y/mod;`
- fpu087.asm#L202: `mov   overflow, 1`
- parser.c ChkFloatDenom: `if (fabs(denom) <= DBL_MIN) { if (save_release > 1920) overflow = 1; return; }`

Empirical (golden, `S/reconcile/results_z0_ulp.json`):
- j = 1/(f−b) is −3.762227238525207 with Fractint's division and −3.7622272385252065 with plain division.
- z0 comes out as …684 or …685 depending on how the log is written.
- A 1-ulp change in z0 changes 1.42% of escape counts (665 of 46,750). That is below the 10.7% rounding floor (C7.2).
- Use Fractint's division formula; bit parity is not reachable anyway.

**C4.9 Built-in functions [SRC+EMP]**

- **Directly callable:** sin sinh cos cosh sqr log exp abs conj real imag fn1-fn4 flip tan tanh cotan cotanh cosxx srand asin asinh acos acosh atan atanh sqrt cabs floor ceil trunc round.
- **Bindable only through fnN (cannot be called directly):** ident, recip, zero, one.
- **Definitions:**
  - `abs` works per component.
  - `cabs` = sqrt(x²+y²).
  - `real` = (x,0); `imag` = (y,0); `flip` swaps x and y; `conj` negates y.
  - `sqr` also sets lastsqr = (x²+y², 0).
  - `sqrt` uses polar form.
  - `round` = floor(x+0.5) per component.
  - `trunc` in the C parser is an `(int)` cast.
  - `cosxx` = conj(cos).
  - `log(0)` = (0,0) in the DOS asm.
- **fnN defaults:** sin/sqr/sinh/cosh. `function=ident` makes fn1(pixel) = pixel.

Source:
- parser.c FnctList#L2074
- L570: `Arg1->d.x = fabs(Arg1->d.x);`
- L776: `floor(Arg1->d.x+.5)`
- prompts1.c#L1164 (trigfn table)

Harness:
- `ident(pixel)` gives "Undefined Function".
- `abs((-1,-2))` = (1,2).
- `round((-2.5,2.5))` = (−2,3).

**C4.10 Predefined variables [SRC+EMP]**

- pixel, p1..p5, z, lastsqr
- pi = atan(1)·4, e = exp(1)
- rand
- whitesq = ((col+row)&1, 0), scrnpix = (col,row), scrnmax = (xdots,ydots)
- maxit = (maxit,0), ismand (default 1)
- center = (Xctr,Yctr), magxmag = (Mag,Xmag), rotskew = (Rot,Skew)

`c` is **not** predefined in Fractint.

Source: parser.c#L2169 (Constants list).

**C4.11 20.04 parse quirks [SRC+EMP] (not exercised)**

- `-(`literal`)` folds the minus into atof("(…"), so `-(3)` = 0 and `-(1,2)` = (0,2).
- Signed exponents misparse: `1e-3` = −2.999 and `1e+3` = 1003.
- Two numbers separated by a comma merge into a complex constant, even across statements.

Source:
- parser.c#L1965-1986: `if(o[posp-1].f == StkNeg) { posp--; Str = Str - 1;` … `z.x = atof(Str);`
- L2633: `while(isalnum(Str[n+1]) || Str[n+1] == '.' || Str[n+1] == '_')`

**C4.12 float=y, fast parser, precision class [SRC+EMP]**

- float=y selects FFORMULA with D_MATH.
- DOS on a 387+ runs the fast asm parser unless `rand` is used. Its intermediates are 80-bit and are rounded to double on store.
- The formula type has **no bignum support**. BF_MATH exists only for mandel, julia, manzpower and julzpower.

Source:
- parser.c#L3814: `if (RunFormRes && fpu >=387 && … && !Randomized) return CvtStk();`
- P00/fractalp.c#L329, L351, L896, L908: `…+BAILTEST+BF_MATH`

Empirical:
- 40-digit mpmath equals f64 on a test patch, so f64 is precise enough at golden's Mag of 1.5e10.
- Between any two IEEE implementations (JS f64, C parser, x87 emulation), about 11% of escape counts differ.

**C4.13 goldenerror numbers [SRC+EMP]**

- a = −1, b = 1.68, d = 1, f = 1.4142
- g = 0.70711356243812762, h = 1, j = −3.76222723852520(65|70)
- base = (−a)·b·g·h = 1.1879507848960544
- z0 = base^j + p4 = 0.5231078513927684(±1 ulp), the critical point of a·z^b + d·z^f
- k = 1, l = 100, c = fn1(pixel) = pixel
- loop: z = −z^1.68 + z^1.4142 + pixel while |z|² < 100
- counts 516–3199; inside 3200

**C4.14 StandardFractal periodicity [SRC+EMP] (reconciled)**

```
nextsavedincr = max(4, (int)log10(maxit));  firstsavedand = 2*nextsavedincr + 1   // 9 for maxit 1000..99999
per pixel:
  periodicity==0 or inside==zmag/startrail -> never check
  inside==period -> oldcoloriter = (maxit/5)*4
  reset_periodicity (row start in passes=1/2) -> oldcoloriter = 255
  else inherited: previous escape -> count+10 ; previous inside/caught -> 0
  oldcoloriter = max(oldcoloriter, firstsavedand);  savedand = firstsavedand (16 if inside=period);  savedincr = 1
  per iteration, AFTER the bailout test, if k > oldcoloriter:
     if (k & savedand)==0: saved=z; if --savedincr==0 { savedand=2*savedand+1; savedincr=nextsavedincr }
     else if |saved.x-z.x| < closenuff && |saved.y-z.y| < closenuff: coloriter = maxit-1 -> inside
```
**MINSAVEDAND is not active in 20.04**: its `#define` sits inside `#if 0`.

Source:
- P00/calcfrac.c#L1583-1585: `#if 0` / `#define MINSAVEDAND 3   /* if not defined, old method used */` / `#endif`. The same appears at P04 common/calcfrac.c#L1747-1749 and JH common/calcfrac.c#L1768-1770.
- L567-569: `nextsavedincr = (int)log10(maxit);` … `firstsavedand = (long)((nextsavedincr*2) + 1);`
- L1639: `oldcoloriter = 255; /* don't check periodicity 1st 250 iterations */`
- L1646: `if (oldcoloriter < firstsavedand) /* I like it! */`
- L1713: `savedand = firstsavedand;`
- L2053: `if (fabs(saved.x - new.x) < closenuff)`
- L2090: `coloriter = maxit - 1;`
- L2102-2105

Empirical (golden, full 1500×1125 frame in scan order, passes=1; `S/reconcile/results_period_golden.json`):
- Source rule (firstsavedand = 9): 139 pixels caught early, **0 count changes and 0 colour changes** vs periodicity off.
- The prototype's MINSAVEDAND = 3 variant: 151 caught, 0 changes.
- No effect on this image.
- At the default periodicity = 1, closenuff = ddelmin/2, which can create false insides at shallow zooms.

---
## 5. Colour

**C5.1 colors= decoding [SRC+EMP]**

- Three characters per entry, in R, G, B order, each a 6-bit value.
- Character values: `0-9` → 0–9, `A-Z` → 10–35, `_` → 36, backtick → 37, `a-z` → 38–63.
- Any other character is an error.
- Both pars decode to exactly 256 explicit entries.

Source: P00/cmdfiles.c#L2903-2909: `else if (k <= 'Z') k -= ('A'-10);` … `else k -= ('_'-36);`

**C5.2 `<n>` interpolation [SRC] (not exercised)**

- n must be ≥ 2. `<n>` cannot be the first or last token, and cannot follow another `<n>`.
- It fills n entries per channel in the 6-bit domain: val = (c·E + (n+1−c)·S + (n+1)/2) div (n+1), for c = 1..n.
- A channel whose start and end values are equal is copied unchanged.

Source: parse_colors: `(BYTE)(( cnum *dacbox[i][j] + (i-(start+cnum))*dacbox[start][j] + spread/2 ) / (BYTE) spread)`

**C5.3 Missing entries, @mapfile [SRC] (not exercised)**

- Entries not given become (40,40,40) in 6-bit.
- More than 256 entries is an error.
- `@file.map` holds 8-bit "r g b" lines. Each value is stored as (v%256)>>2.

Source:
- `while (i < 256) { dacbox[i][0] = dacbox[i][1] = dacbox[i][2] = 40;`
- JH common/loadmap.c#L46-98: `dac[index].red = (BYTE)((r%256) >> 2);`

**C5.4 6-bit → 8-bit [SRC+EMP]**

Rule: out = (v<<2) | (v>>4), which equals (v<<2) + (v>>4). So 63 → 255 and 32 → 130.

Source:
- P00/encoder.c#L551-552: `thiscolor = (BYTE) (thiscolor << 2);` `thiscolor = (BYTE) (thiscolor + (BYTE) (thiscolor >> 6));`
- ID color_utils.h `expand_6bit_color`.

Empirical (flat-region fits):

| Scaling | midget RMSE | golden RMSE |
|---|---|---|
| (v<<2)\|(v>>4) | **0.54** | **0.70** |
| round(v·255/63) | 0.59 | 0.81 |
| v·4 | 1.16 | 2.46 |

- Where (v<<2)|(v>>4) and round(v·255/63) differ, (v<<2)|(v>>4) wins 9 of 10 cases. Example: v = 49 red is observed at 199.0 (the two predict 199 and 198).
- Golden entry (63,49,0) is observed at (254.9,198.8,0.9); v·4 would give (252,196,0).
- The geometry report's v·4 vs v·255/63 test did not separate them (MAE 10.788 vs 10.755).

**C5.5 Count → coloriter [SRC+EMP]**

StandardFractal:
- A count of 0 for an escaper becomes 1.
- The outside < −1 modes (real, imag, mult, summ, atan, fmod, tdis) transform the count. If the result is ≤ 0 or > maxit, it becomes 1 (except fmod).
- `if (outside >= 0 && attracted == FALSE) coloriter = outside; else if (LogTable || Log_Calc) coloriter = logtablecalc(coloriter);`
- Inside:
  - periodicity < 0 and a cycle was caught → 7;
  - inside ≥ 0 → the inside value, with **logmap ignored**;
  - inside = −1 → maxit, then logmap;
  - the other inside modes compute their own value.

calcmandfp applies logmap only when `(realcoloriter < maxit || (inside < 0 && coloriter == maxit))`.

Source:
- P00/calcfrac.c#L2231-2234
- L2241: `coloriter = inside; /* set to specified color, ignore logpal */`
- L1550-1553
- L2106: `if (coloriter == 0)`

Empirical: every JPEG index-0 pixel (285 of them) is inside in the midget render. Golden's inside region is black in the reference (flat median 5.1).

**C5.6 logmap [SRC+EMP]**

```
MaxLT = maxit                       // 32767 only with logmode=table (or release<=1920 && maxit>32767)
logmap=yes(1) or n>1:
  lf  = n>1 ? min(n, MaxLT-1) : 0
  mlf = (colors - (lf?2:1)) / ln(MaxLT - lf)
  f(ci) = 1                           if ci <= lf          (lf+1 in JH/ID: same output)
        = ci - lf                     if (ci-lf)/ln(ci-lf) <= mlf     [save_release<2002: ci-lf+(lf?1:0)]
        = floor(mlf*ln(ci-lf)) + 1    otherwise
logmap=old(-1): mlf=(colors-1)/ln(MaxLT); f(0)=1; f(ci)=floor(mlf*ln ci)+1
logmap=-n (n>=2): lf=min(n,MaxLT-1); mlf=(colors-2)/sqrt(MaxLT-lf);
  f = ci<=lf ? 1 : (ci-lf <= (ulong)(mlf*mlf) ? ci-lf+1 : floor(mlf*sqrt(ci-lf))+1)
logmap=2/-2 or logmode=auto: lf = sign * min realcoloriter on the image border (computed first)
Table: LogTable[i]=f(i) for i in 0..MaxLT (BYTE); lookup LogTable[min(coloriter,MaxLT)]; needs colors>=16
```
Source:
- P00/calcfrac.c#L573: `MaxLTSize = maxit;`
- P00/mpmath_c.c#L464: `mlf = (colors - (lf?2:1)) / log(MaxLTSize - lf);`
- L540-550: `if ((unsigned long)citer <= lf) ret = 1;` … `if (save_release < 2002) ret = (long)(citer - lf + (lf?1:0)); else ret = (long)(citer - lf);` … `ret = (long)(mlf * log(citer - lf)) + 1;`

Golden (logmap=538, maxit 3200):
- mlf = 32.20557605741785.
- citer ≤ 539 → 1; 540–702 → 2–164 (linear); 703 → 165; 3199 → 254; 3200 → 255.
- The `≤lf` and `≤lf+1` variants give identical output over 0..3200 (checked in `S/reconcile`).
- JS `Math.log` reproduces the table exactly. The nearest any value comes to an integer is 1.0e-4, at citer 2013. The only exact integer, mlf·ln(2662) = 254, sits at citer = maxit (inside), which inside=0 never uses. [With inside=−1 that entry would be a razor edge; UNVERIFIED on x87]

Empirical (golden idx-exact):
- 20.04 rule: 63.15%; MaxLT = maxit±1: 63.15%; pre-2002 rule: 5.43%; no linear segment: 1.08%.
- Colour report, all pixels: lf = 537 → 0.062; lf = 539 → 0.034; no logmap → 0.002.

**C5.7 ranges= [SRC] (not exercised)**

- Values must be ascending integers. The iterations up to v_k map to colour k.
- `-w/limit` makes stripes that alternate k and k+1 every w iterations; k then advances by 2.
- The last range extends to MaxLT.
- ranges= forces LogFlag = 0.

Source: calcfrac.c: `LogTable[l++] = (BYTE)(k + flip); if (++m >= altern) { flip ^= 1;`

**C5.8 Colour wrap [SRC] (not testable here)**

Rule:
- If coloriter ≥ colors: idx = ((coloriter−1) % (colors−1)) + 1 when colors ≥ 16 (release > 1950), or coloriter & (colors−1) when colors < 16.
- For 256 colours this is idx = c < 256 ? c : ((c−1) % 255) + 1.

Source:
- P00/calcfrac.c#L1566: `color = (int)(((coloriter - 1) % andcolor) + 1);`
- andcolor = colors − 1.

Empirical: undecidable here. Only 0.3% of midget pixels have counts ≥ 256, and all are in filaments.

**C5.9 MandelJS colour pipeline (implementation contract)**

- **Field.** Store an integer count per (sub)sample, with maxit (or +Inf) meaning inside. The Float32 `mu` field holds these exactly.
- **Index LUT.** `LUTidx[0..maxit]` applies outside/logmap/ranges, then the wrap. Inside maps to the inside index.
- **Palette.** `pal8[256]` from `colors=` using (v<<2)|(v>>4). **No interpolation**: do not use the 1024-entry gradient in palette.ts.
- **Recolour.** RGB = pal8[LUTidx[k]]. Changing the palette or logmap costs O(maxit) + O(pixels), so instant recolour is kept.
- **Supersampling.** Map each subsample to RGB first, then average in **sRGB**. Do not average counts or mu. The FieldStore SSAA cache (`ssaaMu`) should keep the raw integer subsamples.
- Evidence: sRGB averaging beat linear-light averaging, median 23.41 vs 30.97 (golden, n=5 box).

---
## 6. Reference images: provenance and reproduction recipe

**C6.1 Both references were rendered at native 4800×3600 and downscaled [EMP]**

Midget (`S/reconcile/register_midget.py`). Slope units are 1e-4 per px.

| Candidate (box downscale to 1600×1200) | measured slope x / y | predicted if ref = 3x | predicted if ref = 4x |
|---|---|---|---|
| point-sampled 1600 | 3.672±0.079 / 4.863±0.095 | 4.169 / 5.560 | 4.690 / 6.255 |
| 3200×2400 | 0.846 / 1.132 | 1.042 / 1.390 | 1.563 / 2.085 |
| **4800×3600** | **−0.044±0.042 / −0.059±0.049** | 0 / 0 | 0.521 / 0.695 |
| 6400×4800 | −0.491±0.041 / −0.593±0.046 | −0.521 / −0.695 | 0 / 0 |

- This gives 3x (native 4800×3600). It supersedes the geometry report's ≈4x reading, which came from a scale-sweep vertex at 0.99953.
- Golden (proto-goldenerror register.py): the 4800×3600 box candidate has residual slope 0.040±0.022 / 0.072±0.026, offset 0.001 px. That is 3.2x, the same 4800×3600 native size.
- ID's id.cfg has `CF7 , 4800, 3600,256,disk,3x antialias UXGA`, which is consistent. [INFERRED]
- The par time comments (SF5 = 640×480 on a P200/P4) describe the original sessions. The JPEGs are later re-renders. [INFERRED]

**C6.2 Downscale kernel [EMP]**

Midget, 3x DD (jsim mean):

| Kernel | jsim mean |
|---|---|
| box | 10.38 |
| PIL bicubic | 9.74 |
| PIL bilinear | 8.86 |
| **Gaussian σ = 0.45 output px, then 3×3 area** | **8.18** |

At 4x the same Gaussian kernel gives 8.05.

Golden, 4800×3600 (jsim median/mean):

| Kernel | jsim median / mean |
|---|---|
| box | 17.26 / 22.91 |
| triangle R = 1.25 | 11.53 / 14.32 |
| Gaussian σ = 0.6 | 11.18 / 13.96 |
| PIL bilinear chain 4800 → 1600 → 1500 | 11.05 / 13.66 |

A single model gets within 1.5% (midget) and 2% (golden) of the best per-image kernel: ≥3x supersampling plus a Gaussian of σ ≈ 0.45–0.6 output px, averaged in sRGB.

**C6.3 Precision fingerprint of the midget reference [EMP / INFERRED]**

- The centre is double-rounded (C2.7).
- There is no per-pixel double grid (C2.7, weak evidence).
- Iteration precision is at least 80-bit (C3.4).

So it is neither DOS 20.04 at 4800 (which would have the double grid) nor plain-double ID. It is consistent with a perturbation or extended-precision renderer seeded at a double centre. [INFERRED]

Golden: nothing can be inferred beyond double-class arithmetic, because of the rounding floor.

**C6.4 JPEG properties [EMP]**

- Both are 4:2:0.
- midget: quality ≈80 (luma table begins 6,4,4,6,10,16,20,24).
- golden: quality ≈70 (luma table begins 10,7,6,10,14,24,31,37).
- Both embed an ICC profile "sRGB, Google Inc. 2016".
- There is no gamma shift: flat-colour bias is ≤ ±0.6 levels, and saturated blues read about 1 level low.
- JPEG-only error budget, measured as max-channel |err| of a palette-snapped image re-encoded (p50/p90/p99):
  - midget: 3 / 18 / 35
  - golden: 12 / 26 / 42

**C6.5 Recommended metrics and acceptance**

- **Tier 1 (semantics; point-sampled at the JPEG size, stride sampling is fine).**
  - idx-exact on unambiguous pixels: midget ≥ 0.79 (achieved 0.80), golden ≥ 0.62 (achieved 0.63).
  - Negative controls (rotation flip, count ±1) must fall below 0.10.
- **Tier 2 (appearance; ≥3x supersampling + Gaussian 0.45 output px, jsim).**
  - mean: midget ≤ 8.6 (achieved 8.17), golden ≤ 14.5 (achieved 13.66–13.96).
- **Also:** flat-region palette means within ±2 levels.
- The thresholds are proposals for the owner to tune.

---
## 7. Residual mismatch after the best reconciled variant

**midgetbrot**

Best variant: DD iteration with Fractint geometry (double-rounded centre, exact offsets), Fractint count/wrap/palette, native 4800 (3x) or 6400 (4x), Gaussian 0.45 + area.

| Variant | jsim mean | jsim median | raw mean |
|---|---|---|---|
| 3x | 8.165 | 3.16 | 11.67 |
| 4x | 8.046 | 3.16 | 11.59 |

At 4x, idx-exact / ±1 by region:
- all pixels: 82.0% / 92.3%
- flat: 98.3% / 99.9%
- band edges: 90.1% / 99.5%
- filaments: 64.9% / 81.7%

Causes of the remaining mismatch:
1. Sub-pixel chaotic filament detail. Filaments are 57% of pixels; the minibrot ring (r < 140 px) has mean 15.6. Averaging differs whenever sample positions differ.
2. The exact anti-aliasing kernel is unknown (C6.2).
3. JPEG at q≈80: the median is already at the JPEG floor (p50 3).
4. Precision. f64 would add noise, but the chosen DD/perturbation does not.
5. Solid guessing: ≤0.028% of native pixels, and the reference slightly prefers full computation.
6. Periodicity: no effect.

**Not worth chasing.** Keep DD/perturbation, the double centre and ≥3x supersampling.

**goldenerror**

Best variant: native 4800×3600, chained PIL bilinear downscale (4800 → 1600 → 1500).
- sampled raw: 17.69 median / 23.34 mean
- jsim: 11.05 / 13.66
- blurred (σ 2): 4.80 / 5.71
- idx-exact 74.1%, ±1 83.1%
- The maximum 21-px box-blurred error is < 60, so there is no structural disagreement.

Causes of the remaining mismatch:
1. Chaotic busy regions. These are 42% of pixels with median 28, against a flat median of 5.4, which is the JPEG floor.
2. Rounding floor. A rounding-only reformulation changes 8.4% of palette indices (10.7% of counts). A 1-ulp change in z0 changes 1.42% of counts. So neither the x87 fast parser nor the C parser can be matched bit for bit.
3. The resampler is unknown.
4. JPEG at q≈70 with 4:2:0.
5. Periodicity with the source rule: 0 changes. Solid guessing: not applicable (passes=1).

**Not worth chasing.**

---
## 8. Semantics NOT exercised by these pars (importer checklist)

**Geometry**
- corners= with an explicit third corner (C2.3). [SRC]
- Xmag ≠ 1, including negative Xmag (mirror). Within 2% it snaps to ±1. [SRC]
- Near-axis rotation (below about 0.008°) triggers the third-corner snap. [SRC]
- Mag ≥ 1e13: bignum centre and corners.
  - The float→bf switch happens when the ratio of accumulated to exact extent falls outside 1 ± mathtolerance[1] (default 0.05). A value ≥ 1 disables the switch; ≤ 0 forces it. [SRC] fracsubr.c#L989-991: `if(tol <= 0.0)` … `else if(tol >= 1.0)`.
  - The double-centre rule (C2.7) does not apply on this path.
  - Only mandel, julia, manzpower and julzpower support bf. [SRC]
- Unrotated frames that straddle the real axis get Fractint symmetry mirroring (rows copied, not computed). This only matters for pixel parity. [SRC] calcfrac.c#L3495
- Canvas aspect ≠ 4/(3·Xmag): Fractint stretches (C2.8). [SRC]
- NOROTATE types (C2.8). [SRC]

**Mandel family and escape-time options**
- params ≠ 0: z0 = c + p. [SRC]
- type=julia: z0 = pixel and c = params. StandardFractal starts coloriter at −1: P00/calcfrac.c#L1703-1704 `if(fractype==JULIAFP || fractype==JULIA)` / `coloriter = -1;`. The count convention therefore differs by one from mandel. calcmandfp agrees (calmanp5.asm dojulia_p5: ecx = maxit with no `dec`, z1 computed before the loop, count = maxit − ecx with the zero-fix to 1): an escape at step k counts max(1, k − 1), and z_maxit is still tested. [SRC; implemented in the Kernel 2 Fractint shape for z²+c Julia]
- float=n, the DOS default after reset: 32-bit fixed-point iteration (calcmand) with an automatic int→float switch governed by mathtolerance[0]. MandelJS should render in float and warn. [SRC] cmdfiles.c#L727-728
- `bailout=N`: rqlim = N, compared against |z|² (not |z|). Precedence: potential param[2] > bailout= > biomorph (100) > type default (4). Integer types clamp rqlim to ≤127. [SRC] fracsubr.c#L268-278
- bailoutest=real/imag/or/and/manh/manr tests, respectively, x² ≥ r; y² ≥ r; x² or y² ≥ r; x² and y² ≥ r; (|x|+|y|)² ≥ r; (x+y)² ≥ r. Any test other than mod forces StandardFractal. [SRC] P04/fractals.c#L184-257
- Inside modes:
  - codes: maxiter(−1), zmag(−59), bof60(−60), bof61(−61), epscross(−100), startrail(−101), period(−102), fmod(−103), atan(−104)
  - inside < −1 forces StandardFractal
  - each mode needs its own port
  - [SRC] P04 headers/fractint.h#L577-592; semantics not researched.
- Outside modes:
  - codes: real(−2), imag(−3), mult(−4), summ(−5), atan(−6), fmod(−7), tdis(−8), or a constant ≥ 0
  - each mode needs its own port
  - [SRC] same header; semantics not researched.
- potential=, distest=, decomp=, biomorph= and finattract= are alternative colouring algorithms that disable calcmandfp. [SRC names; semantics not researched]
- periodicity: <0 gives colour 7 for caught pixels; 0 disables; the default 1 is loose enough to create false insides (C3.7, C4.14). [SRC]
- passes=1/2/g/b/…: these only change which pixels are computed. [SRC]
- maxit > 32767: logmap is computed on the fly. [SRC]

**Formula**
- if/elseif/else/endif. The last executed statement is the bailout, so a false `if` with no `else` bails. [SRC+harness]
- rand/srand: a global RNG that depends on pixel order, is time-seeded without srand, and disables the fast parser. It can only be approximated. [SRC]
- scrnpix, scrnmax and whitesq depend on a render size that the PAR does not record. [SRC]
- ismand, center, magxmag and rotskew. [SRC]
- The fast parser's literal-exponent rewrites (C4.7). [SRC]
- fn defaults when `function=` is absent (C1.4). [SRC]
- The 20.04 parse quirks (C4.11). [SRC+harness]
- Overflow semantics (C4.8). [SRC]
- `trunc` as an (int) cast. The docs' claim that trunc(6/3)=1 is [UNVERIFIED].
- Formula symmetry headers: Fractint mirrors even when the image is not truly symmetric. [research:formula; header syntax UNVERIFIED]
- Formula precision is double only (C4.12). [SRC]

**Colour**
- `<n>` interpolation, missing entries, @mapfile (C5.2–C5.3). [SRC]
- logmap old/sqrt/auto (C5.6). [SRC]
- ranges= (C5.7). [SRC]
- colors < 16 wrap (C5.8). [SRC]
- inside=−1 goes through logmap (C5.5). [SRC]

**Release gates for older pars**
- wrap ≤ 1950
- logmap ≤ 1920 (fixed-point table with a "spread top" pass)
- logmap < 2002 (linear +1)
- pow ldcheck < 1900
- overflow in ChkFloatDenom > 1920
- [SRC] as cited above

**Out of scope for v1**
- Other fractal types: lambda, newton, lyapunov, IFS, L-systems, julibrot, 3D.
- Colour cycling.

---
## 9. MandelJS implementation touchpoints (summary)

1. Fractint PAR tokenizer (C1) in place of the line-based `stateFromPar`.
2. A View with a 2×2 affine: centre (DD or double per C2.7) plus M (C2.6), threaded through every touchpoint listed in C2.6.
3. A Fractint-count mandel kernel variant (C3.5) using pert/DD. Integer counts in the field.
4. An frm compiler (C4) that emits a "K3" kernel: per-pixel init block, loop body, last-value bailout, Fractint counting, overflow meaning escape.
5. An indexed colour path (C5.9): pal8, LUTidx, and sRGB averaging of supersamples.
6. An optional "match reference" quality mode (C6): full-frame ≥3x supersampling plus a Gaussian of about 0.45 output px.
7. A harness in goldens/ or tests/ using the C6.5 metrics against par/*.jpg.
