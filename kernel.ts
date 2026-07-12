// kernel.ts — the pure compute core: escape-time + double-double orbit, distance
// estimate, band transform, per-region render, and sharpening. Stringified into
// the worker (see buildWorkerSource in index.ts) AND run synchronously on the main
// thread, so it references only bare-name module globals — which is why the build
// stays module:none (shared global scope). Concatenated first by tsc --outFile.

//---------------------------------------------------------------------------\\
// Core compute
//---------------------------------------------------------------------------\\

interface View {
	cx: number;    // center, real axis
	cy: number;    // center, imaginary axis
	spanX: number; // width of the view in the complex plane
	spanY: number; // height of the view in the complex plane
}

const DEFAULT_VIEW: View = { cx: -1, cy: 0, spanX: 4, spanY: 2 };

// Iteration budget scales with zoom: deeper views need more iterations or the
// boundary filaments blob into solid "fuzz" (points that would escape just
// later get mislabeled in-set). Grows per octave of zoom, capped so very deep
// views stay tolerable — the worker pool absorbs the extra cost.
const ITER_BASE = 1000;   // full-view budget
const ITER_SLOPE = 600;   // extra iterations per octave (2x) of zoom
const ITER_CAP = 20000;   // ceiling for the INITIAL pass (fast time-to-first-frame)

// Progressive sharpening. The initial pass caps at ITER_CAP so the first frame
// lands fast; points that hit the cap unresolved (CAPPED) are then re-iterated on
// the idle worker pool at a cap that escalates ×SHARPEN_MULT per stage. Rather
// than stop at a fixed cap, each stage decides whether the next is worth running:
// keep going while it stays PRODUCTIVE (resolves a meaningful share of what
// remained) OR CHEAP (a stage this fast is a free tickle — carry on even if it
// resolved little); stop only when a stage is both unproductive and not cheap, or
// when the cap reaches the precision ceiling. That ceiling is real, not arbitrary:
// past it a point's float64 orbit error (~ε·|z'|) has grown to O(1), so more
// iterations track a neighboring c, not this one — the point can't be decided
// without more precision, only "abandoned". Re-runs whole capped tiles from
// scratch (the wasted low-cap iters are a few %, not worth a resume-state buffer).
const SHARPEN_MULT = 10;              // cap multiplier per sharpening stage
const SHARPEN_CEILING = 100_000_000;  // past this, points are precision-limited, not iteration-limited
const SHARPEN_MIN_YIELD = 0.01;       // a stage resolving < this share of what remained is "unproductive"
const SHARPEN_CHEAP_MS = 150;         // ...but a stage faster than this is a free tickle — keep going anyway

// Color-frequency control. Deep in, the smooth count changes so fast per pixel
// that a fixed color cycle wraps many times between neighbors — chromatic
// static. Stretch the cycle with zoom (identity at the full view) to hold the
// color gradient's per-pixel rate roughly constant. The exponent ~matches how
// fast the per-pixel delta grows with zoom.
const COLOR_STRETCH_EXP = 0.3;

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

// Double-double (DD) precision gate. Past a certain depth f64 runs out of mantissa
// — the pixel step drops below the ULP of the coordinate (adjacent pixels collide)
// AND the orbit's rounding error, Lyapunov-amplified, swamps the boundary test. The
// orbit is then run in ~106-bit double-double arithmetic (a pair of f64s). DD costs
// ~15-20x/op (no hardware FMA in JS -> Dekker two-product), so it's gated to only
// the views that need it: engage when the pixel step falls within this factor of the
// coordinate ULP — a few octaves before the hard wall, so the crossover is seamless.
// Tunable; mandelDD() forces on/off/auto for A/B.
const DD_SWITCH_RATIO = 8;

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
// DD op result scratch (hi, lo). The DD primitives write their two-limb result here
// instead of allocating a pair — keeps the hot path allocation-free, same trick as
// deDist. Copy _dhi/_dlo into locals immediately after each call (they're clobbered
// by the next DD op).
let _dhi = 0, _dlo = 0;

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
	return CAPPED;
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

// The ONE coloring transfer function: a (mu, deDist) sample -> packed RGBA. Every path
// routes through this — renderRegion (worker) and colorizeField / pixelColor (main
// thread) — so escape-time bands, distance coloring, and the auto-leveled ramp can never
// drift out of sync (they used to be three hand-synced copies). Escape-time first passes
// mu through bandTransform. Non-cyclic uses a level window [lvlLo, lvlHi] (transformed
// the same way): the main thread passes the view's auto-leveled mu range; the worker,
// which can't see it, passes (0, 1/densityMul) — algebraically a flat clamp for linear.
// Self-contained for stringification (DIST_SCALE / bandTransform).
function colorSample(
	mu: number, de: number, lut: Uint32Array, inSet: number,
	mode: number, cyclic: boolean, densityMul: number,
	pixelSize: number, bandMap: number, lvlLo: number, lvlHi: number,
): number {
	if (!isFinite(mu)) return inSet;                        // IN_SET or CAPPED -> in-set color
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
	// Escape value at a canvas-space sample (px,py already pixel/subpixel-centered).
	// Below the f64 wall (useDD) the coordinate is built in double-double —
	// c = cx (+) offset via twoSum — and iterated in DD; otherwise the plain f64
	// path, which stays bit-identical to the pre-DD engine. Sets deDist either way.
	function escapeAt(px: number, py: number): number {
		const offX = (px * invW - 0.5) * view.spanX;
		const offY = (py * invH - 0.5) * view.spanY;
		if (useDD) {
			ddAdd(view.cx, 0, offX, 0); const crhi = _dhi, crlo = _dlo;
			ddAdd(view.cy, 0, offY, 0); const cihi = _dhi, cilo = _dlo;
			return escapeSmoothDD(crhi, crlo, cihi, cilo, maxIters);
		}
		return escapeSmooth(view.cx + offX, view.cy + offY, maxIters);
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
		const offX = ((ox + lx + 0.5) * invW - 0.5) * view.spanX;
		const offY = ((oy + ly + 0.5) * invH - 0.5) * view.spanY;
		if (useDD) {
			ddAdd(view.cx, 0, offX, 0); const crhi = _dhi, crlo = _dlo;
			ddAdd(view.cy, 0, offY, 0); const cihi = _dhi, cilo = _dlo;
			muOut[k] = escapeSmoothDD(crhi, crlo, cihi, cilo, maxIters);
		} else {
			muOut[k] = escapeSmooth(view.cx + offX, view.cy + offY, maxIters);
		}
		deOut[k] = deDist;
	}
}