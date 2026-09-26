// A permalink corpus beyond the goldens: every param row in non-default positions (custom
// palette + stops/inset/cyc, filters with str/exp/fb, cap, DD lo-limbs, dens, col, ar,
// julia). Each URL is canonical — written in the schema's own row order — so the URL and
// .par round trips must reproduce it byte-for-byte.
import test from "node:test";
import assert from "node:assert/strict";
import { stateFromUrl, urlFromState, parFromState, stateFromPar } from "../dist/node-lib.js";

const CORPUS = [
	// custom palette: stops, inset, bands off, single stop, non-default density
	"?cx=-0.75&cy=0.1&span=0.5&pal=custom&stops=0d0221-3a0ca3-7209b7-f72585-ffd60a&inset=000000",
	"?cx=-0.75&cy=0.1&span=0.5&pal=custom&stops=ff0000-00ff00&inset=ffffff&cyc=0",
	"?cx=-0.75&cy=0.1&span=0.5&pal=custom&stops=abcdef&inset=102030",
	"?cx=-0.75&cy=0.1&span=0.5&pal=custom&stops=0d0221-ffd60a&inset=000000&cyc=0&dens=100",
	// built-in palettes, at and off their own default density
	"?cx=-1&cy=0&span=4&pal=subtle",
	"?cx=-1&cy=0&span=4&pal=jupiter&dens=64",
	"?cx=-1&cy=0&span=4&pal=twilight&dens=32",
	"?cx=-1&cy=0&span=4&dens=8",
	// filters: str/exp, blend B, julia + filter
	"?cx=-1&cy=0&span=4&filt=1&str=0.002&exp=0.5",
	"?cx=-1&cy=0&span=4&filt=1&str=0.3&exp=60&fb=1",
	"?cx=0&cy=0&span=4&j=1&jx=-0.8&jy=0.156&filt=1&str=0.08&exp=4&fb=1",
	// forced cap
	"?cx=-1&cy=0&span=4&cap=1",
	"?cx=-1&cy=0&span=4&cap=1000000",
	// DD lo-limbs (deep views)
	"?cx=-0.7050815446907845&cy=-0.35135614735306503&span=1e-20&cxl=1.2345678901234566e-18&cyl=-3.3e-19",
	"?cx=-1.415381481413331&cy=0.00122318048670787&span=6.6e-25&cxl=-5e-17",
	"?cx=-1.415381481413331&cy=0.00122318048670787&span=6.6e-25&cyl=4.440892098500626e-17",
	// coloring variants
	"?cx=-1&cy=0&span=4&col=linear",
	"?cx=-1&cy=0&span=4&col=sqrt",
	"?cx=-1&cy=0&span=4&col=distance",
	// aspect variants
	"?cx=-1&cy=0&span=4&ar=1.5",
	"?cx=-1&cy=0&span=4&ar=1.3333333",
	"?cx=-1&cy=0&span=4&ar=1.7777778",
	"?cx=-1&cy=0&span=4&ar=1.6",
	"?cx=-1&cy=0&span=4&ar=1",
	// julia: plain, negative/exact f64 seeds, presets and custom formulas
	"?cx=0&cy=0&span=4&j=1&jx=0&jy=0",
	"?cx=0&cy=0&span=3&j=1&jx=0.4206477290564087&jy=-0.5647650444593624",
	"?cx=0&cy=0&span=4&f=cubic&j=1&jx=0.1&jy=0.7",
	"?cx=-0.5&cy=-0.5&span=3.4&f=ship&j=1&jx=-1.75&jy=-0.03",
	"?cx=0&cy=0&span=6&f=cosine",
	"?cx=0&cy=0&span=4&f=custom&expr=z%5E3+-+z+%2B+c&j=1&jx=0.25&jy=0",
	// view affine: rotation / skew / xmag (after the lo-limbs, before the ROWS)
	"?cx=-1&cy=0&span=4&rot=30",
	"?cx=-1.415381481413331&cy=0.00122318048670787&span=6.6e-13&rot=-77.5&skew=0.009948339802928328",
	"?cx=-0.7050815446907845&cy=-0.35135614735306503&span=1e-20&cxl=1.2345678901234566e-18&cyl=-3.3e-19&rot=72.5&skew=-3&xmag=1.5&col=sqrt",
	"?cx=0&cy=0&span=4&xmag=0.5&j=1&jx=-0.8&jy=0.156",
	// formula escape settings: z₀ + bailout (after f/expr, before the Julia rows)
	"?cx=-1&cy=0&span=4&z0=c&bail=2&cap=1000",
	"?cx=0&cy=0&span=4&f=custom&expr=-%28z%5E1.68%29+%2B+z%5E1.4142+%2B+c&z0=0.5231078513927684&bail=10&ar=1.3333333&cap=3200",
	"?cx=0&cy=0&span=4&f=cubic&z0=0.5*c+%2B+0.1*i&bail=3.5&j=1&jx=0.1&jy=0.7",
	"?cx=-1&cy=0&span=4&rot=30&bail=100&col=linear",
	// coloring toggles (after col, before cap) + the map palette (in the palette row)
	"?cx=-1&cy=0&span=4&col=linear&disc=1&lm=538&pb=0&aa=0",
	"?cx=-1&cy=0&span=4&bail=2&pal=map&map=000zzz%3C253%3E000&mapin=1&disc=1&lm=-1&pb=0&cap=3200",
	"?cx=-1&cy=0&span=4&pal=map&map=000zzz%3C253%3E000&dens=32",
	// everything at once
	"?cx=0.5192304140682561&cy=0.7674373931280046&span=1.3382715312396376&f=custom&expr=%28z%5E2+%2B+c%29+*+sin%28z%5E%28c*i%29%29&j=1&jx=0.4206477290564087&jy=0.5647650444593624&filt=1&str=0.1&exp=7.5&fb=1&ar=1.3333333&pal=custom&stops=000000-ffffff&inset=ff8800&cyc=0&dens=12&col=sqrt&cap=5000",
];

function viewOf(rawView) {
	return { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: 0, rot: rawView.rot, skew: rawView.skew, xmag: rawView.xmag };
}

test("every corpus URL round-trips byte-identically", () => {
	for (const u of CORPUS) {
		const { state, rawView } = stateFromUrl(u);
		assert.equal(urlFromState(viewOf(rawView), state), u);
	}
});

test("every corpus URL round-trips through .par", () => {
	for (const u of CORPUS) {
		const { state, rawView } = stateFromUrl(u);
		const back = stateFromPar(parFromState("corpus", viewOf(rawView), state));
		assert.equal(urlFromState(viewOf(back.rawView), back.state), u);
	}
});
