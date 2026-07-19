// formula.ts — a tiny compiler for user-entered iteration formulas f(z, c). Text in, a JS
// straight-line body out, which the renderer splices into the worker's `stepFormula` and (via
// `new Function`) into the main thread's copy. Pure and self-contained: no DOM, no kernel refs —
// the only output is a string. See kernel.ts (the FORMULA_CUSTOM seam) + renderer.setCustomFormula.
//
// Design: parse → validate against a whitelist → CODEGEN (not interpret). The hot loop runs the
// formula millions of times per frame; a tree-walking interpreter would allocate complex
// intermediates and defeat the JIT, so we emit flat f64 arithmetic on (re, im) pairs — the same
// shape the z²+c step has, hand-inlined, in escapeCustom. The user's TEXT never becomes code: only
// whitelisted operations are ever emitted, so there is no eval of user input (the whitelist is the
// entire security gate). Output writes the result to the kernel's (_cre, _cim) scratch (see kernel.ts).
//
// Surface (v1):
//   variables   z, c
//   constants   i, pi, e, and numeric literals (2, 0.5, .5)
//   operators   + - * /   unary -   ^ (power, right-assoc; non-negative integer exponents are
//               expanded to repeated multiply so z^2+c compiles to the same code as the fast path)
//   functions   sin cos tan  sinh cosh tanh  exp log sqrt  conj abs re im   (all unary)
//   implicit *  a NUMBER immediately before an identifier or '(':  4z → 4*z, 3i → 3*i, 2(z+1) →
//               2*(z+1), 2pi → 2*pi. (No identifier·identifier juxtaposition — z*c stays explicit.)
//---------------------------------------------------------------------------\\

// Leaves compile to a (re, im) pair of JS expression strings. A literal "0" imaginary marks a
// genuinely-real value, which lets the codegen fold complex multiplies down to scalar ones.
const F_VARS: { [k: string]: [string, string] } = { z: ["zx", "zy"], c: ["cx", "cy"] };
const F_CONSTS: { [k: string]: [string, string] } = { i: ["0", "1"], pi: ["Math.PI", "0"], e: ["Math.E", "0"] };
const F_FUNCS: { [k: string]: 1 } = {
	sin: 1, cos: 1, tan: 1, sinh: 1, cosh: 1, tanh: 1, exp: 1, log: 1, sqrt: 1, conj: 1, abs: 1, re: 1, im: 1,
};

type FNode =
	| { t: "num"; v: string }
	| { t: "var"; name: string }
	| { t: "const"; name: string }
	| { t: "neg"; a: FNode }
	| { t: "bin"; op: string; a: FNode; b: FNode }
	| { t: "call"; name: string; a: FNode };

interface FCompileResult { ok: boolean; error?: string; body?: string; refsZ?: boolean; refsC?: boolean; }
interface FTok { k: string; v: string; pos: number; }

// Parser/codegen scratch — module globals, safe because a compile runs start-to-finish synchronously
// on one thread (no reentrancy). Prefixed F_/f to avoid colliding with the other concatenated files.
let F_TS: FTok[] = [];
let F_I = 0;
let F_OUT: string[] = [];   // emitted `const …;` lines
let F_N = 0;                // temp counter → f0, f1, …
let F_REFS = { z: false, c: false };

function fErr(msg: string, pos: number): Error { const e = new Error(msg) as Error & { fpos?: number }; e.fpos = pos; return e; }
function fAt(pos: number): string { return pos >= 0 ? " (at position " + (pos + 1) + ")" : ""; }

//---- tokenizer -------------------------------------------------------------\\

function fIsDigit(c: string): boolean { return c >= "0" && c <= "9"; }
function fIsAlpha(c: string): boolean { return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"); }

function fTokenize(src: string): FTok[] {
	const toks: FTok[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
		if (fIsDigit(ch) || ch === ".") {
			let j = i, dot = false;
			while (j < src.length && (fIsDigit(src[j]) || (src[j] === "." && !dot))) { if (src[j] === ".") dot = true; j++; }
			const v = src.slice(i, j);
			if (v === ".") throw fErr("stray '.'", i);
			toks.push({ k: "num", v, pos: i }); i = j; continue;
		}
		if (fIsAlpha(ch)) {
			let j = i; while (j < src.length && fIsAlpha(src[j])) j++;
			toks.push({ k: "id", v: src.slice(i, j).toLowerCase(), pos: i }); i = j; continue;
		}
		if ("+-*/^".indexOf(ch) >= 0) { toks.push({ k: "op", v: ch, pos: i }); i++; continue; }
		if (ch === "(") { toks.push({ k: "lp", v: ch, pos: i }); i++; continue; }
		if (ch === ")") { toks.push({ k: "rp", v: ch, pos: i }); i++; continue; }
		if (ch === ",") { toks.push({ k: "comma", v: ch, pos: i }); i++; continue; }
		throw fErr("unexpected character '" + ch + "'", i);
	}
	// Implicit multiplication: a NUMBER immediately before an identifier or '(' gets a synthetic '*'.
	// Handles 4z, 3i, 2pi, 2(z+1), 2sin(z). Done at the token level so precedence falls out normally
	// (4z^2 → 4*(z^2), since ^ binds tighter than the inserted *).
	const out: FTok[] = [];
	for (let k = 0; k < toks.length; k++) {
		out.push(toks[k]);
		const a = toks[k], b = toks[k + 1];
		if (b && a.k === "num" && (b.k === "id" || b.k === "lp")) out.push({ k: "op", v: "*", pos: b.pos });
	}
	return out;
}

//---- parser (precedence-climbing / Pratt) ----------------------------------\\

const F_BINPREC: { [k: string]: number } = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 4 };

function fPeek(): FTok | undefined { return F_TS[F_I]; }
function fNext(): FTok | undefined { return F_TS[F_I++]; }

// left-assoc for + - * /; right-assoc for ^. Unary minus binds looser than ^ (so -z^2 = -(z^2))
// but tighter than * — its operand is parsed at power precedence.
function fParseExpr(minPrec: number): FNode {
	let left = fParseUnary();
	for (;;) {
		const t = fPeek();
		if (!t || t.k !== "op" || !(t.v in F_BINPREC)) break;
		const prec = F_BINPREC[t.v];
		if (prec < minPrec) break;
		fNext();
		const right = fParseExpr(t.v === "^" ? prec : prec + 1);
		left = { t: "bin", op: t.v, a: left, b: right };
	}
	return left;
}

function fParseUnary(): FNode {
	const t = fPeek();
	if (t && t.k === "op" && t.v === "-") { fNext(); return { t: "neg", a: fParseExpr(4) }; }
	if (t && t.k === "op" && t.v === "+") { fNext(); return fParseUnary(); }
	return fParsePrimary();
}

function fParsePrimary(): FNode {
	const t = fNext();
	if (!t) throw fErr("unexpected end of formula", -1);
	if (t.k === "num") return { t: "num", v: t.v };
	if (t.k === "lp") {
		const e = fParseExpr(1);
		const r = fNext();
		if (!r || r.k !== "rp") throw fErr("expected ')'", r ? r.pos : -1);
		return e;
	}
	if (t.k === "id") {
		const nm = t.v;
		if (nm in F_FUNCS) {
			const lp = fNext();
			if (!lp || lp.k !== "lp") throw fErr("'" + nm + "' needs parentheses, e.g. " + nm + "(z)", t.pos);
			const arg = fParseExpr(1);
			const nx = fNext();
			if (nx && nx.k === "comma") throw fErr("'" + nm + "' takes one argument", nx.pos);
			if (!nx || nx.k !== "rp") throw fErr("expected ')' after " + nm + "(…)", nx ? nx.pos : -1);
			return { t: "call", name: nm, a: arg };
		}
		if (nm in F_VARS) { if (nm === "z") F_REFS.z = true; else F_REFS.c = true; return { t: "var", name: nm }; }
		if (nm in F_CONSTS) return { t: "const", name: nm };
		throw fErr("unknown name '" + nm + "'", t.pos);
	}
	throw fErr("unexpected '" + t.v + "'", t.pos);
}

//---- codegen: FNode → flat (re, im) f64 arithmetic -------------------------\\

// Parenthesize an operand only if it isn't already an atom (identifier, number, or property access),
// so generated code stays readable (bare `zx`, `Math.PI`) while compound terms are safely grouped.
function fP(x: string): string { return /^[A-Za-z0-9_.]+$/.test(x) ? x : "(" + x + ")"; }
function fNegate(x: string): string { return x === "0" ? "0" : "-" + fP(x); }
// Real (scalar) product with 0/1 folding — the payoff of tracking literal-"0" imaginaries.
function fMulR(x: string, y: string): string {
	if (x === "0" || y === "0") return "0";
	if (x === "1") return y;
	if (y === "1") return x;
	return fP(x) + " * " + fP(y);
}
function fAddE(a: string, b: string): string { if (a === "0") return b; if (b === "0") return a; return a + " + " + b; }
function fSubE(a: string, b: string): string { if (b === "0") return a; if (a === "0") return fNegate(b); return a + " - " + fP(b); }

type FPair = { re: string; im: string };

// Materialize a pair: keep atom/temp/zero components inline (cheap to re-reference; preserves the
// literal "0" that marks realness); hoist only compound components into a `const fN`.
function fEmit(p: FPair): FPair {
	return { re: fHoist(p.re), im: fHoist(p.im) };
}
function fHoist(x: string): string {
	if (/^[A-Za-z0-9_.]+$/.test(x)) return x;   // already an atom / temp / literal
	const id = "f" + (F_N++);
	F_OUT.push("const " + id + " = " + x + ";");
	return id;
}

function fMulPair(a: FPair, b: FPair): FPair {
	if (a.im === "0") return { re: fMulR(a.re, b.re), im: fMulR(a.re, b.im) };
	if (b.im === "0") return { re: fMulR(a.re, b.re), im: fMulR(a.im, b.re) };
	return { re: fSubE(fMulR(a.re, b.re), fMulR(a.im, b.im)), im: fAddE(fMulR(a.re, b.im), fMulR(a.im, b.re)) };
}

function fDivPair(a: FPair, b: FPair): FPair {
	if (b.im === "0") {   // real divisor → scale both parts
		const d = fP(b.re);
		return { re: a.re === "0" ? "0" : fP(a.re) + " / " + d, im: a.im === "0" ? "0" : fP(a.im) + " / " + d };
	}
	const den = "f" + (F_N++);
	F_OUT.push("const " + den + " = " + fP(b.re) + " * " + fP(b.re) + " + " + fP(b.im) + " * " + fP(b.im) + ";");
	const reN = fAddE(fMulR(a.re, b.re), fMulR(a.im, b.im));
	const imN = fSubE(fMulR(a.im, b.re), fMulR(a.re, b.im));
	return { re: reN === "0" ? "0" : "(" + reN + ") / " + den, im: imN === "0" ? "0" : "(" + imN + ") / " + den };
}

// Transcendental / projection functions as (re, im) identities over real Math. A literal-"0"
// imaginary operand folds to the real-argument form where that's exact (cosh 0 = 1, sinh 0 = 0);
// log/sqrt keep the full form because the branch matters for a real operand that may be negative.
function fFuncPair(name: string, a: FPair): FPair {
	const x = fP(a.re), y = fP(a.im), yZero = a.im === "0";
	switch (name) {
		case "sin": return yZero ? { re: "Math.sin(" + x + ")", im: "0" }
			: { re: "Math.sin(" + x + ") * Math.cosh(" + y + ")", im: "Math.cos(" + x + ") * Math.sinh(" + y + ")" };
		case "cos": return yZero ? { re: "Math.cos(" + x + ")", im: "0" }
			: { re: "Math.cos(" + x + ") * Math.cosh(" + y + ")", im: "-(Math.sin(" + x + ") * Math.sinh(" + y + "))" };
		case "sinh": return yZero ? { re: "Math.sinh(" + x + ")", im: "0" }
			: { re: "Math.sinh(" + x + ") * Math.cos(" + y + ")", im: "Math.cosh(" + x + ") * Math.sin(" + y + ")" };
		case "cosh": return yZero ? { re: "Math.cosh(" + x + ")", im: "0" }
			: { re: "Math.cosh(" + x + ") * Math.cos(" + y + ")", im: "Math.sinh(" + x + ") * Math.sin(" + y + ")" };
		case "exp": {
			if (yZero) return { re: "Math.exp(" + x + ")", im: "0" };
			const e = "f" + (F_N++); F_OUT.push("const " + e + " = Math.exp(" + x + ");");
			return { re: e + " * Math.cos(" + y + ")", im: e + " * Math.sin(" + y + ")" };
		}
		case "log": {   // ln|z| + i·arg z (principal branch)
			const m = "f" + (F_N++); F_OUT.push("const " + m + " = Math.log(Math.hypot(" + x + ", " + y + "));");
			return { re: m, im: "Math.atan2(" + y + ", " + x + ")" };
		}
		case "sqrt": {   // principal complex sqrt; the general form also handles a negative real operand
			const m = "f" + (F_N++); F_OUT.push("const " + m + " = Math.hypot(" + x + ", " + y + ");");
			return { re: "Math.sqrt(0.5 * (" + m + " + " + x + "))", im: "(" + y + " < 0 ? -1 : 1) * Math.sqrt(0.5 * Math.max(0, " + m + " - " + x + "))" };
		}
		case "conj": return { re: a.re, im: fNegate(a.im) };
		case "abs": return { re: "Math.hypot(" + x + ", " + y + ")", im: "0" };
		case "re": return { re: a.re, im: "0" };
		case "im": return { re: a.im, im: "0" };
	}
	throw fErr("unknown function '" + name + "'", -1);
}

function fGen(node: FNode): FPair {
	switch (node.t) {
		case "num": return { re: node.v, im: "0" };
		case "const": { const p = F_CONSTS[node.name]; return { re: p[0], im: p[1] }; }
		case "var": { const p = F_VARS[node.name]; return { re: p[0], im: p[1] }; }
		case "neg": { const a = fGen(node.a); return { re: fNegate(a.re), im: fNegate(a.im) }; }
		case "call": {
			const a = fGen(node.a);
			if (node.name === "tan") return fEmit(fDivPair(fEmit(fFuncPair("sin", a)), fEmit(fFuncPair("cos", a))));
			if (node.name === "tanh") return fEmit(fDivPair(fEmit(fFuncPair("sinh", a)), fEmit(fFuncPair("cosh", a))));
			return fEmit(fFuncPair(node.name, a));
		}
		case "bin": {
			if (node.op === "^") return fGenPow(node.a, node.b);
			const a = fGen(node.a), b = fGen(node.b);
			if (node.op === "+") return fEmit({ re: fAddE(a.re, b.re), im: fAddE(a.im, b.im) });
			if (node.op === "-") return fEmit({ re: fSubE(a.re, b.re), im: fSubE(a.im, b.im) });
			if (node.op === "*") return fEmit(fMulPair(a, b));
			return fEmit(fDivPair(a, b));   // "/"
		}
	}
	throw fErr("cannot compile node", -1);
}

// z^w. A small non-negative integer exponent → repeated complex multiply (exact + fast; this is what
// makes z^2 compile to the same square as the hardcoded path). Otherwise the general route: exp(w·log z).
function fGenPow(aNode: FNode, bNode: FNode): FPair {
	const a = fGen(aNode);
	if (bNode.t === "num") {
		const n = Number(bNode.v);
		if (Number.isInteger(n) && n >= 0 && n <= 64) {
			if (n === 0) return { re: "1", im: "0" };
			let cur = a;
			for (let k = 1; k < n; k++) cur = fEmit(fMulPair(cur, a));
			return cur;
		}
	}
	const la = fEmit(fFuncPair("log", a));   // log z
	const w = fGen(bNode);
	const wl = fEmit(fMulPair(w, la));       // w · log z
	return fEmit(fFuncPair("exp", wl));      // exp(…)
}

//---- public entry ----------------------------------------------------------\\

// Compile formula text to a stepFormula BODY: a sequence of `const …;` lines ending with
// `_cre = <re>; _cim = <im>;`. The renderer wraps it as `function stepFormula(zx,zy,cx,cy){ … }`
// (worker) and `new Function("zx","zy","cx","cy", body)` (main thread). On any error returns
// { ok:false, error } with a human-readable message (and 1-based position where known).
function compileFormula(src: string): FCompileResult {
	const s = (src || "").trim();
	if (!s) return { ok: false, error: "empty formula" };
	if (s.length > 256) return { ok: false, error: "formula too long (max 256 characters)" };
	F_OUT = []; F_N = 0; F_REFS = { z: false, c: false };
	try {
		F_TS = fTokenize(s); F_I = 0;
		if (F_TS.length === 0) return { ok: false, error: "empty formula" };
		if (F_TS.length > 400) return { ok: false, error: "formula too complex" };
		const root = fParseExpr(1);
		if (F_I < F_TS.length) { const t = F_TS[F_I]; return { ok: false, error: "unexpected '" + t.v + "'" + fAt(t.pos) }; }
		const r = fGen(root);
		const body = (F_OUT.length ? F_OUT.join("\n") + "\n" : "") + "_cre = " + r.re + "; _cim = " + r.im + ";";
		return { ok: true, body, refsZ: F_REFS.z, refsC: F_REFS.c };
	} catch (e) {
		const err = e as Error & { fpos?: number };
		const pos = typeof err.fpos === "number" ? err.fpos : -1;
		return { ok: false, error: (err.message || "parse error") + (pos >= 0 ? fAt(pos) : "") };
	}
}
