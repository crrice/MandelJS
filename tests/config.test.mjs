// The P1 schema against the golden permalinks: URL and .par round-trips.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stateFromUrl, urlFromState, parFromState, stateFromPar } from "../dist/node-lib.js";

const goldens = JSON.parse(readFileSync(new URL("../goldens/p0-goldens.json", import.meta.url), "utf8"));

function viewOf(rawView) {
	return { cx: rawView.cx, cxLo: rawView.cxLo, cy: rawView.cy, cyLo: rawView.cyLo, spanX: rawView.span, spanY: 0 };
}

test("every golden URL round-trips byte-identically", () => {
	for (const g of goldens.windows) {
		const { state, rawView } = stateFromUrl(g.url);
		assert.equal(urlFromState(viewOf(rawView), state), g.url, g.name);
	}
});

test(".par round-trips through the same rows", () => {
	for (const g of goldens.windows) {
		const { state, rawView } = stateFromUrl(g.url);
		const par = parFromState(g.name, viewOf(rawView), state);
		const back = stateFromPar(par);
		assert.equal(urlFromState(viewOf(back.rawView), back.state), g.url, g.name);
	}
});
