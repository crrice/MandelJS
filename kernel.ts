// kernel.ts — the pure compute core: escape-time + double-double orbit, distance
// estimate, band transform, per-region render, and sharpening. Stringified into
// the worker (see buildWorkerSource in index.ts) AND run synchronously on the main
// thread, so it references only bare-name module globals — which is why the build
// stays module:none (shared global scope). Concatenated first by tsc --outFile.

//---------------------------------------------------------------------------\\
// Core compute
//---------------------------------------------------------------------------\\

interface View {
	cx: number;    // center real axis — HI limb of a double-double
	cxLo: number;  // center real axis — LO limb. Center carried in DD so box-zoom can position it past
	cy: number;    // center imaginary axis — HI limb          the f64 wall (span stays f64: it's a magnitude)
	cyLo: number;  // center imaginary axis — LO limb
	spanX: number; // width of the view in the complex plane
	spanY: number; // height of the view in the complex plane
}

const DEFAULT_VIEW: View = { cx: -1, cxLo: 0, cy: 0, cyLo: 0, spanX: 4, spanY: 2 };

// Distance-coloring mode: smooth bands by log(distance in pixels). Higher =
// more bands. (Escape-time mode ignores this.)
const DIST_SCALE = 1.5;

// Supersampling: SS x SS sub-samples per pixel, colors averaged, to anti-alias
// the boundary. 1 = off. Applied ADAPTIVELY — only to pixels whose neighborhood
// isn't flat (edges / boundary), so most pixels stay at one sample.
const SS = 2;

// Adaptive-SSAA trigger: a pixel is supersampled when a 4-neighbor's color
// differs by more than this (|dR|+|dG|+|dB|). Lower = more pixels supersampled.
const EDGE_TH = 30;

// Escape radius. A larger radius than the classic |z| > 2 gives visibly
// smoother continuous coloring; 256 (radius 16) is the usual sweet spot.
const BAILOUT2 = 256;

// Escape radius² for the custom-formula path (escapeSmoothTierazon). The Tierazon repro
// specifies the classic |z|² ≥ 4 bailout; kept SEPARATE from BAILOUT2 so the z²+c coloring
// (which relies on the wide radius for smooth bands) is entirely unaffected.
const BAILOUT_CUSTOM2 = 4;

// Periodicity checking. If an orbit returns within this squared distance of a
// saved reference point, it has settled onto an attracting cycle -> the point is
// in-set, so we stop early instead of burning the whole iteration budget.
// EPS: the squared distance threshold for "the orbit returned to a saved point".
// This is DYNAMIC with zoom. At shallow zoom 1e-10 is the loosest bit-transparent
// value (fast: catches cycles early). But deeper, orbits run for millions of
// iterations and a chaotic exterior orbit brushes within 1e-10 of a past point by
// sheer recurrence -> a false in-set that bloats the boundary (measured 4.5% on a
// zoom-7e11 window). True attracting cycles converge to ~1e-15, far below the
// brushes, so tightening ε with depth removes the false positives with zero missed
// cycles (verified: 4.5% -> 0.04% at 1e-13, no in-set point lost). Below the noise
// floor (~1e-14) tightening would start dropping true cycles — that seam is where
// double-double precision would take over. PERIOD_EPS2 is the shallow base; the
// live value is computed per view by periodEps2For().
const PERIOD_EPS2 = 1e-20;          // base ε² (ε = 1e-10), used at shallow zoom
const PERIOD_EPS2_FLOOR = 1e-28;    // tightest ε² (ε = 1e-14) — the f64 noise floor
// Under double-double, the orbit difference z−z_ref is resolved to ~1e-32, so ε can
// tighten far past the f64 floor. Floored near the DD noise limit (ε ≈ 1e-28); a sweep
// showed the deep-zoom false-black vanishes by ε² ≈ 1e-31 and no true cycles drop even
// at 1e-56, so this floor is never the binding constraint within DD's usable range.
const PERIOD_EPS2_FLOOR_DD = 1e-56;
const PERIOD_EPS_ZOOM0 = 1e5;       // below this zoom, stay at the loose base

// Skip the periodicity check until an orbit has survived this many iterations.
// Fast-escaping exterior points (the bulk) never reach it, so they pay no
// per-iteration periodicity overhead; only near-boundary / interior orbits do.
const PERIOD_WARMUP = 64;

// Perturbation periodicity pre-filter (escapeSmoothPert only). The z-periodicity test
// needs a DD-precise |z_n − z_saved| to survive past the f64 wall, but running those DD
// ops on EVERY non-escaped iteration triples the (cheap f64) perturbation first-frame.
// So gate the DD compare behind a plain-f64 estimate of the same distance²: a non-cyclic
// exterior orbit sits O(0.01–2) from any earlier point — vastly outside this radius — so
// it's rejected in ~6 flops without touching DD; only genuine near-cycles fall through to
// the precise test. The radius is a FIXED absolute value (not periodEps2-scaled): it must
// stay above the f64 estimate's ~1e-16 noise at every depth (or deep-zoom cycles, whose
// true distance is far smaller, would be rejected), while sitting far below the exterior
// separations. 1e-24 = (1e-12)² — validated 0 lost cycles / 0 new false-positives vs the
// ungated check across the baseline and a near-eps-floor deep window.
const PERT_GATE2 = 1e-24;

// Sentinel returned by `escapeSmooth` for points PROVEN in-set — via the
// cardioid/bulb shortcut or a detected attracting cycle. Every escaped point
// yields a finite smooth value, so === is unambiguous.
const IN_SET = Infinity;

// Sentinel for points that hit the iteration cap UNRESOLVED — we don't yet know
// if they're in or out. Distinct from IN_SET so progressive sharpening can find
// exactly these points and re-iterate them at a higher cap; both color as the
// in-set color provisionally. -Infinity so `isFinite` rejects both sentinels at
// once wherever a real escape count is required (auto-leveling, ramp coloring).
const CAPPED = -Infinity;

// Side-channel output from `escapeSmooth`: the exterior distance estimate (in
// complex-plane units) for the most recent escaped point. A module global to
// keep the hot path allocation-free; embedded into the worker the same way.
let deDist = 0;

// Instrumentation side-channel: total iterations performed since last reset. A
// deterministic, scheduling-noise-free measure of compute — the primary metric
// for judging optimizations like periodicity checking (which cuts iterations on
// interior points). Accumulated in escapeSmooth, summed per tile, embedded into
// the worker like deDist.
let iterAcc = 0;

// Runtime toggle for periodicity checking, so we can A/B it (benchmark +
// correctness). Set per tile from the worker message; embedded like the globals
// above.
let periodOn = true;
// Live periodicity ε² (zoom-scaled). Set per tile from the worker message, like
// periodOn; escapeSmooth reads this rather than the PERIOD_EPS2 constant.
let periodEps2 = PERIOD_EPS2;
// Whether the current tile runs the orbit in double-double precision (deep views
// only). Set per tile from the worker message, like periodOn; renderRegion reads it
// to pick the f64 or DD sample path.
let useDD = false;
// Escape-time band transfer: 0 linear, 1 sqrt, 2 log2. A pure display choice (recolor,
// no re-iterate). Set per tile like periodOn; colorSample reads it. sqrt/log give
// zoom-stable, consistent banding across depth — see bandTransform.
let bandMap = 0;
// Kernel selector, read ONCE per pixel at the escapeAtPt boundary (never in a hot loop):
//   0 = "Kernel 1" — the hyper-optimized z²+c MANDELBROT engine (escapeSmooth/DD/pert, interior
//       shortcuts), the fast common case, left untouched.
//   1 = "Kernel 2" (escapeCustom) — a GENERALIZED version of Kernel 1: the same escape loop written
//       set-type-agnostically (takes z₀ and c explicitly), plus a formula switch and orbit-trap filter
//       hooks. It handles Mandelbrot AND Julia, any registered formula, escape-time or a filter — f64.
// The renderer routes to Kernel 1 only when nothing general is needed (z²+c ∧ Mandelbrot ∧ escape-time ∧
// no filter); everything else goes to Kernel 2. The z²+c fast path pays one well-predicted per-pixel branch.
let fractalMode = 0;
// Set type for Kernel 2: false = Mandelbrot (c = the pixel, z₀ = 0), true = Julia (c = the seed below,
// z₀ = the pixel). escapeAtPt wires z₀/c from this. Mandelbrot is the default.
let juliaMode = false;
let juliaCx = 0, juliaCy = 0;   // Julia seed c (used only when juliaMode)
// Iteration-formula selector for Kernel 2 (constant per frame → the per-iteration switch is predicted).
// 0 = z²+c (same math as Kernel 1); 1 = a user/preset formula compiled by formula.ts and run through the
// stepFormula seam below (the dropdown's named presets and "custom" all route here — see index.ts PRESETS).
const FORMULA_MANDEL = 0;
const FORMULA_CUSTOM = 1;
let formulaId = 0;
// Mandelbrot seed selector for Kernel 2. Normally z₀ = 0 (the canonical Mandelbrot seed). But some
// formulas are undefined at z=0 (e.g. c/z or log z need a nonzero z), which makes the z₀=0 Mandelbrot degenerate
// (every pixel NaN-escapes → solid color). For those, the renderer probes f(0), finds it non-finite, and
// sets mSeedAtC → seed z₀ = c instead. That's NOT a true Mandelbrot set (c isn't the critical orbit) — it's
// a heuristic PARAMETER MAP, flagged as such in the UI. Only ever true when z₀=0 genuinely fails.
let mSeedAtC = false;

// Filter selector for Kernel 2 (escapeCustom). Filters are accumulating orbit-trap colorers — an
// ALTERNATIVE to escape-time coloring: instead of "when did the orbit escape", they watch every
// orbit point and fold an accumulator into the pixel color (see filter-interface.md). This is the
// JS-native translation of that interface — the three hooks (init/onIteration/complete) become
// frame-constant globals + an inlined switch(filterId), NOT per-pixel objects with per-iteration
// virtual calls (which would allocate per pixel and defeat JIT inlining / worker stringification).
// 0 = FILTER_NONE (escape-time, the default — bit-identical to the pre-filter custom kernel).
const FILTER_NONE = 0;
const FILTER_XRAY_RINGS = 1;   // Tierazon filter #41: concentric ring orbit-trap, even/odd parity → red/cyan
let filterId = 0;
// x-ray rings trap geometry. The trap circle is centered at the z-origin with radius |c|. In JULIA
// mode c is the constant seed, so this is the "init" hook hoisted to per-FRAME setup (setupFilter,
// once per tile message). In MANDELBROT mode c = the pixel, so the limit is PER-PIXEL — escapeCustom
// recomputes it from the pixel's c at the top of each pixel (these globals hold the Julia case). trapDf
// is the falloff numerator (= dStrands).
let trapDStrands = 0.08;
let trapLimit = 0, trapLo = 0, trapHi = 0, trapDf = 0;
// Filter COLOR params (read by filterColor, not the kernel). filterDFactor is the exposure knob;
// filterRef is the frame-wide intensity reference (a dFactor-INDEPENDENT high percentile of the raw
// trap magnitude, set by the main thread's computeLevels — workers leave it 0 → per-pixel self-scale,
// a rough provisional the main thread then overwrites). filterBg is the packed miss/background color.
let filterDFactor = 1, filterRef = 0, filterBg = (255 << 24) >>> 0;   // bg default = opaque black
// Recompute the JULIA (frame-constant) trap geometry from the seed + dStrands. Called once per tile
// message (worker) and once per sync render — the per-frame "init" for the Julia case. Mandelbrot uses
// a per-pixel limit computed in escapeCustom instead. Stringify-safe (Math + the globals above).
function setupFilter(): void {
	trapLimit = Math.hypot(juliaCx, juliaCy);   // ring radius = |seed|
	trapLo = trapLimit - trapDStrands;
	trapHi = trapLimit + trapDStrands;
	trapDf = trapDStrands;
}
// DD op result scratch (hi, lo). The DD primitives write their two-limb result here
// instead of allocating a pair — keeps the hot path allocation-free, same trick as
// deDist. Copy _dhi/_dlo into locals immediately after each call (they're clobbered
// by the next DD op).
let _dhi = 0, _dlo = 0;

// Provisional coloring of CAPPED (unresolved) pixels. A high-dwell window whose minimum
// escape time exceeds the initial cap comes back 100% CAPPED → an all-black first frame,
// jarring even though idle-sharpening then resolves it. Instead of painting CAPPED the
// in-set color, shade it by a monotone structure signal — log|z'| at the cap, which ranks
// ~0.88 with the eventual escape band — through a paper→ink ramp (provLut), auto-leveled to
// [provLo, provHi]. That turns the black frame into a smooth "developing" underlay the real
// bands then resolve over. The CAPPED sentinel stays in the mu field, so sharpening and
// auto-leveling are untouched: this is a pure display layer. provOn gates it (mandelProv
// A/B). Each cap path stashes its log|z'| into deDist (unused by CAPPED pixels otherwise);
// colorSample reads it. Workers keep provOn=false (CAPPED→black per tile); the main thread
// levels the field and recolors once the frame lands.
let provOn = false, provLo = 0, provHi = 1;
let provLut: Uint32Array | null = null;

// Anti-aliasing (SSAA) toggle for renderRegion. The INITIAL pass sets this false → 1-sample,
// no border, no supersampling → the first frame lands ~3x faster (on a filament-heavy window,
// ~2/3 of renderRegion's cost is adaptive SSAA on the resolved boundary). A background pass
// (ssaaPoints) then anti-aliases only the edge pixels, off the critical path. The sync (no-worker)
// fallback keeps it true (renders crisp in one blocking call). Set per tile from the worker message.
let ssaaOn = true;

// Perturbation (deep-zoom fast path): iterate each pixel as its deviation δ from ONE shared
// high-precision reference orbit, in plain f64 — ~30x cheaper than a per-pixel DD orbit.
// `usePert` gates it. `refZx/refZy` hold the reference orbit (f64 hi-limbs, length refLen);
// `refOffX/refOffY` its offset from the view center; computed once per generation by
// computeRef(). `pertRhoThresh` is the error-bound flag: a pixel whose accumulated relative
// error exceeds it returns CAPPED, so idle-sharpening re-resolves it exactly in DD.
let usePert = false;
let refZx = new Float64Array(1), refZy = new Float64Array(1), refLen = 0;
let refZxl = new Float64Array(1), refZyl = new Float64Array(1);   // reference lo-limbs (DD) for z-periodicity
let refOffX = 0, refOffY = 0;
let pertRhoThresh = 0.1;

// Outcome tallies (per point / sample — includes SSAA & border samples), reset
// alongside iterAcc. Every point ends as one of: escaped (proven outside), in-set
// via the cardioid/bulb shortcut, in-set via periodicity, or capped (hit maxIters
// unresolved). Capped is the waste periodicity reclaims — each capped point burns
// the full budget, so its share of iters is the headroom; watch `per` rise and
// `cap`/iters fall as periodicity works.
let escAcc = 0, inAcc = 0, perAcc = 0, capAcc = 0;

// The heart of it: iterate z -> z^2 + c for a single point, returning the
// continuous ("smooth") escape count (or IN_SET if bounded) and, as a side
// effect, `deDist` = the distance-to-boundary estimate  d = 2*|z|*ln|z| / |z'|.
// We carry the derivative z' = dz/dc alongside z (z'_{n+1} = 2*z*z' + 1), which
// is what lets the boundary be colored smoothly instead of as chromatic static.
// Scalar doubles, zero allocations — the hot path. Kept free of outer refs
// (beyond BAILOUT2 / IN_SET / deDist) so it survives stringification.
function escapeSmooth(cr: number, ci: number, maxIters: number): number {
	// Interior shortcut. The two biggest black regions — the main cardioid and
	// the period-2 bulb — are cheap to test algebraically, so we skip iterating
	// them entirely. They're the most expensive points (they never escape), so
	// short-circuiting them is what keeps the tiles reasonably balanced.
	const b = cr + 1;
	if (b * b + ci * ci < 0.0625) { inAcc++; return IN_SET; }        // period-2 bulb
	const xq = cr - 0.25;
	const q = xq * xq + ci * ci;
	if (q * (q + xq) < 0.25 * ci * ci) { inAcc++; return IN_SET; }   // main cardioid
	// Real-axis membership. M ∩ ℝ = [-2, 1/4] exactly: a real orbit stays real and
	// is trapped in [-2, 2], so every real c in this interval is proven in-set. This
	// is what decides the chaotic real points (which iteration never can — they
	// neither escape nor cycle), so they're classified correctly instead of counted
	// as undetermined. Fires only for exactly-real samples, so it's ~free otherwise.
	if (ci === 0 && cr >= -2 && cr <= 0.25) { inAcc++; return IN_SET; }

	let zx = 0, zy = 0, dzx = 0, dzy = 0, n = 0;
	let refx = 0, refy = 0, checkAt = PERIOD_WARMUP;  // Brent periodicity: reference point + next save
	while (n < maxIters) {
		const x2 = zx * zx, y2 = zy * zy;
		const mag2 = x2 + y2;
		if (mag2 > BAILOUT2) {
			const zmag = Math.sqrt(mag2);
			const dmag = Math.sqrt(dzx * dzx + dzy * dzy);
			deDist = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
			const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
			iterAcc += n; escAcc++;
			return mu < 0 ? 0 : mu;
		}
		// derivative first (needs the current z): z' = 2*z*z' + 1
		const ndzx = 2 * (zx * dzx - zy * dzy) + 1;
		const ndzy = 2 * (zx * dzy + zy * dzx);
		// then z = z^2 + c
		const nzx = x2 - y2 + cr;
		const nzy = 2 * zx * zy + ci;
		zx = nzx; zy = nzy;
		dzx = ndzx; dzy = ndzy;
		n++;
		if (periodOn && n >= PERIOD_WARMUP) {
			// Settled back onto a saved orbit point => attracting cycle => in-set.
			const rx = zx - refx, ry = zy - refy;
			if (rx * rx + ry * ry < periodEps2) { iterAcc += n; perAcc++; return IN_SET; }
			if (n === checkAt) { refx = zx; refy = zy; checkAt *= 2; }  // refresh reference (Brent schedule)
		}
	}
	iterAcc += n; capAcc++;
	deDist = 0.5 * Math.log(dzx * dzx + dzy * dzy + 1e-300);   // provisional structure signal: log|z'| at the cap
	return CAPPED;   // hit the cap unresolved — sharpening may still settle it
}

//---------------------------------------------------------------------------\\
// Double-double arithmetic — a real number carried as an unevaluated sum of two
// f64s (hi + lo, |lo| <= 0.5 ulp(hi)), giving ~106 bits of mantissa. No hardware
// FMA in JS, so products use Dekker's two-product via the 2^27+1 Veltkamp split.
// Each op writes its two-limb result to the _dhi/_dlo scratch globals (no
// allocation); callers copy those into locals before the next op. Self-contained
// for stringification (only _dhi/_dlo, no other outer refs).
//---------------------------------------------------------------------------\\

const DD_SPLIT = 134217729;   // 2^27 + 1, the f64 Veltkamp splitter

// (ahi,alo) + (bhi,blo). Knuth twoSum on the hi limbs, fold in the lo limbs, renormalize.
function ddAdd(ahi: number, alo: number, bhi: number, blo: number): void {
	const s = ahi + bhi;
	const v = s - ahi;
	let e = (ahi - (s - v)) + (bhi - v);   // exact error of ahi+bhi
	e += alo + blo;
	_dhi = s + e;
	_dlo = e - (_dhi - s);                  // quickTwoSum(s, e)
}

// (ahi,alo) * (bhi,blo). Dekker twoProduct on the hi limbs + the cross terms.
function ddMul(ahi: number, alo: number, bhi: number, blo: number): void {
	const p = ahi * bhi;
	const sa = DD_SPLIT * ahi, ah = sa - (sa - ahi), al = ahi - ah;
	const sb = DD_SPLIT * bhi, bh = sb - (sb - bhi), bl = bhi - bh;
	let e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;   // exact error of ahi*bhi
	e += ahi * blo + alo * bhi;
	_dhi = p + e;
	_dlo = e - (_dhi - p);
}

// (ahi,alo)^2 — a cheaper twoProduct with b == a.
function ddSq(ahi: number, alo: number): void {
	const p = ahi * ahi;
	const sa = DD_SPLIT * ahi, ah = sa - (sa - ahi), al = ahi - ah;
	let e = ((ah * ah - p) + 2 * ah * al) + al * al;
	e += 2 * ahi * alo;
	_dhi = p + e;
	_dlo = e - (_dhi - p);
}

// The DD twin of escapeSmooth: same classification, but the orbit z -> z^2 + c runs
// in double-double from a DD coordinate (crhi,crlo)+(cihi,cilo). This is what beats
// BOTH deep-zoom walls at once — the DD coordinate distinguishes pixels the f64 grid
// collapses (spatial wall), and the DD orbit keeps the boundary test above its noise
// far longer (membership wall). The derivative z' (for the distance estimate) is also
// carried in double-double (z'_{n+1} = 2*z*z' + 1), so distance-estimate coloring is
// accurate at depth too, not just escape-time — deDist is computed from the DD z and z'.
// Interior/real-axis shortcuts run on the hi limbs (coarse regions, f64 suffices).
// The periodicity difference z_n - z_ref is formed in DD: that subtraction is a
// catastrophic-cancellation site (two near-equal O(1) values), so doing it in DD is
// exactly what lets cycle detection keep working past the f64 wall.
function escapeSmoothDD(crhi: number, crlo: number, cihi: number, cilo: number, maxIters: number): number {
	const b = crhi + 1;
	if (b * b + cihi * cihi < 0.0625) { inAcc++; return IN_SET; }        // period-2 bulb
	const xq = crhi - 0.25;
	const q = xq * xq + cihi * cihi;
	if (q * (q + xq) < 0.25 * cihi * cihi) { inAcc++; return IN_SET; }   // main cardioid
	if (cihi === 0 && cilo === 0 && crhi >= -2 && crhi <= 0.25) { inAcc++; return IN_SET; }

	let zrhi = 0, zrlo = 0, zihi = 0, zilo = 0;   // z (double-double)
	let dzxhi = 0, dzxlo = 0, dzyhi = 0, dzylo = 0, n = 0;   // z' (double-double)
	let refxhi = 0, refxlo = 0, refyhi = 0, refylo = 0, checkAt = PERIOD_WARMUP;
	while (n < maxIters) {
		ddSq(zrhi, zrlo); const zr2hi = _dhi, zr2lo = _dlo;   // zr^2
		ddSq(zihi, zilo); const zi2hi = _dhi, zi2lo = _dlo;   // zi^2
		const mag2 = zr2hi + zi2hi;                            // hi limb suffices vs the coarse bailout
		if (mag2 > BAILOUT2) {
			const zmag = Math.sqrt(mag2);
			const dmag = Math.sqrt(dzxhi * dzxhi + dzyhi * dzyhi);   // hi limbs — DE is a smooth shading
			deDist = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
			const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
			iterAcc += n; escAcc++;
			return mu < 0 ? 0 : mu;
		}
		// derivative z' = 2*z*z' + 1 (all DD; needs current z, before the z update below)
		ddMul(zrhi, zrlo, dzxhi, dzxlo); const zdx_hi = _dhi, zdx_lo = _dlo;   // zr*dzx
		ddMul(zihi, zilo, dzyhi, dzylo); const zdy_hi = _dhi, zdy_lo = _dlo;   // zi*dzy
		ddAdd(zdx_hi, zdx_lo, -zdy_hi, -zdy_lo);                                // zr*dzx - zi*dzy
		let ndzxhi = 2 * _dhi, ndzxlo = 2 * _dlo;                              // *2 (exact)
		ddAdd(ndzxhi, ndzxlo, 1, 0); ndzxhi = _dhi; ndzxlo = _dlo;             // +1
		ddMul(zrhi, zrlo, dzyhi, dzylo); const zey_hi = _dhi, zey_lo = _dlo;   // zr*dzy
		ddMul(zihi, zilo, dzxhi, dzxlo); const zex_hi = _dhi, zex_lo = _dlo;   // zi*dzx
		ddAdd(zey_hi, zey_lo, zex_hi, zex_lo);                                  // zr*dzy + zi*dzx
		let ndzyhi = 2 * _dhi, ndzylo = 2 * _dlo;                              // *2 (exact)
		// zr' = zr^2 - zi^2 + cr   (all DD)
		ddAdd(zr2hi, zr2lo, -zi2hi, -zi2lo); let nrhi = _dhi, nrlo = _dlo;
		ddAdd(nrhi, nrlo, crhi, crlo); nrhi = _dhi; nrlo = _dlo;
		// zi' = 2*zr*zi + ci       (all DD; the *2 is exact)
		ddMul(zrhi, zrlo, zihi, zilo); let nihi = 2 * _dhi, nilo = 2 * _dlo;
		ddAdd(nihi, nilo, cihi, cilo); nihi = _dhi; nilo = _dlo;
		zrhi = nrhi; zrlo = nrlo; zihi = nihi; zilo = nilo;
		dzxhi = ndzxhi; dzxlo = ndzxlo; dzyhi = ndzyhi; dzylo = ndzylo;
		n++;
		if (periodOn && n >= PERIOD_WARMUP) {
			ddAdd(zrhi, zrlo, -refxhi, -refxlo); const drhi = _dhi;   // (zr - refx) in DD; hi limb holds the tiny diff
			ddAdd(zihi, zilo, -refyhi, -refylo); const dihi = _dhi;
			if (drhi * drhi + dihi * dihi < periodEps2) { iterAcc += n; perAcc++; return IN_SET; }
			if (n === checkAt) { refxhi = zrhi; refxlo = zrlo; refyhi = zihi; refylo = zilo; checkAt *= 2; }
		}
	}
	iterAcc += n; capAcc++;
	deDist = 0.5 * Math.log(dzxhi * dzxhi + dzyhi * dzyhi + 1e-300);   // provisional log|z'| (hi limbs)
	return CAPPED;
}

//---------------------------------------------------------------------------\\
// Perturbation — one shared reference orbit + cheap per-pixel f64 deviations.
//---------------------------------------------------------------------------\\

// Escape length of a DD candidate: the iteration it escapes, or maxIters if bounded. Used
// to pick a non-escaping reference (so the orbit is long enough for every pixel). No
// smooth/derivative/tallies — just the membership test. Stringify-safe (dd ops + BAILOUT2).
function refOrbitLen(crhi: number, crlo: number, cihi: number, cilo: number, maxIters: number): number {
	let zxh = 0, zxl = 0, zyh = 0, zyl = 0;
	for (let n = 0; n < maxIters; n++) {
		if (zxh * zxh + zyh * zyh > BAILOUT2) return n;
		ddSq(zxh, zxl); const x2h = _dhi, x2l = _dlo;
		ddSq(zyh, zyl); const y2h = _dhi, y2l = _dlo;
		ddAdd(x2h, x2l, -y2h, -y2l); let rh = _dhi, rl = _dlo; ddAdd(rh, rl, crhi, crlo); rh = _dhi; rl = _dlo;
		ddMul(zxh, zxl, zyh, zyl); let ih = 2 * _dhi, il = 2 * _dlo; ddAdd(ih, il, cihi, cilo); ih = _dhi; il = _dlo;
		zxh = rh; zxl = rl; zyh = ih; zyl = il;
	}
	return maxIters;
}

// Compute the view's shared reference orbit: a coarse probe finds a non-escaping (deep)
// point, then its DD orbit is stored as f64 hi-limbs in refZx/refZy (length refLen) with the
// point's offset from the view center in refOffX/refOffY. Call once per generation before the
// tiles render. Stringify-safe (refOrbitLen + dd ops + BAILOUT2 + Float64Array).
function computeRef(view: View, maxIters: number): void {
	const PW = 8, PH = 8;
	let bx = 0, by = 0, best = -1;
	for (let j = 0; j < PH && best < maxIters; j++) {
		for (let i = 0; i < PW; i++) {
			const ox = ((i + 0.5) / PW - 0.5) * view.spanX, oy = ((j + 0.5) / PH - 0.5) * view.spanY;
			ddAdd(view.cx, view.cxLo, ox, 0); const crhi = _dhi, crlo = _dlo;
			ddAdd(view.cy, view.cyLo, oy, 0); const cihi = _dhi, cilo = _dlo;
			const len = refOrbitLen(crhi, crlo, cihi, cilo, maxIters);
			if (len > best) { best = len; bx = ox; by = oy; }
			if (len >= maxIters) break;
		}
	}
	refOffX = bx; refOffY = by;
	if (refZx.length < maxIters + 1) { refZx = new Float64Array(maxIters + 1); refZy = new Float64Array(maxIters + 1); refZxl = new Float64Array(maxIters + 1); refZyl = new Float64Array(maxIters + 1); }
	ddAdd(view.cx, view.cxLo, bx, 0); const crhi = _dhi, crlo = _dlo;
	ddAdd(view.cy, view.cyLo, by, 0); const cihi = _dhi, cilo = _dlo;
	let zxh = 0, zxl = 0, zyh = 0, zyl = 0; refLen = maxIters;
	for (let n = 0; n < maxIters; n++) {
		refZx[n] = zxh; refZy[n] = zyh; refZxl[n] = zxl; refZyl[n] = zyl;
		if (zxh * zxh + zyh * zyh > BAILOUT2) { refLen = n; break; }
		ddSq(zxh, zxl); const x2h = _dhi, x2l = _dlo;
		ddSq(zyh, zyl); const y2h = _dhi, y2l = _dlo;
		ddAdd(x2h, x2l, -y2h, -y2l); let rh = _dhi, rl = _dlo; ddAdd(rh, rl, crhi, crlo); rh = _dhi; rl = _dlo;
		ddMul(zxh, zxl, zyh, zyl); let ih = 2 * _dhi, il = 2 * _dlo; ddAdd(ih, il, cihi, cilo); ih = _dhi; il = _dlo;
		zxh = rh; zxl = rl; zyh = ih; zyl = il;
	}
	refZx[refLen] = zxh; refZy[refLen] = zyh; refZxl[refLen] = zxl; refZyl[refLen] = zyl;
}

// Perturbation escape: iterate the pixel deviation δ (f64) off the reference, carrying a
// derivative (for deDist) and a running error bound. Returns the smooth escape count (same
// convention as escapeSmoothDD), IN_SET via the interior shortcuts, or CAPPED — the latter
// for non-escaping points AND glitch-flagged ones (accumulated relative error e/|δ| >
// pertRhoThresh), so idle-sharpening resolves those exactly in DD. cr/ci = full pixel
// coordinate (shortcuts only); dcx/dcy = δc = pixel − reference. Stringify-safe (Math/Number).
function escapeSmoothPert(cr: number, ci: number, dcx: number, dcy: number, maxIters: number): number {
	const b = cr + 1;
	if (b * b + ci * ci < 0.0625) { inAcc++; return IN_SET; }
	const xq = cr - 0.25, q = xq * xq + ci * ci;
	if (q * (q + xq) < 0.25 * ci * ci) { inAcc++; return IN_SET; }
	if (ci === 0 && cr >= -2 && cr <= 0.25) { inAcc++; return IN_SET; }

	const EPS = Number.EPSILON, adc = Math.sqrt(dcx * dcx + dcy * dcy);
	let dx = 0, dy = 0, e = 0, dzx = 0, dzy = 0, n = 0;
	let szxh = 0, szxl = 0, szyh = 0, szyl = 0, pSaved = false, checkAt = PERIOD_WARMUP;   // z-periodicity (Brent, DD ref)
	const lim = maxIters < refLen ? maxIters : refLen;
	while (n < lim) {
		const Zx = refZx[n], Zy = refZy[n];
		const zx = Zx + dx, zy = Zy + dy;
		const z2 = zx * zx + zy * zy;
		const dm = Math.sqrt(dx * dx + dy * dy);
		if (z2 > BAILOUT2) {
			if (dm > 0 && e / dm > pertRhoThresh) { iterAcc += n; capAcc++; deDist = 0.5 * Math.log(dzx * dzx + dzy * dzy + 1e-300); return CAPPED; }   // glitch → DD in sharpening
			const zmag = Math.sqrt(z2), dmag = Math.sqrt(dzx * dzx + dzy * dzy);
			deDist = dmag > 1e-300 ? 2 * zmag * Math.log(zmag) / dmag : 1e30;
			const mu = n + 1 - Math.log(0.5 * Math.log(z2)) / Math.LN2;
			iterAcc += n; escAcc++;
			return mu < 0 ? 0 : mu;
		}
		const zm = Math.sqrt(Zx * Zx + Zy * Zy);
		e = 2 * Math.sqrt(z2) * e + EPS * (2 * zm * dm + dm * dm + adc);            // error: amplify + inject
		const ndzx = 2 * (zx * dzx - zy * dzy) + 1, ndzy = 2 * (zx * dzy + zy * dzx);   // z' = 2·z·z' + 1
		dzx = ndzx; dzy = ndzy;
		const ndx = 2 * (Zx * dx - Zy * dy) + (dx * dx - dy * dy) + dcx;            // δ' = 2·Z·δ + δ² + δc
		const ndy = 2 * (Zx * dy + Zy * dx) + 2 * dx * dy + dcy;
		dx = ndx; dy = ndy;
		n++;
		// Interior via REAL z-periodicity (Brent): compare z_n to a saved point. The O(1) reference
		// difference (Z_n − Z_saved) is formed in DD so the test stays precise past the f64 wall; the
		// δ diff is f64. Resolves in-set minibrot points in the cheap pass instead of via DD sharpening.
		if (periodOn && n >= PERIOD_WARMUP && n <= refLen) {
			const nxh = refZx[n], nyh = refZy[n];   // hi limbs only in the hot path; lo limbs deferred
			if (pSaved) {
				const gx = (nxh - szxh) + dx, gy = (nyh - szyh) + dy;   // f64 estimate of z_n − z_saved
				if (gx * gx + gy * gy < PERT_GATE2) {   // cheap gate: skip DD unless a real cycle candidate
					const nxl = refZxl[n], nyl = refZyl[n];
					ddAdd(nxh, nxl, -szxh, -szxl); ddAdd(_dhi, _dlo, dx, 0); const drx = _dhi;   // (z_n − z_saved).x, DD
					ddAdd(nyh, nyl, -szyh, -szyl); ddAdd(_dhi, _dlo, dy, 0); const dry = _dhi;
					if (drx * drx + dry * dry < periodEps2) { iterAcc += n; perAcc++; return IN_SET; }
				}
			}
			if (n === checkAt) {
				const nxl = refZxl[n], nyl = refZyl[n];
				ddAdd(nxh, nxl, dx, 0); szxh = _dhi; szxl = _dlo;                             // save z_n as DD
				ddAdd(nyh, nyl, dy, 0); szyh = _dhi; szyl = _dlo;
				pSaved = true; checkAt *= 2;
			}
		}
	}
	iterAcc += n; capAcc++;
	deDist = 0.5 * Math.log(dzx * dzx + dzy * dzy + 1e-300);   // provisional log|z'| at the cap
	return CAPPED;
}

//---------------------------------------------------------------------------\\
// Custom-formula output scratch (re, im). A complex number is a real f64 pair; stepFormula (below)
// writes its result here instead of returning a pair (JS can't cheaply return two f64) — the same
// allocation-free trick as the DD _dhi/_dlo scratch. escapeCustom / probeFormulaAtZero copy _cre/_cim
// into locals right after the stepFormula call. (The compiled formula body itself is flat straight-line
// f64 — see formula.ts — so it needs no complex-op helpers; the z²+c kernels keep their inlined math.)
//---------------------------------------------------------------------------\\
let _cre = 0, _cim = 0;

// FORMULA_CUSTOM step: one iteration z ← f(z, c) of a user formula compiled by formula.ts. Writes
// the result to the (_cre, _cim) scratch (same convention as the complex ops). The generated body is
// flat straight-line f64 — NOT this default. The WORKER gets its stepFormula spliced in by
// buildWorkerSource; the MAIN thread (probe + sync-render paths) gets one assigned via `new Function`
// in renderer.setCustomFormula. This z²+c default stands in until a formula is compiled and keeps
// escapeCustom / probeFormulaAtZero well-typed. `let` so the main thread can reassign it.
let stepFormula: (zx: number, zy: number, cx: number, cy: number) => void =
	function (zx, zy, cx, cy) { _cre = zx * zx - zy * zy + cx; _cim = 2 * zx * zy + cy; };

// M-mode seed probe: is the formula's FIRST step from z=0 finite? The renderer calls this on a few sample
// c to choose the Mandelbrot seed — z₀=0 when finite (the canonical set), else z₀=c (a heuristic parameter
// map). Returns 1 if f_c(0) is finite, 0 if not. One step only; uses the same stepFormula seam as
// escapeCustom, so it stays in sync automatically. Runs once per render on the main thread — cost irrelevant.
function probeFormulaAtZero(cx: number, cy: number): number {
	let zx = 0, zy = 0;
	if (formulaId === FORMULA_CUSTOM) {   // user/preset formula: one step from z=0 via the stepFormula seam
		stepFormula(zx, zy, cx, cy); zx = _cre; zy = _cim;
	} else {                              // FORMULA_MANDEL: z²+c at z=0 → c
		zx = cx; zy = cy;
	}
	return (isFinite(zx) && isFinite(zy)) ? 1 : 0;
}

// KERNEL 2 — a GENERALIZED version of Kernel 1 (escapeSmooth): the same escape loop, written
// set-type-agnostically, plus a formula switch and orbit-trap filter hooks. z₀ and c are passed in
// EXPLICITLY, so escapeAtPt wires them per set-type — Mandelbrot: c = pixel, z₀ = 0; Julia: c = seed,
// z₀ = pixel. ALWAYS f64 — no DD/perturbation (those don't generalize to arbitrary/transcendental maps,
// and escapeAtPt dispatches here BEFORE its useDD/usePert checks, so it can't reach them). NO cardioid/
// bulb shortcuts (z²+c-specific), but DOES do generic z-periodicity (cycle detection generalizes — see the
// loop). Escape radius BAILOUT_CUSTOM2 (|z|²≥4). No derivative (no distance mode).
//
// formulaId picks the step (constant per frame → the branch is predicted): z²+c, or a compiled user/preset
// formula run through the stepFormula seam.
//
// Two coloring regimes, selected by filterId:
//   FILTER_NONE — escape-time. Returns the smooth escape count (same convention as escapeSmooth) or
//     CAPPED if still bounded. FINITE GUARD: a transcendental step (e.g. sin of a large imaginary part)
//     can overflow to Inf, and a following Inf·0 yields NaN; a NaN magnitude fails the escape test and
//     would iterate to the cap (wrongly painting in-set), so a non-finite z is treated as escaped at n.
//     The z²+c formula matches Kernel 1's exterior math (the parity oracle); the smooth term assumes degree-2 escape.
//   a filter — an accumulating orbit trap (filter-interface.md), hooks inlined not virtual: init = the
//     trap geometry (frame-constant |seed| in Julia; PER-PIXEL |c| in Mandelbrot, computed below);
//     onIteration = the switch(filterId) on the POST-update z; complete = the switch at loop exit. Output
//     is the RAW two-channel accumulator (return = ch1, deDist = ch2) — dFactor/normalize/RGB happen in
//     the color path. A miss (never trapped) returns 0 in both channels → background. ORDERING: escape
//     test on PRE-update z, filter on POST-update (a point can be trapped one step before escape culls it).
// escapeSmooth (Kernel 1) is left byte-for-byte untouched. Self-contained for stringification.
function escapeCustom(z0x: number, z0y: number, cx: number, cy: number, maxIters: number): number {
	// Trap geometry: frame-constant globals in Julia; per-pixel limit = |c| in Mandelbrot (filter-interface.md).
	let tLimit = trapLimit, tLo = trapLo, tHi = trapHi;
	if (filterId !== FILTER_NONE && !juliaMode) { tLimit = Math.sqrt(cx * cx + cy * cy); tLo = tLimit - trapDStrands; tHi = tLimit + trapDStrands; }
	let zx = z0x, zy = z0y, n = 0, escaped = false;
	let xtot = 0, ytot = 0;    // filter accumulators (even/odd parity) — unused when FILTER_NONE
	let prx = z0x, pry = z0y, pchk = PERIOD_WARMUP;   // Brent cycle detection: saved point + next-save schedule
	while (n < maxIters) {
		const mag2 = zx * zx + zy * zy;                     // escape test on PRE-update z
		if (!(mag2 < BAILOUT_CUSTOM2)) { escaped = true; break; }   // escaped, OR non-finite (NaN/Inf fail "< R")
		// formula step (formulaId): z ← f(z, c)
		if (formulaId === FORMULA_CUSTOM) {                 // user/preset formula (formula.ts) via the stepFormula seam
			stepFormula(zx, zy, cx, cy); zx = _cre; zy = _cim;
		} else {                                            // FORMULA_MANDEL: z² + c (matches Kernel 1)
			const nzx = zx * zx - zy * zy + cx, nzy = 2 * zx * zy + cy;
			zx = nzx; zy = nzy;
		}
		n++;
		// filter onIteration — observe the POST-update z
		if (filterId === FILTER_XRAY_RINGS) {
			const r = Math.sqrt(zx * zx + zy * zy);
			if (r > tLo && r < tHi) {
				// Proximity weight; the +ε keeps it FINITE at an exact hit r==limit. That case is systematic in
				// Mandelbrot mode — z₁ = c lands |z₁| = |c| = limit exactly every pixel — so without ε it'd be Inf→NaN.
				const temp = Math.log(2 + trapDf / (Math.abs(tLimit - r) + 1e-9));
				if ((n & 1) === 0) xtot += temp; else ytot += temp;         // even → x channel, odd → y channel
			}
		}
		// Interior via REAL z-periodicity (Brent) — generalizes to ANY formula: an orbit settling back onto a
		// saved point is on an attracting cycle → bounded → in-set. Bails out of interior pixels instead of
		// grinding them to the cap. Escape-time ONLY: a filter must observe the full orbit, so never bail then.
		if (filterId === FILTER_NONE && periodOn && n >= PERIOD_WARMUP) {
			const rx = zx - prx, ry = zy - pry;
			if (rx * rx + ry * ry < periodEps2) { iterAcc += n; perAcc++; return IN_SET; }
			if (n === pchk) { prx = zx; pry = zy; pchk *= 2; }   // refresh the reference (Brent doubling schedule)
		}
	}
	iterAcc += n;
	// filter complete
	if (filterId !== FILTER_NONE) {
		if (escaped) escAcc++; else capAcc++;
		if (xtot === 0 && ytot === 0) { deDist = 0; return 0; }   // never trapped → miss (both channels 0 → background)
		deDist = ytot;                                            // channel 2
		return xtot;                                              // channel 1 (raw; color path applies dFactor + normalize)
	}
	// FILTER_NONE — escape-time
	if (escaped) {
		escAcc++; deDist = 0;
		const mag2 = zx * zx + zy * zy;
		if (!isFinite(mag2)) return n;                       // overflow → escaped at n (no smooth term)
		const mu = n + 1 - Math.log(0.5 * Math.log(mag2)) / Math.LN2;
		return mu < 0 ? 0 : mu;
	}
	capAcc++; deDist = 0;
	return CAPPED;   // still bounded at the cap
}

// Band transfer: compress the escape count before it maps to color. Linear is the raw
// count; sqrt and log grow slower as mu grows, so the per-pixel band rate stays roughly
// constant across zoom WITHOUT referencing the zoom level. That makes the coloring both
// consistent-banded and zoom-STABLE — a point keeps its color as you dive in (the
// prerequisite for zoom animation), which the zoom-scaled density stretch can't give.
// 0 = linear, 1 = sqrt, 2 = log2. Self-contained for stringification (Math only).
function bandTransform(mu: number, bandMap: number): number {
	if (bandMap === 1) return Math.sqrt(mu);
	if (bandMap === 2) return Math.log2(1 + mu);
	return mu;
}

// Filter READOUT: fold a filter's two raw accumulators (xtot=even, ytot=odd; carried in the mu/de
// fields) into a packed RGBA. Separates BRIGHTNESS (the trap intensity, exposure-mapped so dFactor is
// a real knob — it would cancel under a plain divide-by-max) from HUE (the even/odd parity that makes
// R=d+xtot vs G=d+ytot resolve into red vs cyan). filterRef is the frame's intensity scale (workers
// pass 0 → per-pixel self-scale, a rough provisional; the main thread recolors with the real ref). A
// (0,0) accumulator means the orbit never touched the trap → the background color. Self-contained
// (Math + filter globals). Packing matches renderRegion: A<<24 | B<<16 | G<<8 | R (little-endian RGBA).
function filterColor(xtot: number, ytot: number): number {
	if (xtot === 0 && ytot === 0) return filterBg;          // miss → background
	const d = Math.sqrt(xtot * xtot + ytot * ytot);         // trap intensity
	const ref = filterRef > 0 ? filterRef : d;              // no frame ref (worker) → self-scale
	let t = d / ref; if (t > 1) t = 1;                      // dFactor-independent normalized intensity
	const b = 1 - Math.exp(-filterDFactor * t);             // exposure curve — dFactor is the knob
	const cmax = d + (xtot > ytot ? xtot : ytot);           // largest channel (B=d is smallest; R,G add a pile)
	let R = b * (d + xtot) / cmax * 255;
	let G = b * (d + ytot) / cmax * 255;
	let B = b * d / cmax * 255;
	R = R > 255 ? 255 : R | 0; G = G > 255 ? 255 : G | 0; B = B > 255 ? 255 : B | 0;
	return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
}

// The ONE coloring transfer function: a (mu, deDist) sample -> packed RGBA. Every path
// routes through this — renderRegion (worker) and colorizeField / pixelColor (main
// thread) — so escape-time bands, distance coloring, and the auto-leveled ramp can never
// drift out of sync (they used to be three hand-synced copies). Escape-time first passes
// mu through bandTransform. Non-cyclic uses a level window [lvlLo, lvlHi] (transformed
// the same way): the main thread passes the view's auto-leveled mu range; the worker,
// which can't see it, passes (0, 1/densityMul) — algebraically a flat clamp for linear.
// Self-contained for stringification (DIST_SCALE / bandTransform / filterColor).
function colorSample(
	mu: number, de: number, lut: Uint32Array, inSet: number,
	mode: number, cyclic: boolean, densityMul: number,
	pixelSize: number, bandMap: number, lvlLo: number, lvlHi: number,
): number {
	if (filterId !== FILTER_NONE) return filterColor(mu, de);   // filter mode: (mu,de) carry (xtot,ytot)
	if (mu === -Infinity) {                                 // CAPPED (unresolved this pass)
		if (!provOn || !provLut) return inSet;              //   provisional coloring off -> in-set color (old behavior)
		let tp = (de - provLo) / (provHi > provLo ? provHi - provLo : 1);   // de carries log|z'| for CAPPED px
		tp = tp < 0 ? 0 : tp > 1 ? 1 : tp;
		return provLut[(tp * (provLut.length - 1)) | 0];    // paper->ink structure ramp
	}
	if (!isFinite(mu)) return inSet;                        // IN_SET (+inf) or NaN -> in-set color
	const lastIdx = lut.length - 1;
	if (mode === 1) {                                        // distance estimate
		let td = Math.log(1 + de / pixelSize) * DIST_SCALE;
		td -= (td | 0);
		return lut[(td * lastIdx) | 0];
	}
	const g = bandTransform(mu, bandMap);                   // compressed escape count
	if (cyclic) {                                            // escape-time, wrapped bands
		let t = g * densityMul;
		t -= (t | 0);
		return lut[(t * lastIdx) | 0];
	}
	const glo = bandTransform(lvlLo, bandMap);              // level window, same transform
	const ghi = bandTransform(lvlHi, bandMap);
	let t = (g - glo) / (ghi > glo ? ghi - glo : 1);        // clamped level window
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return lut[(t * lastIdx) | 0];
}

// Escape value at a canvas-space sample (px, py already pixel/subpixel-centered), via the
// active precision path: perturbation (δ off the shared reference), double-double (DD coordinate
// built with twoSum), or plain f64 (bit-identical to the pre-DD engine). Sets deDist as a side
// effect. Shared by renderRegion, sharpenPoints, and ssaaPoints so the three can't drift.
// Self-contained for stringification (the escape kernels + dd ops + ref/scratch globals).
function escapeAtPt(px: number, py: number, view: View, maxIters: number, invW: number, invH: number): number {
	const offX = (px * invW - 0.5) * view.spanX;
	const offY = (py * invH - 0.5) * view.spanY;
	// Kernel 2 (generalized): wire z₀/c from the set type. Mandelbrot: c = the pixel, z₀ = 0.
	// Julia: c = the seed, z₀ = the pixel. One well-predicted branch per pixel (fractalMode +
	// juliaMode are constant for the frame); the z²+c fast path below is entirely unchanged.
	if (fractalMode) {
		const pxc = view.cx + offX, pyc = view.cy + offY;
		if (juliaMode) return escapeCustom(pxc, pyc, juliaCx, juliaCy, maxIters);   // z₀ = pixel, c = seed
		// Mandelbrot: z₀ = 0 (canonical) normally; z₀ = c (mSeedAtC) when the formula is undefined at 0.
		return mSeedAtC ? escapeCustom(pxc, pyc, pxc, pyc, maxIters) : escapeCustom(0, 0, pxc, pyc, maxIters);
	}
	if (usePert) {
		return escapeSmoothPert(view.cx + offX, view.cy + offY, offX - refOffX, offY - refOffY, maxIters);
	}
	if (useDD) {
		ddAdd(view.cx, view.cxLo, offX, 0); const crhi = _dhi, crlo = _dlo;
		ddAdd(view.cy, view.cyLo, offY, 0); const cihi = _dhi, cilo = _dlo;
		return escapeSmoothDD(crhi, crlo, cihi, cilo, maxIters);
	}
	return escapeSmooth(view.cx + offX, view.cy + offY, maxIters);
}

// Fill a tile into `out` (a Uint32 buffer with row stride `outStride`). The
// tile's top-left sits at (ox, oy) in the full canvas, which — together with
// canvasW/canvasH — is what maps pixels into the complex plane; the output
// itself is written tile-local from index 0. The single-threaded path passes
// the whole canvas as one "tile"; workers pass a small one. mode 0 = escape-time
// bands, mode 1 = distance coloring. Anti-aliasing is ADAPTIVE: one sample per
// pixel, and only pixels near an edge (a neighbor's color differs) get
// supersampled SS x SS. A 1px sampled border makes that decision identical
// whether rendered as a tile or the whole canvas. Also stashes the raw (mu,
// deDist) field into muOut/deOut so the main thread can recolor without
// re-iterating. Self-contained for stringification (escapeSmooth / IN_SET /
// deDist / DIST_SCALE / SS / EDGE_TH).
function renderRegion(
	out: Uint32Array, muOut: Float32Array, deOut: Float32Array, outStride: number,
	ox: number, oy: number, tw: number, th: number,
	canvasW: number, canvasH: number,
	view: View, maxIters: number,
	lut: Uint32Array, inSet: number, densityMul: number, cyclic: boolean, mode: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH;
	const pixelSize = view.spanX * invW;                   // for distance mode
	const invSS = 1 / SS, nSub = SS * SS;

	// Color a computed (mu, deDist) sample via the shared colorSample. The worker can't
	// see the view's auto-level range, so it passes (0, 1/densityMul) — a flat clamp.
	function colorOf(mu: number, de: number): number {
		return colorSample(mu, de, lut, inSet, mode, cyclic, densityMul, pixelSize, bandMap, 0, 1 / densityMul);
	}
	function escapeAt(px: number, py: number): number {
		return escapeAtPt(px, py, view, maxIters, invW, invH);
	}
	function colorAt(fx: number, fy: number): number {
		const mu = escapeAt(fx, fy);
		return colorOf(mu, deDist);
	}
	function colorDiff(a: number, b: number): number {
		return Math.abs((a & 255) - (b & 255)) +
			Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) +
			Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
	}

	// 1-sample fast path (initial frame): no border, no supersampling. Just one sample per
	// pixel, colored and written, with the (mu, deDist) field stashed for recolor/sharpen/SSAA.
	// The background ssaaPoints pass anti-aliases the edges afterward, off the critical path.
	if (!ssaaOn) {
		for (let ly = 0; ly < th; ly++) {
			let off = ly * outStride;
			for (let lx = 0; lx < tw; lx++, off++) {
				const mu = escapeAt(ox + lx + 0.5, oy + ly + 0.5);
				const de = deDist;
				out[off] = colorOf(mu, de);
				const p = ly * tw + lx; muOut[p] = mu; deOut[p] = de;
			}
		}
		return;
	}

	// Pass 1: one sample per pixel over the tile PLUS a 1px border (border only
	// for edge detection). Stash the tile's raw (mu, deDist) field for recoloring.
	const sw = tw + 2;
	const s1 = new Uint32Array(sw * (th + 2));
	for (let j = -1; j <= th; j++) {
		const row = (j + 1) * sw;
		const inY = j >= 0 && j < th;
		for (let i = -1; i <= tw; i++) {
			// Sample at the pixel CENTER (+0.5), not its corner. A single sample is
			// the pixel's representative, and centering keeps the sample grid
			// symmetric within the array, so a mirror-symmetric set (the Mandelbrot
			// set about the real axis) renders as a true mirror — corner-sampling is
			// offset half a pixel and, on an even-height axis-centered view, lands
			// exactly on the real axis (a measure-zero line of undecidable-by-
			// iteration points). SSAA below uses the same centered convention.
			const mu = escapeAt(ox + i + 0.5, oy + j + 0.5);
			const de = deDist;
			s1[row + i + 1] = colorOf(mu, de);
			if (inY && i >= 0 && i < tw) { const p = j * tw + i; muOut[p] = mu; deOut[p] = de; }
		}
	}

	// Pass 2: keep flat pixels at one sample; supersample only edges.
	const doSS = SS > 1;
	for (let ly = 0; ly < th; ly++) {
		let off = ly * outStride;
		const srow = (ly + 1) * sw;
		for (let lx = 0; lx < tw; lx++, off++) {
			const si = srow + lx + 1;
			const c = s1[si];
			if (doSS && (
				colorDiff(c, s1[si + 1]) > EDGE_TH ||
				colorDiff(c, s1[si - 1]) > EDGE_TH ||
				colorDiff(c, s1[si + sw]) > EDGE_TH ||
				colorDiff(c, s1[si - sw]) > EDGE_TH)) {
				let ar = 0, ag = 0, ab = 0;
				for (let sy = 0; sy < SS; sy++) {
					const fy = oy + ly + (sy + 0.5) * invSS;   // centered subsamples (match pass-1 +0.5)
					for (let sx = 0; sx < SS; sx++) {
						const cc = colorAt(ox + lx + (sx + 0.5) * invSS, fy);
						ar += cc & 255; ag += (cc >> 8) & 255; ab += (cc >> 16) & 255;
					}
				}
				out[off] = ((255 << 24) | (((ab / nSub) | 0) << 16) | (((ag / nSub) | 0) << 8) | ((ar / nSub) | 0)) >>> 0;
			} else {
				out[off] = c;
			}
		}
	}
}

// Sharpening primitive: re-iterate ONLY the still-CAPPED points of a tile at a
// higher cap, instead of re-running the whole tile (which would waste ~60% of the
// work re-resolving points that already settled at the lower cap). `idx` holds
// the capped pixels' tile-local indices; results are written packed (muOut[k],
// deOut[k]) aligned to idx. One sample each (no SSAA/border) — a capped pixel was
// painted in-set, so any resolution is an improvement, and the next full render
// restores anti-aliasing. Self-contained for stringification (escapeSmooth /
// deDist), and centered sampling matches renderRegion.
function sharpenPoints(
	muOut: Float32Array, deOut: Float32Array, idx: Int32Array,
	ox: number, oy: number, tw: number, canvasW: number, canvasH: number,
	view: View, maxIters: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH;
	for (let k = 0; k < idx.length; k++) {
		const p = idx[k], lx = p % tw, ly = (p / tw) | 0;
		muOut[k] = escapeAtPt(ox + lx + 0.5, oy + ly + 0.5, view, maxIters, invW, invH);
		deOut[k] = deDist;
	}
}

// Background anti-aliasing: for each listed EDGE pixel (an edge detected in the 1-sample first
// frame), take SS×SS subsamples via escapeAtPt, color each through colorSample, and write the
// AVERAGED packed color (aligned to idx). Runs on the idle pool after the frame lands, so SSAA
// never blocks the first frame — this is the deferred half of the old inline renderRegion SSAA.
// Uses the main thread's auto-level window (lvlLo/lvlHi) so the anti-aliased pixels match the
// resting frame's coloring. Centered subsamples match renderRegion. Self-contained for
// stringification (escapeAtPt / colorSample / SS / deDist).
function ssaaPoints(
	muOut: Float32Array, deOut: Float32Array, idx: Int32Array,
	ox: number, oy: number, tw: number, canvasW: number, canvasH: number,
	view: View, maxIters: number,
): void {
	const invW = 1 / canvasW, invH = 1 / canvasH, invSS = 1 / SS, nSub = SS * SS;
	// Emit the raw SS² subsample (mu, deDist) per edge pixel (packed k*nSub + subsample). The main
	// thread averages them through colorSample and caches them, so a later recolor re-averages the
	// anti-aliasing without re-iterating (colors are cheap; escape values are not).
	for (let k = 0; k < idx.length; k++) {
		const p = idx[k], lx = p % tw, ly = (p / tw) | 0;
		let o = k * nSub;
		for (let sy = 0; sy < SS; sy++) {
			const fy = oy + ly + (sy + 0.5) * invSS;
			for (let sx = 0; sx < SS; sx++) {
				muOut[o] = escapeAtPt(ox + lx + (sx + 0.5) * invSS, fy, view, maxIters, invW, invH);
				deOut[o] = deDist;
				o++;
			}
		}
	}
}