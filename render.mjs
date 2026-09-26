// render.mjs — headless render CLI: rasterize a MandelJS permalink to a PNG in Node,
// through the SAME engine the app runs (dist/node-lib.js: config schema → generated
// kernels → renderRegion → colorSample, with the app's palette bakes). No browser, no
// dependencies (PNG encoding = node:zlib deflate + a CRC32).
//
//   node render.mjs "<?query>" <out.png> [--size WxH] [--iters N] [--noaa]
//   node render.mjs --par par/midgetbrot.par [--entry name] <out.png> [--size WxH]
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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
	else if (args[i] === "--par") flags.par = args[++i];
	else if (args[i] === "--entry") flags.entry = args[++i];
	else pos.push(args[i]);
}
const [query, outPath] = flags.par ? [null, pos[0]] : pos;
if ((!query && !flags.par) || !outPath) {
	console.error('usage: node render.mjs "<?query>" <out.png> [--size WxH] [--iters N]\n       node render.mjs --par <file.par> [--entry name] <out.png> [--size WxH]');
	process.exit(2);
}

// The state: a permalink, or a .par entry (Fractint or MandelJS) through the app's importer.
let state, rawView;
if (flags.par) {
	const imp = M.stateFromPar(readFileSync(flags.par, "utf8"), flags.entry);
	if (imp.error) { console.error("par refused: " + imp.error); process.exit(1); }
	for (const n of imp.report) if (n.level !== "applied") console.error("  " + n.level + "  " + n.key + ": " + n.msg);
	({ state, rawView } = imp);
} else {
	({ state, rawView } = M.stateFromUrl(query));
}
// A par's default size follows its window aspect (square pixels).
const sm = /^(\d+)x(\d+)$/.exec(flags.size || (flags.par ? "640x" + Math.round(640 / Number(state.aspect)) : "640x320"));
if (!sm) { console.error("--size must look like 640x640"); process.exit(2); }
const W = Number(sm[1]), H = Number(sm[2]);

//---------------------------------------------------------------------------\\
// Engine setup + render — the shared headless recipe (src/render/headless.ts).
// --noperiod: bake the cycle-detector OUT. Near parabolic parameters the Brent ε-check
// can falsely mark slow-crawling EXTERIOR orbits as periodic (in-set); disabling it makes
// a threshold render an honest dwell level-set (at the cost of no interior early-out).
//---------------------------------------------------------------------------\\

let frame;
try {
	frame = M.setupHeadless(state, rawView, W, H, { iters: flags.iters, noaa: flags.noaa, noperiod: flags.noperiod });
} catch (e) {
	console.error(e.message); process.exit(1);
}
M.resetTallies();
const t0 = performance.now();
const { out } = M.renderHeadless(frame);
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
