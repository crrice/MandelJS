// Fractint frm → MandelJS formula translation (src/fractint/frm-translate.ts): the golden-error
// numbers from conventions C4.13, then the dialect's precedence and quirks (C4.1–C4.11).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { translateFrm, compileFormula } from "../dist/node-lib.js";

const golden = readFileSync(fileURLToPath(new URL("../par/goldenerror.par", import.meta.url)), "utf8");
const MAND_AUTO_CRIT = /frm:MandAutoCritInZ\s*(\{[\s\S]*?\})/.exec(golden)[1];

// Distance in units in the last place between two positive doubles.
function ulps(a, b) {
	const f = new Float64Array([a, b]), u = new BigInt64Array(f.buffer);
	const d = u[0] - u[1];
	return Number(d < 0n ? -d : d);
}

// A frm body with a bailout on z, translated with no params; returns the loop formula.
function loopOf(body, params = [], fns = []) {
	const r = translateFrm("z=pixel:\n" + body + "\n|z| < 4", params, fns);
	assert.ok(r.ok, JSON.stringify(r.report));
	return r.formula;
}
// A constant expression, folded through the init into z0.
function fold(expr) {
	const r = translateFrm("z=" + expr + ":\nz=z+pixel\n|z| < 4", [], []);
	assert.ok(r.ok, JSON.stringify(r.report));
	return r.z0;
}

test("MandAutoCritInZ (goldenerror.par) translates to the critical-point formula", () => {
	const r = translateFrm(MAND_AUTO_CRIT, [-1, 1.68, 1, 1.4142, 0, 0, 0, 0], ["ident"]);
	assert.ok(r.ok, JSON.stringify(r.report));
	assert.ok(ulps(Number(r.z0), 0.5231078513927684) <= 1, "z0 = " + r.z0);
	assert.equal(r.bailout, 10);
	assert.equal(r.formula, "-(z^1.68) + z^1.4142 + c");
	assert.ok(compileFormula(r.formula).ok);
	assert.ok(compileFormula(r.z0).ok);
});

test("^ and unary minus share one left-associative level (C4.3)", () => {
	assert.ok(Math.abs(Number(fold("2^3^2")) - 64) < 1e-12);   // (2^3)^2, not 2^9; 2^3 goes through exp·log
	assert.equal(fold("-2^2"), "4");
	assert.equal(loopOf("z=-z^2+pixel"), "(-z)^2 + c");
	assert.equal(loopOf("z=z^2^3"), "(z^2)^3");
	assert.equal(loopOf("z=-z*z+pixel"), "-z*z + c");
	assert.equal(loopOf("z=pixel-z^2"), "c - z^2");
	assert.equal(fold("1<2 || 3<2 && 5<4"), "0");
});

test("signed exponents and implicit multiplication are errors", () => {
	assert.equal(translateFrm("z=pixel:\nz=z^-2+pixel\n|z|<4", [], []).ok, false);
	assert.equal(translateFrm("z=pixel:\nz=2z+pixel\n|z|<4", [], []).ok, false);
	assert.equal(fold("2^(-1)"), "0.5");
});

test("lexing: comments, joins, case and spaces (C4.1)", () => {
	const r = translateFrm("{ ; comment\n  My Var = 1 5 ; more\n Z = P I X E L :\n z = z*z \\\n + myvar\n |Z| < 4 }", [], []);
	assert.ok(r.ok, JSON.stringify(r.report));
	assert.equal(r.formula, "z*z + 15");
	assert.equal(r.z0, "c");
});

test("|x| is the squared modulus; bailout forms", () => {
	assert.equal(translateFrm("z=pixel:\nz=z*z+pixel\n|z| <= 4", [], []).bailout, 2);
	assert.equal(translateFrm("z=pixel:\nz=z*z+pixel\n16 > |z|", [], []).bailout, 4);
	assert.equal(translateFrm("z=pixel:\nz=z*z+pixel\ncabs(z) < 3", [], []).bailout, 3);
	assert.equal(loopOf("z=z+|z|"), "z + abs(z)^2");
	assert.equal(fold("|(3,4)|"), "25");
});

test("built-ins map onto the MandelJS function set (C4.9)", () => {
	assert.equal(loopOf("z=sqr(z)+real(z)+imag(z)"), "z^2 + re(z) + im(z)");
	assert.equal(loopOf("z=cabs(z)+abs(z)"), "abs(z) + (abs(re(z)) + abs(im(z))*i)");
	assert.equal(loopOf("z=flip(z)+cosxx(z)"), "im(z) + re(z)*i + conj(cos(z))");
	assert.equal(loopOf("z=cotan(z)*cotanh(z)"), "cos(z)/sin(z)*(cosh(z)/sinh(z))");
	assert.equal(loopOf("z=fn1(z)+fn2(z)+fn3(z)+fn4(z)"), "sin(z) + z^2 + sinh(z) + cosh(z)");
	assert.equal(loopOf("z=fn1(z)+fn2(z)+fn3(z)+fn4(z)", [], ["ident", "recip", "zero", "one"]), "z + 1/z + 1");
	assert.equal(fold("abs((-1,-2))"), "1 + 2*i");
	assert.equal(fold("flip((1,2))"), "2 + i");
});

test("params, pixel and c: c is not predefined", () => {
	assert.equal(loopOf("z=z*z+p1+p2", [0.25, -0.5, 0, 1], []), "z*z + (0.25 - 0.5*i) + i");
	const r = translateFrm("z=pixel:\nz=z*z+c\n|z|<4", [], []);
	assert.equal(r.formula, "z*z");
	assert.ok(r.report.some((e) => e.level === "warn" && /'c'/.test(e.msg)));
});

test("Fractint division and power fold to f64 literals (C4.7, C4.8)", () => {
	assert.equal(fold("1/(1.4142-1.68)"), "-3.762227238525207");
	assert.equal(fold("0^(0.5,1)"), "0");
	assert.equal(fold("0.0000001"), "0.0000001");
	assert.equal(fold("(1,2)"), "1 + 2*i");
	assert.equal(fold("(0,-1)"), "-i");
});

test("20.04 parse quirks are reproduced with a warning (C4.11)", () => {
	assert.equal(fold("-(3)"), "0");
	assert.equal(fold("-(1,2)"), "2*i");
	assert.equal(fold("1e-3"), "-2.999");
	assert.equal(fold("1e+3"), "1003");
	assert.equal(fold("1e3"), "1000");
});

test("loop temporaries inline; one carried variable, renamed to z", () => {
	assert.equal(loopOf("t=z*z\nz=t+pixel"), "z*z + c");
	const r = translateFrm("w=pixel:\nw=w*w+pixel\n|w|<4", [], []);
	assert.equal(r.formula, "z*z + c");
	assert.equal(r.z0, "c");
	const b = translateFrm("z=pixel:\nz=z*z+pixel\nw=z\n|w|<4", [], []);
	assert.ok(b.ok);
	assert.equal(b.formula, "z*z + c");
});

test("untranslatable constructs are reported, not dropped", () => {
	const cases = [
		"z=pixel:\nz=z*z+w\nw=z\n|z|<4",               // two carried variables
		"z=pixel:\nif(real(z)>0)\nz=z*z\nendif\n|z|<4",   // control flow
		"z=pixel:\nz=floor(z)+pixel\n|z|<4",              // no equivalent function
		"z=pixel:\nz=z*z+rand\n|z|<4",                    // predefined without equivalent
		"z=pixel:\nz=z*z+pixel\n|real(z)|<4",             // non-standard bailout
		"z=pixel:\nz=z*z+pixel\n|z|<4 && |z|>0.1",        // combined bailout
		"pixel=0,z=0:\nz=z*z+pixel\n|z|<4",               // reassigned predefined
		"z=pixel:\nz=ident(z)\n|z|<4",                    // bind-only function called directly
		"z=pixel:\nz=z*z+pixel",                          // no bailout
	];
	for (const src of cases) {
		const r = translateFrm(src, [], []);
		assert.equal(r.ok, false, src);
		assert.ok(r.report.some((e) => e.level === "unsupported"), src);
	}
});

test("read-before-write warns and reads 0 (C4.5)", () => {
	const r = translateFrm("z=z*z+pixel\n|z|<4", [], []);
	assert.ok(r.ok);
	assert.equal(r.z0, "0");
	assert.ok(r.report.some((e) => e.level === "warn"));
});
