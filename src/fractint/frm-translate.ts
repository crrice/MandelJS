// frm-translate.ts — translate a Fractint 20.04 formula (the frm dialect, conventions C4) plus
// its par's params= and function= into MandelJS formula settings: an iteration formula f(z, c)
// in src/formula.ts syntax, an initial z₀ expression, and a bailout radius. Pure and
// self-contained: text in, strings out; the output goes through compileFormula like any
// user-typed formula, so nothing here ever becomes code.
//
// Strategy: parse the frm text with Fractint's own lexing and precedence (C4.1–C4.3), then
// evaluate it SYMBOLICALLY into a MandelJS-shaped expression tree:
//   - params (p1..p5) are numeric literals; user variables are replaced by their expressions;
//     pixel is c; fully numeric subexpressions fold to f64 using Fractint arithmetic (C4.7
//     power, C4.8 division), so init-time constants come out as one literal;
//   - the init block gives z₀; the loop must reduce to a single carried variable (renamed z)
//     plus a final bailout of the form |z| < R² (or cabs(z) < R); loop temporaries inline;
//   - Fractint built-ins are rewritten into the EXISTING MandelJS function set (C4.9).
// Anything that cannot be expressed that way is reported with level "unsupported" and makes
// the result ok:false (the strings are then best-effort, or "" when there is no loop shape).
//
// Deliberate differences, reported as "warn": MandelJS resets every variable per pixel, so a
// read-before-write reads 0 where Fractint would see the previous pixel's value (C4.5).
//---------------------------------------------------------------------------\\

import { compileFormula } from "../formula";

export type FrmLevel = "info" | "warn" | "unsupported";
export interface FrmReport { level: FrmLevel; msg: string; }
// ok: no "unsupported" entry. bailout: iterate while |z| < bailout (|z|² < l in Fractint terms);
// null when the formula has no translatable bailout.
export interface FrmTranslation { ok: boolean; formula: string; z0: string; bailout: number | null; report: FrmReport[]; }

// Fractint-side tree (after parsing) and MandelJS-side tree (after evaluation). A "num" is a
// complex constant; k marks a literal or p1..p5 load, which the DOS fast parser treats as a
// constant exponent (C4.7). In the MandelJS tree "cur" is the loop-carried variable at the
// start of an iteration (printed as z) and "c" is pixel.
type TNode =
	| { t: "num"; re: number; im: number; k: boolean }
	| { t: "var"; name: string }
	| { t: "neg"; a: TNode }
	| { t: "bin"; op: string; a: TNode; b: TNode }
	| { t: "call"; name: string; a: TNode }
	| { t: "mod"; a: TNode };
type MNode =
	| { t: "num"; re: number; im: number; k: boolean }
	| { t: "c" }
	| { t: "cur"; name: string }
	| { t: "neg"; a: MNode }
	| { t: "bin"; op: string; a: MNode; b: MNode }
	| { t: "fn"; name: string; a: MNode }
	| { t: "mod"; a: MNode };
interface TTok { k: string; v: string; num?: number; zero?: boolean; }
interface TStmt { targets: string[]; e: TNode; }

const T_FUNCS: { [k: string]: 1 } = {
	sin: 1, sinh: 1, cos: 1, cosh: 1, sqr: 1, log: 1, exp: 1, abs: 1, conj: 1, real: 1, imag: 1, fn1: 1, fn2: 1, fn3: 1,
	fn4: 1, flip: 1, tan: 1, tanh: 1, cotan: 1, cotanh: 1, cosxx: 1, srand: 1, asin: 1, asinh: 1, acos: 1, acosh: 1,
	atan: 1, atanh: 1, sqrt: 1, cabs: 1, floor: 1, ceil: 1, trunc: 1, round: 1, ident: 1, recip: 1, zero: 1, one: 1,
};
// Predefined names MandelJS has no equivalent for (view, screen or iteration state, rand).
const T_UNSUP_VARS: { [k: string]: 1 } = {
	lastsqr: 1, rand: 1, whitesq: 1, scrnpix: 1, scrnmax: 1, maxit: 1, ismand: 1, center: 1, magxmag: 1, rotskew: 1,
};
const T_FN_DEFAULTS = ["sin", "sqr", "sinh", "cosh"];
const T_CMP: { [k: string]: 1 } = { "<": 1, "<=": 1, ">": 1, ">=": 1, "==": 1, "!=": 1 };

// Translation scratch — module globals, safe because a translation runs start-to-finish
// synchronously (no reentrancy), as in formula.ts.
let T_TS: TTok[] = [];
let T_I = 0;
let T_NEST: string[] = [];   // open "(" / "|" while parsing, so a "|" can close a bar
let T_REPORT: FrmReport[] = [];
let T_PARAMS: number[] = [];
let T_FNS: string[] = [];

function tNote(level: FrmLevel, msg: string): void {
	for (const r of T_REPORT) if (r.level === level && r.msg === msg) return;
	T_REPORT.push({ level, msg });
}

//---- lexing (C4.1) ---------------------------------------------------------\\

// Comments go, backslash-newline joins, newlines become ",", spaces vanish, all lowercase.
function tClean(src: string): string {
	const a = src.indexOf("{"), b = src.lastIndexOf("}");
	const body = a >= 0 ? src.slice(a + 1, b > a ? b : src.length) : src;
	return body.replace(/;[^\n]*/g, "").replace(/\\[ \t\r]*\n/g, "").replace(/\n/g, ",").replace(/[ \t\r]/g, "").toLowerCase();
}

function tTokenize(s: string): TTok[] {
	const toks: TTok[] = [];
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if ((ch >= "0" && ch <= "9") || ch === ".") {
			// Fractint scans [a-z0-9._]* as the token but reads its value with atof from the same
			// place, so "1e-3" is the token "1e" worth 0.001 followed by "-3" (C4.11).
			let j = i; while (j < s.length && /[a-z0-9._]/.test(s[j])) j++;
			const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
			if (!m) throw new Error("bad number '" + s.slice(i, j) + "'");
			if (m[0].length < j - i) throw new Error("'" + s.slice(i, j) + "' is not a number (Fractint has no implicit multiplication)");
			if (m[0].length > j - i) tNote("warn", "Fractint 20.04 reads '" + m[0] + "' as " + s.slice(i, j) + " followed by " + s.slice(j, i + m[0].length) + " (signed-exponent quirk, C4.11); reproduced");
			toks.push({ k: "num", v: s.slice(i, j), num: Number(m[0]) }); i = j; continue;
		}
		if ((ch >= "a" && ch <= "z") || ch === "_") {
			let j = i; while (j < s.length && /[a-z0-9_]/.test(s[j])) j++;
			toks.push({ k: "id", v: s.slice(i, j) }); i = j; continue;
		}
		const two = s.slice(i, i + 2);
		if (two === "<=" || two === ">=" || two === "==" || two === "!=" || two === "&&") { toks.push({ k: "op", v: two }); i += 2; continue; }
		if ("+-*/^<>=|(),:".indexOf(ch) >= 0) { toks.push({ k: "op", v: ch }); i++; continue; }
		throw new Error("unexpected character '" + ch + "'");
	}
	return toks;
}

//---- parsing (C4.2, C4.3) --------------------------------------------------\\

// Levels, loosest first: && || (7), comparisons (6), + - (5), * / (4), then unary minus and ^
// sharing one left-associative level: -a^b = (-a)^b and a^b^c = (a^b)^c.
function tIs(v: string, at = T_I): boolean { const t = T_TS[at]; return !!t && t.k === "op" && t.v === v; }
function tExpect(v: string): void { if (!tIs(v)) throw new Error("expected '" + v + "'"); T_I++; }

function tParseLogic(): TNode {
	let left = tParseCmp();
	for (;;) {
		let op = "";
		if (tIs("&&")) op = "&&";
		else if (tIs("|") && tIs("|", T_I + 1) && T_NEST[T_NEST.length - 1] !== "|") op = "||";
		if (!op) return left;
		T_I += op === "&&" ? 1 : 2;
		left = { t: "bin", op, a: left, b: tParseCmp() };
	}
}

function tParseCmp(): TNode {
	let left = tParseSum();
	while (T_TS[T_I] && T_TS[T_I].k === "op" && T_TS[T_I].v in T_CMP) { const op = T_TS[T_I++].v; left = { t: "bin", op, a: left, b: tParseSum() }; }
	return left;
}

function tParseSum(): TNode {
	let left = tParseProd();
	while (tIs("+") || tIs("-")) { const op = T_TS[T_I++].v; left = { t: "bin", op, a: left, b: tParseProd() }; }
	return left;
}

function tParseProd(): TNode {
	let left = tParsePow();
	while (tIs("*") || tIs("/")) { const op = T_TS[T_I++].v; left = { t: "bin", op, a: left, b: tParsePow() }; }
	return left;
}

function tParsePow(): TNode {
	let left = tParseNeg();
	while (tIs("^")) {
		T_I++;
		if (tIs("-")) throw new Error("Fractint rejects a signed exponent; write a^(-b)");
		left = { t: "bin", op: "^", a: left, b: tParsePrimary() };
	}
	return left;
}

// A literal right after the minus absorbs it (-2^2 = 4). A literal behind "(" instead is read by
// atof from "(…", which gives 0 and swallows the minus: -(3) = 0, -(1,2) = (0,2) (C4.11).
function tParseNeg(): TNode {
	if (!tIs("-")) return tParsePrimary();
	T_I++;
	const t = T_TS[T_I];
	if (t && t.k === "num") { T_I++; return { t: "num", re: -(t.num as number), im: 0, k: true }; }
	let j = T_I; while (tIs("(", j)) j++;
	if (j > T_I && T_TS[j] && T_TS[j].k === "num") {
		T_TS[j].zero = true;
		tNote("warn", "Fractint 20.04 reads -(literal) as 0 and drops the minus (C4.11); reproduced");
		return tParsePrimary();
	}
	return { t: "neg", a: tParseNeg() };
}

function tParsePrimary(): TNode {
	const t = T_TS[T_I++];
	if (!t) throw new Error("unexpected end of formula");
	if (t.k === "num") return { t: "num", re: t.zero ? 0 : t.num as number, im: 0, k: true };
	if (t.k === "id") {
		if (t.v === "if" || t.v === "elseif" || t.v === "else" || t.v === "endif") throw new Error("if/elseif/else/endif is not supported");
		if (t.v in T_FUNCS) {
			T_NEST.push("("); tExpect("("); const a = tParseLogic(); tExpect(")"); T_NEST.pop();
			return { t: "call", name: t.v, a };
		}
		if (tIs("(")) throw new Error("unknown function '" + t.v + "'");
		return { t: "var", name: t.v };
	}
	if (t.v === "(") {
		// complex constant (re,im), each part optionally signed
		const m = tConstPair();
		if (m) return m;
		T_NEST.push("("); const e = tParseLogic(); tExpect(")"); T_NEST.pop();
		return e;
	}
	if (t.v === "|") {
		T_NEST.push("|"); const e = tParseLogic(); tExpect("|"); T_NEST.pop();
		return { t: "mod", a: e };
	}
	throw new Error("unexpected '" + t.v + "'");
}

function tConstPair(): TNode | null {
	let j = T_I;
	const part = (): number | null => {
		const neg = tIs("-", j); if (neg) j++;
		const t = T_TS[j];
		if (!t || t.k !== "num") return null;
		j++;
		return t.zero ? 0 : (neg ? -(t.num as number) : t.num as number);
	};
	const re = part();
	if (re === null || !tIs(",", j)) return null;
	j++;
	const im = part();
	if (im === null || !tIs(")", j)) return null;
	T_I = j + 1;
	return { t: "num", re, im, k: true };
}

// Statements split on "," and one ":" (init : loop). Assignment only at the start of a
// statement, and chains (a = b = expr).
function tParseFrm(s: string): { init: TStmt[]; loop: TStmt[] } {
	T_TS = tTokenize(s); T_I = 0; T_NEST = [];
	const init: TStmt[] = [];
	let loop: TStmt[] = [];
	let split = false;
	while (T_I < T_TS.length) {
		if (tIs(",")) { T_I++; continue; }
		if (tIs(":")) {
			if (split) throw new Error("more than one ':'");
			split = true; init.push(...loop); loop = []; T_I++; continue;
		}
		const targets: string[] = [];
		while (T_TS[T_I].k === "id" && tIs("=", T_I + 1)) { targets.push(T_TS[T_I].v); T_I += 2; }
		loop.push({ targets, e: tParseLogic() });
		if (T_I < T_TS.length && !tIs(",") && !tIs(":")) throw new Error("unexpected '" + T_TS[T_I].v + "'");
	}
	return { init, loop };
}

//---- Fractint complex arithmetic, for constant folding ---------------------\\

type C = [number, number];

function cMul(a: C, b: C): C { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
// C4.8: multiply by the reciprocal's parts, not the textbook quotient.
function cDiv(a: C, b: C): C {
	const m = b[0] * b[0] + b[1] * b[1];
	const yr = b[0] / m, yi = -b[1] / m;
	return [a[0] * yr - a[1] * yi, a[0] * yi + a[1] * yr];
}
function cExp(a: C): C { const e = Math.exp(a[0]); return [e * Math.cos(a[1]), e * Math.sin(a[1])]; }
function cLog(a: C): C { return a[0] === 0 && a[1] === 0 ? [0, 0] : [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1], a[0])]; }
// C4.7: a constant real exponent 2/1/0/-1 is sqr/ident/one/recip; a zero base gives 0.
function cPow(a: C, b: C, k: boolean): C {
	if (k && b[1] === 0) {
		if (b[0] === 2) return cMul(a, a);
		if (b[0] === 1) return a;
		if (b[0] === 0) return [1, 0];
		if (b[0] === -1) return cDiv([1, 0], a);
	}
	if (a[0] === 0 && a[1] === 0) return [0, 0];
	return cExp(cMul(b, cLog(a)));
}
function cFn(name: string, a: C): C {
	const x = a[0], y = a[1];
	switch (name) {
		case "sin": return [Math.sin(x) * Math.cosh(y), Math.cos(x) * Math.sinh(y)];
		case "cos": return [Math.cos(x) * Math.cosh(y), -Math.sin(x) * Math.sinh(y)];
		case "sinh": return [Math.sinh(x) * Math.cos(y), Math.cosh(x) * Math.sin(y)];
		case "cosh": return [Math.cosh(x) * Math.cos(y), Math.sinh(x) * Math.sin(y)];
		case "tan": { const d = Math.cos(2 * x) + Math.cosh(2 * y); return [Math.sin(2 * x) / d, Math.sinh(2 * y) / d]; }
		case "tanh": { const d = Math.cosh(2 * x) + Math.cos(2 * y); return [Math.sinh(2 * x) / d, Math.sin(2 * y) / d]; }
		case "exp": return cExp(a);
		case "log": return cLog(a);
		case "sqrt": { const r = Math.sqrt(Math.sqrt(x * x + y * y)), th = Math.atan2(y, x) / 2; return [r * Math.cos(th), r * Math.sin(th)]; }
		case "conj": return [x, -y];
		case "abs": return [Math.sqrt(x * x + y * y), 0];
		case "re": return [x, 0];
		case "im": return [y, 0];
	}
	throw new Error("cannot fold '" + name + "'");
}

//---- MandelJS tree builders, folding numeric subtrees ----------------------\\

function mNum(re: number, im: number, k = false): MNode {
	if (!isFinite(re) || !isFinite(im)) { tNote("unsupported", "a constant overflows (Fractint escapes every pixel)"); return { t: "num", re: 0, im: 0, k: false }; }
	return { t: "num", re, im, k };
}
function mIs(n: MNode, re: number): boolean { return n.t === "num" && n.re === re && n.im === 0; }
function mC(n: MNode): C { return n.t === "num" ? [n.re, n.im] : [NaN, NaN]; }

function mNeg(a: MNode): MNode {
	if (a.t === "num") return mNum(-a.re, -a.im);
	if (a.t === "neg") return a.a;
	return { t: "neg", a };
}
// Identities that are exact for finite operands (1·x, x+0, …) simplify away.
function mBin(op: string, a: MNode, b: MNode): MNode {
	if (a.t === "num" && b.t === "num") {
		const x = mC(a), y = mC(b);
		if (op === "+") return mNum(x[0] + y[0], x[1] + y[1]);
		if (op === "-") return mNum(x[0] - y[0], x[1] - y[1]);
		if (op === "*") { const r = cMul(x, y); return mNum(r[0], r[1]); }
		if (op === "/") { const r = cDiv(x, y); return mNum(r[0], r[1]); }
		const r = cPow(x, y, b.k); return mNum(r[0], r[1]);
	}
	if ((op === "+" || op === "-") && b.t === "num" && b.re <= 0 && b.im <= 0 && (b.re < 0 || b.im < 0)) return mBin(op === "+" ? "-" : "+", a, mNeg(b));
	if (op === "+") { if (mIs(a, 0)) return b; if (mIs(b, 0)) return a; }
	if (op === "-") { if (mIs(b, 0)) return a; if (mIs(a, 0)) return mNeg(b); }
	if (op === "*") {
		if (mIs(a, 0) || mIs(b, 0)) return mNum(0, 0);
		if (mIs(a, 1)) return b; if (mIs(b, 1)) return a;
		if (mIs(a, -1)) return mNeg(b); if (mIs(b, -1)) return mNeg(a);
	}
	if (op === "/" && mIs(b, 1)) return a;
	if (op === "^" && b.t === "num" && b.k && b.im === 0 && b.re === -1) return mBin("/", mNum(1, 0), a);
	return { t: "bin", op, a, b };
}
function mFn(name: string, a: MNode): MNode {
	if (a.t === "num") { const r = cFn(name, mC(a)); return mNum(r[0], r[1]); }
	return { t: "fn", name, a };
}
function mMod(a: MNode): MNode {
	if (a.t === "num") return mNum(a.re * a.re + a.im * a.im, 0);
	return { t: "mod", a };
}

// C4.9 built-ins onto the existing MandelJS function set.
function mBuiltin(name: string, a: MNode, bound: boolean): MNode {
	const I = mNum(0, 1);
	switch (name) {
		case "sin": case "cos": case "tan": case "sinh": case "cosh": case "tanh": case "exp": case "log": case "sqrt": case "conj":
			return mFn(name, a);
		case "real": return mFn("re", a);
		case "imag": return mFn("im", a);
		case "cabs": return mFn("abs", a);
		case "abs": return mBin("+", mFn("abs", mFn("re", a)), mBin("*", mFn("abs", mFn("im", a)), I));
		case "sqr": return mBin("^", a, mNum(2, 0, true));
		case "flip": return mBin("+", mFn("im", a), mBin("*", mFn("re", a), I));
		case "cosxx": return mFn("conj", mFn("cos", a));
		case "cotan": return mBin("/", mFn("cos", a), mFn("sin", a));
		case "cotanh": return mBin("/", mFn("cosh", a), mFn("sinh", a));
	}
	if (bound) {
		if (name === "ident") return a;
		if (name === "recip") return mBin("/", mNum(1, 0), a);
		if (name === "zero") return mNum(0, 0);
		if (name === "one") return mNum(1, 0);
	}
	if (name === "ident" || name === "recip" || name === "zero" || name === "one") {
		tNote("unsupported", "'" + name + "' can only be bound through fn1..fn4 (Fractint: undefined function)");
	} else tNote("unsupported", "function '" + name + "' has no MandelJS equivalent");
	return mNum(0, 0);
}

//---- evaluation: Fractint tree → MandelJS tree -----------------------------\\

type Env = { [k: string]: MNode };

function tEval(n: TNode, env: Env, where: string): MNode {
	switch (n.t) {
		case "num": return mNum(n.re, n.im, n.k);
		case "var": {
			if (n.name in env) return env[n.name];
			if (n.name === "pixel") return { t: "c" };
			const p = /^p([1-5])$/.exec(n.name);
			if (p) { const i = 2 * (Number(p[1]) - 1); return mNum(T_PARAMS[i] || 0, T_PARAMS[i + 1] || 0, true); }
			if (n.name === "pi") return mNum(Math.atan(1) * 4, 0, true);
			if (n.name === "e") return mNum(Math.exp(1), 0, true);
			if (n.name in T_UNSUP_VARS) { tNote("unsupported", "predefined '" + n.name + "' has no MandelJS equivalent"); return mNum(0, 0); }
			tNote("warn", "'" + n.name + "' is read before it is set in the " + where + "; it starts at 0 (Fractint carries it over from the previous pixel, C4.5)");
			return mNum(0, 0);
		}
		case "neg": return mNeg(tEval(n.a, env, where));
		case "call": {
			const a = tEval(n.a, env, where);
			const f = /^fn([1-4])$/.exec(n.name);
			if (f) return mBuiltin(T_FNS[Number(f[1]) - 1], a, true);
			return mBuiltin(n.name, a, false);
		}
		case "mod": return mMod(tEval(n.a, env, where));
		case "bin": {
			const a = tEval(n.a, env, where), b = tEval(n.b, env, where);
			if ("+-*/^".indexOf(n.op) >= 0) return mBin(n.op, a, b);
			// comparisons and logic look at real parts only (C4.6); fine as constants, not per pixel
			if (a.t === "num" && b.t === "num") {
				const x = a.re, y = b.re;
				const v = n.op === "<" ? x < y : n.op === "<=" ? x <= y : n.op === ">" ? x > y : n.op === ">=" ? x >= y
					: n.op === "==" ? x === y : n.op === "!=" ? x !== y : n.op === "&&" ? x !== 0 && y !== 0 : x !== 0 || y !== 0;
				return mNum(v ? 1 : 0, 0);
			}
			tNote("unsupported", "'" + n.op + "' is only supported in the final bailout test");
			return mNum(0, 0);
		}
	}
}

const T_FIXED: { [k: string]: 1 } = { pixel: 1, pi: 1, e: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1 };

function tRun(stmts: TStmt[], env: Env, where: string): void {
	for (const s of stmts) {
		if (!s.targets.length) continue;   // a bare expression has no effect here
		const v = tEval(s.e, env, where);
		for (const name of s.targets) {
			if (name in T_FIXED || name in T_UNSUP_VARS) tNote("unsupported", "assigning the predefined '" + name + "' is not supported");
			else env[name] = v;
		}
	}
}

// The loop-carried variables an expression reads (start-of-iteration values).
function mCurs(n: MNode, out: { [k: string]: 1 }): void {
	if (n.t === "cur") out[n.name] = 1;
	else if (n.t === "neg" || n.t === "fn" || n.t === "mod") mCurs(n.a, out);
	else if (n.t === "bin") { mCurs(n.a, out); mCurs(n.b, out); }
}

//---- printing: MandelJS formula syntax -------------------------------------\\

// Exact round trip: String(x) digits, with exponent notation spelled out, since formula.ts
// literals are plain decimals.
export function fmtNum(x: number): string {
	const s = String(x);
	const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
	if (!m) return s;
	const frac = m[2] || "";
	const digits = m[1] + frac, exp = Number(m[3]) - frac.length;
	if (exp >= 0) return digits + "0".repeat(exp);
	const pad = digits.padStart(1 - exp, "0");
	return pad.slice(0, exp) + "." + pad.slice(exp);
}

// Precedence in formula.ts: + - (1) < * / (2) < unary minus (3) < ^ (4) < atoms (5). Every
// place the two dialects could disagree gets explicit parentheses.
function mSimple(n: MNode): boolean { return n.t === "num" && ((n.im === 0 && n.re >= 0) || (n.re === 0 && n.im === 1)); }
// A complex constant prints as the sum it is: re + im*i, with signs as unary minus / "-".
function mNumTree(re: number, im: number): MNode {
	const I: MNode = { t: "num", re: 0, im: 1, k: false };
	const imT: MNode = Math.abs(im) === 1 ? I : { t: "bin", op: "*", a: { t: "num", re: Math.abs(im), im: 0, k: false }, b: I };
	const reT: MNode = re < 0 ? { t: "neg", a: { t: "num", re: -re, im: 0, k: false } } : { t: "num", re, im: 0, k: false };
	if (im === 0) return reT;
	if (re === 0) return im < 0 ? { t: "neg", a: imT } : imT;
	return { t: "bin", op: im < 0 ? "-" : "+", a: reT, b: imT };
}
function mPrec(n: MNode): number {
	if (n.t === "num") return mSimple(n) ? 5 : mPrec(mNumTree(n.re, n.im));
	if (n.t === "neg") return 3;
	if (n.t === "mod") return 4;
	if (n.t === "bin") return n.op === "^" ? 4 : n.op === "*" || n.op === "/" ? 2 : 1;
	return 5;
}

function mPrint(n: MNode): string {
	const s = mPrintRaw(n);
	if (s.length > 4096) throw new Error("translated formula is too long");
	return s;
}
function mWrap(n: MNode, ok: boolean): string { const s = mPrint(n); return ok ? s : "(" + s + ")"; }
function mPrintRaw(n: MNode): string {
	switch (n.t) {
		case "num": return mSimple(n) ? (n.im === 1 ? "i" : fmtNum(n.re)) : mPrint(mNumTree(n.re, n.im));
		case "c": return "c";
		case "cur": return "z";
		case "neg": return "-" + mWrap(n.a, mPrec(n.a) === 5);
		case "fn": return n.name + "(" + mPrint(n.a) + ")";
		case "mod": return "abs(" + mPrint(n.a) + ")^2";
		case "bin": {
			if (n.op === "^") return mWrap(n.a, mPrec(n.a) === 5) + "^" + mWrap(n.b, mPrec(n.b) === 5);
			const pb = mPrec(n.b);
			if (n.op === "+" || n.op === "-") return mPrint(n.a) + " " + n.op + " " + mWrap(n.b, pb >= 4 || pb === 2);
			return mWrap(n.a, mPrec(n.a) >= 2) + n.op + mWrap(n.b, pb >= 4);
		}
	}
}

//---- public entry ----------------------------------------------------------\\

// Translate one frm formula (its body, or the whole `name { … }` block) with the par's
// params= values (p1.re, p1.im, p2.re, … as numbers) and function= names (fn1..fn4; missing
// ones default to sin/sqr/sinh/cosh). formula and z0 are formula.ts text (both compile with
// compileFormula); bailout is the escape radius R for |z| < R.
export function translateFrm(frm: string, params: number[], fns: string[]): FrmTranslation {
	T_REPORT = []; T_PARAMS = params || [];
	T_FNS = T_FN_DEFAULTS.map((d, i) => (fns && fns[i] ? fns[i].trim().toLowerCase() : d));
	const fail = (msg: string): FrmTranslation => { tNote("unsupported", msg); return { ok: false, formula: "", z0: "", bailout: null, report: T_REPORT }; };
	let init: TStmt[], loop: TStmt[];
	try {
		({ init, loop } = tParseFrm(tClean(frm)));
	} catch (e) {
		return fail("parse error: " + (e as Error).message);
	}

	// The loop must end in a bailout test on one carried variable: |s| < l, cabs(s) < r, or mirrored.
	const last = loop[loop.length - 1];
	if (!last || last.targets.length) return fail("the loop does not end in a bailout test");
	let e = last.e;
	if (e.t === "bin" && (e.op === ">" || e.op === ">=")) e = { t: "bin", op: e.op === ">" ? "<" : "<=", a: e.b, b: e.a };
	const test = e.t === "bin" && (e.op === "<" || e.op === "<=") ? e.a : null;
	const sq = !!test && test.t === "mod";
	const tv = test && (test.t === "mod" || (test.t === "call" && test.name === "cabs")) ? test.a : null;
	if (!tv || tv.t !== "var" || e.t !== "bin") return fail("only a bailout of the form |z| < limit (or cabs(z) < limit) is supported");
	if (e.op === "<=") tNote("info", "bailout '<=' is treated as '<' (differs only exactly on the circle)");

	const envInit: Env = {};
	tRun(init, envInit, "init");
	const env: Env = {};
	for (const s of loop) for (const name of s.targets) env[name] = { t: "cur", name };
	for (const name in envInit) if (!(name in env)) env[name] = envInit[name];
	tRun(loop.slice(0, -1), env, "loop");

	const bv = env[tv.name] || tEval(tv, env, "loop");
	const lim = tEval(e.b, env, "loop");
	let bailout: number | null = null;
	if (lim.t !== "num") tNote("unsupported", "the bailout limit must be a constant");
	else if (!(lim.re > 0)) tNote("unsupported", "the bailout limit must be positive");
	else bailout = sq ? Math.sqrt(lim.re) : lim.re;

	// Close over the carried variables the bailout variable depends on; exactly one may remain.
	const carried: { [k: string]: 1 } = {};
	mCurs(bv, carried);
	for (let grew = true; grew;) {
		grew = false;
		for (const name in carried) {
			const before = Object.keys(carried).length;
			mCurs(env[name], carried);
			if (Object.keys(carried).length > before) grew = true;
		}
	}
	const names = Object.keys(carried);
	if (names.length !== 1 || env[names[0]] !== bv) {
		return fail(names.length > 1 ? "the loop carries more than one variable (" + names.join(", ") + ")" : "the bailout variable '" + tv.name + "' is not iterated by the loop");
	}
	const s = names[0];
	if (s !== "z") tNote("info", "loop variable '" + s + "' becomes z");
	let z0node = envInit[s];
	if (!z0node) { tNote("warn", "'" + s + "' is not set in the init; it starts at 0 (Fractint carries it over from the previous pixel, C4.5)"); z0node = mNum(0, 0); }

	let formula = "", z0 = "";
	try {
		formula = mPrint(bv);
		z0 = mPrint(z0node);
	} catch (err) {
		return fail((err as Error).message);
	}
	const cf = compileFormula(formula), cz = compileFormula(z0);
	if (!cf.ok) tNote("unsupported", "translated formula does not compile: " + cf.error);
	if (!cz.ok) tNote("unsupported", "translated z0 does not compile: " + cz.error);
	const ok = !T_REPORT.some((r) => r.level === "unsupported");
	return { ok, formula, z0, bailout, report: T_REPORT };
}
