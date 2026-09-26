// render.mjs — headless render CLI: rasterize a MandelJS permalink to a PNG in Node,
// through the SAME engine the app runs (dist/node-lib.js: config schema → generated
// kernels → renderRegion → colorSample, with the app's palette bakes). No browser, no
// dependencies (PNG encoding = node:zlib deflate + a CRC32).
//
//   node render.mjs "<?query>" <out.png> [--size WxH] [--iters N] [--noaa]
//   node render.mjs "?cx=0&cy=0&span=3.2&j=1&jx=0.323&jy=-0.046&pal=custom&stops=ffffff&inset=000000" .renders/julia.png --size 640x640
//
// --noaa: 1-sample per pixel (no edge supersampling). With a single-stop palette + a
// forced cap (&cap=N — dwell ≥ N renders as the in-set color), output is EXACTLY
// two-tone: a binary dwell level-set, every pixel one of the two colors.
//
// Faithfulness notes: renders the SSAA'd single pass (edge-supersampled, like the app's
// resting frame) but WITHOUT the app's post-pass niceties — no probe-sized cap (pass
// --iters for deep windows), no sharpening ladder, no level-snap repaint (non-cyclic
// palettes use the provisional 0..1/densityMul mapping), density is the zoom-1 mapping.
// Build first: npm run build.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import * as M from "./dist/node-lib.js";

//---------------------------------------------------------------------------\\
// Args
//---------------------------------------------------------------------------\\

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--size") flags.size = args[++i];
	else if (args[i] === "--iters") flags.iters = Number(args[++i]);
	else if (args[i] === "--noaa") flags.noaa = true;
	else if (args[i] === "--noperiod") flags.noperiod = true;
	else pos.push(args[i]);
}
const [query, outPath] = pos;
if (!query || !outPath) {
	console.error('usage: node render.mjs "<?query>" <out.png> [--size WxH] [--iters N]');
	process.exit(2);
}
const sm = /^(\d+)x(\d+)$/.exec(flags.size || "640x320");
if (!sm) { console.error("--size must look like 640x640"); process.exit(2); }
const W = Number(sm[1]), H = Number(sm[2]);

//---------------------------------------------------------------------------\\
// Engine setup — the golden-runner recipe: state → kernels → frame → renderRegion.
//---------------------------------------------------------------------------\\

const { state, rawView } = M.stateFromUrl(query);
const raw = rawView || { cx: -1, cxLo: 0, cy: 0, cyLo: 0, span: 4 };
const view = { cx: raw.cx, cxLo: raw.cxLo, cy: raw.cy, cyLo: raw.cyLo, spanX: raw.span, spanY: raw.span / (W / H), rot: raw.rot, skew: raw.skew, xmag: raw.xmag };

let formulaBody = null;
const preset = M.PRESETS[state.formulaKey];
const src = state.formulaKey === "custom" ? state.expr : preset && preset.formula;
if (src) {
	const res = M.compileFormula(src);
	if (!res.ok) { console.error("formula failed to compile: " + (res.error || "")); process.exit(1); }
	formulaBody = res.body;
}
const filterId = Number(state.filterId) || 0;
// --noperiod: bake the cycle-detector OUT. Near parabolic parameters the Brent ε-check
// can falsely mark slow-crawling EXTERIOR orbits as periodic (in-set); disabling it makes
// a threshold render an honest dwell level-set (at the cost of no interior early-out).
const usePeriod = !flags.noperiod;
M.installKernels(M.assembleAll({ usePeriod, formulaBody, filterId, juliaMode: state.juliaOn }).srcs);

const k2 = formulaBody != null || state.juliaOn || filterId !== 0;
const useDD = k2 ? false : M.useDDFor(view, W);
const usePert = useDD;
const maxIters = flags.iters || state.cap || 1500;

// Palette: the app's own bakes. Custom stops/inset are absolute; theme args only matter
// for the theme-aware built-ins ("subtle") — standalone dark fallbacks used there.
const density = Number(state.density) || 32;
const pal = state.paletteKey === "custom"
	? M.customPalette(state.stops, state.inset, state.cyclic, M.CUSTOM_DENSITY)
	: (M.PALETTES[state.paletteKey] || M.PALETTES.escape);
const cyclic = state.paletteKey === "custom" ? state.cyclic : pal.cyclic;
const { lut, inSet } = pal.build([231, 231, 226], [14, 15, 18], cyclic);
const mode = state.coloring === "distance" ? 1 : 0;
const bandMap = state.coloring === "linear" ? 0 : state.coloring === "sqrt" ? 1 : 2;

M.setFrameState({
	usePeriod, periodEps2: M.periodEps2For(view, useDD), useDD, usePert,
	bandMap,
	fractalMode: k2 ? 1 : 0, formulaId: formulaBody != null ? M.FORMULA_CUSTOM : 0,
	juliaMode: state.juliaOn, mSeedAtC: false, juliaCx: state.juliaX, juliaCy: state.juliaY,
	filterId, trapDStrands: Number(state.strands), filterDFactor: Number(state.exposure),
	filterBlend: Number(state.blend), filterDensity: 1,
	ssaaOn: !flags.noaa,   // edge-supersampled like the app's resting frame; --noaa = 1-sample
});
if (k2 && !state.juliaOn && M.decideSeedAtC(view)) {
	M.setFrameState({ usePeriod, periodEps2: M.periodEps2For(view, useDD), useDD, usePert, bandMap, fractalMode: 1, formulaId: M.FORMULA_CUSTOM, juliaMode: false, mSeedAtC: true, juliaCx: state.juliaX, juliaCy: state.juliaY, filterId, trapDStrands: Number(state.strands), filterDFactor: Number(state.exposure), filterBlend: Number(state.blend), filterDensity: 1, ssaaOn: !flags.noaa });
}
if (usePert) M.computeRef(view, maxIters);
M.resetTallies();

const N = W * H;
const out = new Uint32Array(N), mu = new Float32Array(N), de = new Float32Array(N);
const t0 = performance.now();
M.renderRegion(out, mu, de, W, 0, 0, W, H, W, H, view, maxIters, lut, inSet, 1 / density, cyclic, mode);
const ms = performance.now() - t0;

//---------------------------------------------------------------------------\\
// PNG encode — 8-bit RGBA, filter 0 scanlines, one deflated IDAT. The packed Uint32s
// are little-endian ABGR, so the raw byte view is already r,g,b,a order.
//---------------------------------------------------------------------------\\

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const b = Buffer.alloc(8 + data.length + 4);
	b.writeUInt32BE(data.length, 0);
	b.write(type, 4, "ascii");
	data.copy(b, 8);
	b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
	return b;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
const rawRows = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
	rawRows[y * (W * 4 + 1)] = 0;   // filter: none
	bytes.copy(rawRows, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(rawRows, { level: 9 })),
	chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(outPath + "  " + W + "x" + H + "  " + (png.length / 1024).toFixed(0) + "KB  " +
	(M.iterAcc / 1e6).toFixed(1) + "M iters in " + ms.toFixed(0) + "ms  (esc " + M.escAcc + " / in " + M.inAcc + " / per " + M.perAcc + " / cap " + M.capAcc + ")");
