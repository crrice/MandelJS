// fractint/colors.ts — Fractint's colour-map side, bit-faithful to 20.04 (conventions C5): the
// `colors=` string codec, the 6→8-bit expansion, the logmap transfer table and the colour wrap.
// Pure integer/array code: no DOM, no palette.ts — the caller decides how the 256 entries and
// the index table reach the colorizer.
//
//   colors=    three chars per entry (R, G, B), each a 6-bit value from the alphabet
//              0-9 A-Z _ ` a-z  (0..63); `<n>` fills n entries by integer interpolation between
//              its neighbours; entries not given become (40,40,40)
//   8-bit      (v<<2)|(v>>4): 63 → 255, 32 → 130 (encoder.c; the references agree, C5.4)
//   logmap     LogTable[0..maxit] maps an escape count to a colour index (C5.6)
//   wrap       counts ≥ colors fold back onto 1..colors-1, never onto 0 (C5.8)
//---------------------------------------------------------------------------\\

export interface ColorsResult { ok: boolean; error?: string; pal6?: Uint8Array; count?: number; }   // pal6: 256×RGB 6-bit; count: entries given (incl. <n> fills)

function digit6(ch: number): number {
	if (ch >= 48 && ch <= 57) return ch - 48;          // 0-9 → 0..9
	if (ch >= 65 && ch <= 90) return ch - 55;          // A-Z → 10..35
	if (ch >= 95 && ch <= 122) return ch - 59;         // _ ` a-z → 36..63
	return -1;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_`abcdefghijklmnopqrstuvwxyz";

// parse_colors (cmdfiles.c): the same checks, the same integer interpolation.
export function decodeColors(s: string): ColorsResult {
	if (s.startsWith("@")) return { ok: false, error: "colors=" + s + ": map files are not supported" };
	const pal = new Uint8Array(768);
	let i = 0, k = 0, smooth = 0;
	while (k < s.length) {
		if (i >= 256) return { ok: false, error: "colors=: more than 256 entries" };
		if (s[k] === "<") {
			const m = /^<(\d+)>/.exec(s.slice(k));
			if (i === 0 || smooth || !m || +m[1] < 2) return { ok: false, error: "colors=: bad <n> at " + s.slice(k, k + 8) };
			smooth = +m[1];
			i += smooth;
			k += m[0].length;
			continue;
		}
		for (let j = 0; j < 3; j++) {
			const v = k < s.length ? digit6(s.charCodeAt(k)) : -1;
			if (v < 0) return { ok: false, error: "colors=: bad character at " + (s.slice(k, k + 8) || "end") };
			k++;
			pal[i * 3 + j] = v;
			if (smooth) {
				const spread = smooth + 1, start = i - spread, sv = pal[start * 3 + j];
				for (let c = 1; c < spread; c++) {
					pal[(start + c) * 3 + j] = v === sv ? v : Math.floor((c * v + (spread - c) * sv + (spread >> 1)) / spread);
				}
			}
		}
		smooth = 0;
		i++;
	}
	if (smooth) return { ok: false, error: "colors=: <n> cannot end the map" };
	const count = i;
	for (; i < 256; i++) pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = 40;
	return { ok: true, pal6: pal, count };
}

export function expand6(v: number): number { return (v << 2) | (v >> 4); }

// 6-bit RGB triples → 8-bit, entry for entry.
export function pal8FromPal6(pal6: Uint8Array): Uint8Array {
	const out = new Uint8Array(pal6.length);
	for (let j = 0; j < pal6.length; j++) out[j] = expand6(pal6[j]);
	return out;
}

// 8-bit RGB triples → a colors= string (each channel v>>2). With `compress`, runs that the
// decoder's <n> interpolation reproduces exactly are written as <n> (n ≥ 2, always between
// two explicit entries; greedy, longest fill first) — decodeColors gives back the same
// 6-bit map either way.
export function encodeColors(pal8: ArrayLike<number>, compress = false): string {
	const n = Math.floor(pal8.length / 3);
	const p6: number[] = [];
	for (let j = 0; j < n * 3; j++) p6.push((pal8[j] & 255) >> 2);
	const entry = (e: number) => ALPHABET[p6[e * 3]] + ALPHABET[p6[e * 3 + 1]] + ALPHABET[p6[e * 3 + 2]];
	let out = "";
	for (let e = 0; e < n; ) {
		out += entry(e);
		let fill = 0;   // the longest exact fill (interpolation is not monotone in length: try them all)
		if (compress) for (let f = 2; e + f + 1 < n; f++) if (fillsExactly(p6, e, f)) fill = f;
		if (fill) { out += "<" + fill + ">"; e += fill + 1; }
		else e++;
	}
	return out;
}

// Would `<fill>` between entry `start` and entry start+fill+1 reproduce the entries in between?
function fillsExactly(p6: number[], start: number, fill: number): boolean {
	const spread = fill + 1, end = start + spread;
	for (let j = 0; j < 3; j++) {
		const sv = p6[start * 3 + j], ev = p6[end * 3 + j];
		for (let c = 1; c < spread; c++) {
			const v = ev === sv ? ev : Math.floor((c * ev + (spread - c) * sv + (spread >> 1)) / spread);
			if (p6[(start + c) * 3 + j] !== v) return false;
		}
	}
	return true;
}

// logmap= value → Fractint's LogFlag: yes → 1, no → 0, old → -1, else the integer
// (n > 1: linear-then-log with offset n; -n ≤ -2: the sqrt form). null = bad value.
export function parseLogmap(v: string): number | null {
	const c = v.charAt(0).toLowerCase();
	if (c === "y") return 1;
	if (c === "n") return 0;
	if (c === "o") return -1;
	return /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : null;
}

// SetupLogTable + logtablecalc (calcfrac.c, mpmath_c.c): LogTable[0..maxit] (MaxLTSize = maxit),
// looked up as table[min(count, maxit)]. `logFlag` is the EFFECTIVE flag — Fractint's automatic
// forms (logmap=2/-2, logmode=auto) first replace it with ±(minimum border count), which only a
// render can know. Stored as BYTE, as Fractint does (so an entry of 256 wraps to 0). null for
// logFlag 0 (no logmap). `saveRelease` < 2002 selects the old linear segment (+1 when lf > 0).
export function logmapTable(logFlag: number, maxit: number, colors = 256, saveRelease = 2004): Uint8Array | null {
	if (logFlag === 0) return null;
	const maxLT = maxit, table = new Uint8Array(maxLT + 1);
	let lf = 0, mlf = 0;
	if (logFlag > 0) {
		lf = logFlag > 1 ? Math.min(logFlag, maxLT - 1) : 0;
		mlf = (colors - (lf ? 2 : 1)) / Math.log(maxLT - lf);
	} else if (logFlag === -1) {
		mlf = (colors - 1) / Math.log(maxLT);
	} else {
		lf = Math.min(-logFlag, maxLT - 1);
		mlf = (colors - 2) / Math.sqrt(maxLT - lf);
	}
	for (let ci = 0; ci <= maxLT; ci++) {
		let f: number;
		if (logFlag > 0) {
			if (ci <= lf) f = 1;
			else if ((ci - lf) / Math.log(ci - lf) <= mlf) f = saveRelease < 2002 ? ci - lf + (lf ? 1 : 0) : ci - lf;
			else f = Math.floor(mlf * Math.log(ci - lf)) + 1;
		} else if (logFlag === -1) {
			f = ci === 0 ? 1 : Math.floor(mlf * Math.log(ci)) + 1;
		} else {
			if (ci <= lf) f = 1;
			else if (ci - lf <= Math.floor(mlf * mlf)) f = ci - lf + 1;
			else f = Math.floor(mlf * Math.sqrt(ci - lf)) + 1;
		}
		table[ci] = f;
	}
	return table;
}

// A colour count → palette index (calcfrac.c): below `colors` it is the index; above, it wraps
// onto 1..colors-1 (index 0 is never reused), or masks for tiny palettes (< 16 colours).
export function colorWrap(c: number, colors = 256): number {
	if (c < colors) return c;
	return colors >= 16 ? ((c - 1) % (colors - 1)) + 1 : c & (colors - 1);
}
