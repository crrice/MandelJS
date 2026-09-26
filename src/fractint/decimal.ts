// fractint/decimal.ts — exact decimal ↔ double-double for par centers. Fractint keeps a
// deep center (Mag ≥ 1e13, the bignum path, conventions C2.1) as its full decimal string;
// MandelJS keeps it as hi + lo f64 limbs. BigInt arithmetic, so both directions are exact up
// to the final rounding.
//---------------------------------------------------------------------------\\

// x = m · 10^k exactly (every finite double is a terminating decimal). null outside the
// range where the scaling below stays finite — far beyond any fractal center.
function exactDec(x: number): [bigint, number] | null {
	if (x === 0) return [0n, 0];
	if (!(Math.abs(x) > 1e-250 && Math.abs(x) < 1e250)) return null;
	const f = Math.floor(Math.log2(Math.abs(x))) - 54;   // 2^-f makes the 53-bit mantissa an integer (with slack)
	const m = BigInt(x * Math.pow(2, -f));
	return f < 0 ? [m * 5n ** BigInt(-f), f] : [m * 2n ** BigInt(f), 0];
}

// Bring two scaled decimals to the smaller exponent.
function align(a: [bigint, number], b: [bigint, number]): [bigint, bigint, number] {
	const k = Math.min(a[1], b[1]);
	return [a[0] * 10n ** BigInt(a[1] - k), b[0] * 10n ** BigInt(b[1] - k), k];
}

// A decimal string → [hi, lo]: hi is the correctly rounded double, lo the rounded rest.
export function ddFromDecimal(s: string): [number, number] {
	const t = s.trim(), hi = parseFloat(t);
	const m = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(t);
	const h = exactDec(hi);
	if (!m || !h || !isFinite(hi)) return [hi, 0];
	const d = BigInt((m[2] + m[3]) || "0");
	const [v, w, k] = align([m[1] === "-" ? -d : d, Number(m[4] || 0) - m[3].length], h);
	return [hi, parseFloat(String(v - w) + "e" + k)];
}

// [hi, lo] → the decimal of hi + lo, cut 17 digits below lo's leading digit (well inside
// half an ulp of lo, so ddFromDecimal gives the same sum back); with lo = 0, cut at DD
// precision (34 digits), so the bignum reader sees hi and a negligible lo.
export function ddToDecimal(hi: number, lo: number): string {
	const a = exactDec(hi), b = exactDec(lo);
	if (!a || !b) return String(hi);
	if (hi === 0 && lo === 0) return "0";
	const [x, y, k] = align(a, b);
	const sum = x + y, neg = sum < 0n;
	let digits = String(neg ? -sum : sum), exp = k;
	const cut = Math.floor(Math.log10(lo !== 0 ? Math.abs(lo) : Math.abs(hi) * 1e-17)) - 17 - k;
	if (cut > 0 && cut < digits.length) { exp += cut; digits = digits.slice(0, -cut); }
	digits = digits.replace(/0+$/, (z) => { exp += z.length; return ""; });
	const e10 = exp + digits.length - 1;   // as d.ddd…e±n
	return (neg ? "-" : "") + digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + (e10 ? "e" + e10 : "");
}
