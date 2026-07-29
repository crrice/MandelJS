// math/dd.ts — double-double arithmetic: a real number carried as an unevaluated sum of
// two f64s (hi + lo, |lo| <= 0.5 ulp(hi)), giving ~106 bits of mantissa. No hardware FMA
// in JS, so products use Dekker's two-product via the 2^27+1 Veltkamp split. Each op
// writes its two-limb result to the _dhi/_dlo scratch exports (no allocation); callers
// copy those into locals before the next op. Writes to the scratch happen ONLY in this
// module — importers read the live bindings right after each call.

export const DD_SPLIT = 134217729;   // 2^27 + 1, the f64 Veltkamp splitter

// DD op result scratch (hi, lo). The DD primitives write their two-limb result here
// instead of allocating a pair — keeps the hot path allocation-free. Copy _dhi/_dlo into
// locals immediately after each call (they're clobbered by the next DD op).
export let _dhi = 0, _dlo = 0;

// (ahi,alo) + (bhi,blo). Knuth twoSum on the hi limbs, fold in the lo limbs, renormalize.
export function ddAdd(ahi: number, alo: number, bhi: number, blo: number): void {
	const s = ahi + bhi;
	const v = s - ahi;
	let e = (ahi - (s - v)) + (bhi - v);   // exact error of ahi+bhi
	e += alo + blo;
	_dhi = s + e;
	_dlo = e - (_dhi - s);                  // quickTwoSum(s, e)
}

// (ahi,alo) * (bhi,blo). Dekker twoProduct on the hi limbs + the cross terms.
export function ddMul(ahi: number, alo: number, bhi: number, blo: number): void {
	const p = ahi * bhi;
	const sa = DD_SPLIT * ahi, ah = sa - (sa - ahi), al = ahi - ah;
	const sb = DD_SPLIT * bhi, bh = sb - (sb - bhi), bl = bhi - bh;
	let e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;   // exact error of ahi*bhi
	e += ahi * blo + alo * bhi;
	_dhi = p + e;
	_dlo = e - (_dhi - p);
}

// (ahi,alo)^2 — a cheaper twoProduct with b == a.
export function ddSq(ahi: number, alo: number): void {
	const p = ahi * ahi;
	const sa = DD_SPLIT * ahi, ah = sa - (sa - ahi), al = ahi - ah;
	let e = ((ah * ah - p) + 2 * ah * al) + al * al;
	e += 2 * ahi * alo;
	_dhi = p + e;
	_dlo = e - (_dhi - p);
}
