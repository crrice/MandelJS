// render/field.ts — the FieldStore: the per-pixel (mu, de) fields — the compute↔color
// contract — plus every scan over them: capped/edge tile extraction, the auto-level and
// dwell histograms, the provisional range, and the SSAA subsample cache. Pure data + math
// (no DOM, no kernel state) — fully Node-testable. Sentinels: mu finite = smooth escape,
// +Inf = in-set, -Inf (CAPPED) = unresolved; filter mode packs (intensity, parity).
import { CAPPED } from "../kernel/kernel";

// A unit of render work: a tile rectangle. With `idx` it's a point job over those
// tile-local pixels — sharpen (re-iterate capped) by default, SSAA when ssaaJob.
export interface TileJob { ox: number; oy: number; tw: number; th: number; idx?: Int32Array; ssaaJob?: boolean; }

// The authoritative full-field measurements a completed generation yields.
export interface Levels {
	muLo: number; muHi: number;    // 1%/99%-clipped auto-level window for the non-cyclic ramp
	p50: number; p90: number;      // dwell percentiles (log-binned)
	esc: number; ins: number; cap: number;   // pixel classification counts
	muMax: number;                 // deepest escaper's smooth value
}

export class FieldStore {
	public mu = new Float32Array(0);
	public de = new Float32Array(0);
	public width = 0;
	public height = 0;
	// Live deepest-escaper, grown as tiles/sharpens land; reconciled by computeLevels.
	public muMax = -Infinity;
	// Running provisional range (CAPPED pixels' log|z'|), grown per tile so tiles can paint
	// heat before a global level exists; computeProvLevels snaps it once the frame lands.
	public provLo = Infinity;
	public provHi = -Infinity;
	// SSAA subsample cache: per edge pixel, its global index + SS² raw (mu, de) subsamples,
	// kept so a recolor re-averages the anti-aliasing without re-iterating.
	public ssaaPos = new Int32Array(0);
	public ssaaMu = new Float32Array(0);
	public ssaaDe = new Float32Array(0);
	public ssaaCount = 0;

	// (Re)size to the canvas; reallocates only on change (tiles from a differently-sized
	// frame would otherwise write past the end).
	public resize(w: number, h: number): void {
		if (this.width === w && this.height === h) return;
		this.width = w; this.height = h;
		this.mu = new Float32Array(w * h);
		this.de = new Float32Array(w * h);
	}

	// Reset the per-frame accumulators (running prov range, SSAA cache, live max).
	public beginFrame(): void {
		this.muMax = -Infinity;
		this.provLo = Infinity; this.provHi = -Infinity;
		this.ssaaCount = 0;
	}

	// Store a full tile's field, growing muMax and (for CAPPED pixels) the prov range.
	public storeTile(ox: number, oy: number, tw: number, th: number, mu: Float32Array, de: Float32Array): void {
		let mx = this.muMax, lo = this.provLo, hi = this.provHi;
		for (let p = 0; p < mu.length; p++) {
			const v = mu[p];
			if (isFinite(v)) { if (v > mx) mx = v; }
			else if (v === CAPPED) { const d = de[p]; if (isFinite(d)) { if (d < lo) lo = d; if (d > hi) hi = d; } }
		}
		this.muMax = mx; this.provLo = lo; this.provHi = hi;
		const W = this.width;
		for (let r = 0; r < th; r++) {
			const dst = (oy + r) * W + ox, src = r * tw;
			this.mu.set(mu.subarray(src, src + tw), dst);
			this.de.set(de.subarray(src, src + tw), dst);
		}
	}

	// Apply a sharpen result (packed per-point, aligned to idx): update field cells, grow
	// muMax, and report which points resolved (still-CAPPED ones stay for the next stage).
	public updatePoints(ox: number, oy: number, tw: number, idx: Int32Array, mu: Float32Array, de: Float32Array): { resolvedIdx: number[] } {
		const W = this.width, resolvedIdx: number[] = [];
		for (let k = 0; k < idx.length; k++) {
			const p = idx[k], gpos = (oy + ((p / tw) | 0)) * W + ox + (p % tw);
			const val = mu[k];
			this.mu[gpos] = val; this.de[gpos] = de[k];
			if (val !== CAPPED) {
				resolvedIdx.push(k);
				if (isFinite(val) && val > this.muMax) this.muMax = val;
			}
		}
		return { resolvedIdx };
	}

	// Scan for still-undetermined (CAPPED) pixels: total count + the tiles containing any,
	// ordered hardest-first (LPT — erases the ~19% worker-idle tail on deep views).
	public scanCapped(tileW: number, tileH: number): { count: number; tiles: TileJob[] } {
		const W = this.width, H = this.height, mu = this.mu;
		const tiles: TileJob[] = [];
		let total = 0;
		for (let oy = 0; oy < H; oy += tileH) {
			const th = Math.min(tileH, H - oy);
			for (let ox = 0; ox < W; ox += tileW) {
				const tw = Math.min(tileW, W - ox);
				const idxArr: number[] = [];
				for (let r = 0; r < th; r++) {
					const row = (oy + r) * W + ox;
					for (let k = 0; k < tw; k++) if (mu[row + k] === CAPPED) idxArr.push(r * tw + k);
				}
				if (idxArr.length > 0) { tiles.push({ ox, oy, tw, th, idx: Int32Array.from(idxArr) }); total += idxArr.length; }
			}
		}
		tiles.sort((a, b) => b.idx!.length - a.idx!.length); // LPT: hardest tiles first
		return { count: total, tiles };
	}

	// Scan the resolved 1-sample field for EDGE pixels (color differs from a 4-neighbour by
	// > edgeTh) for the background SSAA pass. Colors come from the caller's colorOf — the
	// same coloring the resting frame uses — so cross-tile edges are found with no border.
	public scanEdges(colorOf: (mu: number, de: number) => number, edgeTh: number, tileW: number, tileH: number): { count: number; tiles: TileJob[] } {
		const W = this.width, H = this.height, N = W * H, mu = this.mu, de = this.de;
		const col = new Uint32Array(N);
		for (let i = 0; i < N; i++) col[i] = colorOf(mu[i], de[i]);
		const cd = (a: number, b: number): number =>
			Math.abs((a & 255) - (b & 255)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
		const tiles: TileJob[] = [];
		let total = 0;
		for (let oy = 0; oy < H; oy += tileH) {
			const th = Math.min(tileH, H - oy);
			for (let ox = 0; ox < W; ox += tileW) {
				const tw = Math.min(tileW, W - ox);
				const idxArr: number[] = [];
				for (let r = 0; r < th; r++) {
					const gy = oy + r;
					for (let k = 0; k < tw; k++) {
						const gx = ox + k, gi = gy * W + gx, c = col[gi];
						if ((gx > 0 && cd(c, col[gi - 1]) > edgeTh) ||
							(gx < W - 1 && cd(c, col[gi + 1]) > edgeTh) ||
							(gy > 0 && cd(c, col[gi - W]) > edgeTh) ||
							(gy < H - 1 && cd(c, col[gi + W]) > edgeTh)) idxArr.push(r * tw + k);
					}
				}
				if (idxArr.length > 0) { tiles.push({ ox, oy, tw, th, idx: Int32Array.from(idxArr), ssaaJob: true }); total += idxArr.length; }
			}
		}
		tiles.sort((a, b) => b.idx!.length - a.idx!.length); // LPT: heaviest tiles first
		return { count: total, tiles };
	}

	// The authoritative full-field scan: classification counts + the auto-level window
	// (1%/99% clipped, linear bins) + dwell percentiles (log bins — dwell is heavy-tailed;
	// linear binning collapses p50==p90 against a deep outlier).
	public computeLevels(): Levels {
		const mu = this.mu, N = mu.length;
		let mn = Infinity, mx = -Infinity, cnt = 0, capped = 0, inset = 0;
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (isFinite(m)) { cnt++; if (m < mn) mn = m; if (m > mx) mx = m; }
			else if (m === CAPPED) capped++;
			else inset++;
		}
		this.muMax = mx;
		if (cnt === 0 || mx <= mn) return { muLo: 0, muHi: 1, p50: 0, p90: 0, esc: cnt, ins: inset, cap: capped, muMax: mx };
		const BINS = 512;
		const linHist = new Uint32Array(BINS);
		const logHist = new Uint32Array(BINS);
		const scale = (BINS - 1) / (mx - mn);
		const lmn = Math.log(Math.max(mn, 1)), lmx = Math.log(Math.max(mx, mn + 1));
		const lscale = (BINS - 1) / Math.max(lmx - lmn, 1e-9);
		for (let i = 0; i < N; i++) {
			const m = mu[i];
			if (!isFinite(m)) continue;
			linHist[((m - mn) * scale) | 0]++;
			const lb = ((Math.log(Math.max(m, 1)) - lmn) * lscale) | 0;
			logHist[lb < 0 ? 0 : lb >= BINS ? BINS - 1 : lb]++;
		}
		const loTarget = cnt * 0.01, hiTarget = cnt * 0.99;
		let acc = 0, loBin = 0, hiBin = BINS - 1;
		for (let b = 0; b < BINS; b++) {
			acc += linHist[b];
			if (loBin === 0 && acc >= loTarget) loBin = b;
			if (acc >= hiTarget) { hiBin = b; break; }
		}
		let muLo = mn + loBin / scale;
		let muHi = mn + hiBin / scale;
		if (muHi <= muLo) muHi = muLo + 1;
		const p50Target = cnt * 0.5, p90Target = cnt * 0.9;
		let accL = 0, p50Bin = -1, p90Bin = -1;
		for (let b = 0; b < BINS; b++) {
			accL += logHist[b];
			if (p50Bin < 0 && accL >= p50Target) p50Bin = b;
			if (accL >= p90Target) { p90Bin = b; break; }
		}
		const p50 = Math.exp(lmn + (p50Bin < 0 ? 0 : p50Bin) / lscale);
		const p90 = Math.exp(lmn + (p90Bin < 0 ? 0 : p90Bin) / lscale);
		return { muLo, muHi, p50, p90, esc: cnt, ins: inset, cap: capped, muMax: mx };
	}

	// Filter-mode "levels": window-independent coloring has no frame reference — just tally
	// trapped (intensity ≥ 0) vs miss for the telemetry composition line.
	public computeFilterStats(): Levels {
		const mu = this.mu, N = mu.length;
		let trapped = 0, miss = 0;
		for (let i = 0; i < N; i++) { if (mu[i] < 0) miss++; else trapped++; }
		this.muMax = 0;
		return { muLo: 0, muHi: 1, p50: 0, p90: 0, esc: trapped, ins: miss, cap: 0, muMax: 0 };
	}

	// Auto-level the provisional structure signal (log|z'| in de) over just the CAPPED
	// pixels — 1%/99% clipped like computeLevels. Returns [0,1] when nothing is capped.
	public computeProvLevels(): { lo: number; hi: number } {
		const mu = this.mu, de = this.de, N = mu.length;
		let mn = Infinity, mx = -Infinity, cnt = 0;
		for (let i = 0; i < N; i++) {
			if (mu[i] === CAPPED) { const v = de[i]; if (isFinite(v)) { cnt++; if (v < mn) mn = v; if (v > mx) mx = v; } }
		}
		if (cnt === 0 || mx <= mn) return { lo: 0, hi: 1 };
		const BINS = 256;
		const hist = new Uint32Array(BINS);
		const scale = (BINS - 1) / (mx - mn);
		for (let i = 0; i < N; i++) {
			if (mu[i] === CAPPED) { const v = de[i]; if (isFinite(v)) hist[((v - mn) * scale) | 0]++; }
		}
		const loTarget = cnt * 0.01, hiTarget = cnt * 0.99;
		let acc = 0, loBin = 0, hiBin = BINS - 1;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= loTarget) { loBin = b; break; } }
		acc = 0;
		for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= hiTarget) { hiBin = b; break; } }
		let lo = mn + loBin / scale;
		let hi = mn + hiBin / scale;
		if (hi <= lo) hi = lo + 1;
		return { lo, hi };
	}

	// Prepare the SSAA cache for a pass over `count` edge pixels of nSub subsamples each.
	public ssaaBegin(count: number, nSub: number): void {
		this.ssaaPos = new Int32Array(count);
		this.ssaaMu = new Float32Array(count * nSub);
		this.ssaaDe = new Float32Array(count * nSub);
		this.ssaaCount = 0;
	}

	// Cache one edge pixel's subsamples; returns its cache slot.
	public ssaaStore(globalPos: number, mu: Float32Array, de: Float32Array, off: number, nSub: number): number {
		const c = this.ssaaCount++;
		this.ssaaPos[c] = globalPos;
		this.ssaaMu.set(mu.subarray(off, off + nSub), c * nSub);
		this.ssaaDe.set(de.subarray(off, off + nSub), c * nSub);
		return c;
	}
}
