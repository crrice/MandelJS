// ui/viewport.ts — canvas geometry: the CSS box (how big it LOOKS) decoupled from the
// buffer (how many pixels get COMPUTED). The CSS box follows the container width and the
// REQUESTED aspect — and the view's spanY derives from that same requested aspect, so a
// permalink frames the identical complex-plane window on every device; only the pixel
// count varies. The buffer is css × dpr clamped by the resolution policy, a DEVICE-LOCAL
// preference (localStorage) that deliberately never enters the URL.
export type ResolutionMode = "auto" | "1x" | "native" | "native2x";

const RES_KEY = "mandeljs-resolution";
const CSS_MAX_W = 2400;        // safety ceiling, CSS px — in practice the content column caps the width
const CSS_MAX_VH = 0.85;       // tallest, as a fraction of the viewport
// Auto-mode pixel budgets by device class. Render time scales linearly with buffer
// pixels, so these are the "sane default" knee points — tunable from device testing.
const AUTO_BUDGET_COARSE = 1_200_000;   // touch devices
const AUTO_BUDGET_FINE = 4_000_000;     // desktops

export function getResolution(): ResolutionMode {
	try {
		const v = localStorage.getItem(RES_KEY);
		if (v === "1x" || v === "native" || v === "native2x") return v;
	} catch { /* storage unavailable → auto */ }
	return "auto";
}
export function setResolution(m: ResolutionMode): void {
	try { localStorage.setItem(RES_KEY, m); } catch { /* fine — just not persisted */ }
}

export interface Geometry { cssW: number; cssH: number; bufW: number; bufH: number; }

// Compute the CSS box + buffer for a container width, requested aspect, and mode.
export function computeGeometry(containerW: number, aspect: number, mode: ResolutionMode): Geometry {
	let cssW = Math.min(Math.max(containerW, 200), CSS_MAX_W);
	let cssH = cssW / aspect;
	const maxH = (window.innerHeight || 800) * CSS_MAX_VH;
	if (cssH > maxH) { cssH = maxH; cssW = cssH * aspect; }
	const dpr = window.devicePixelRatio || 1;
	let scale: number;
	switch (mode) {
		case "1x": scale = 1; break;
		case "native": scale = dpr; break;
		case "native2x": scale = dpr * 2; break;
		default: {   // auto: native sharpness, clamped to the device-class pixel budget
			const budget = matchMedia("(pointer: coarse)").matches ? AUTO_BUDGET_COARSE : AUTO_BUDGET_FINE;
			scale = Math.min(dpr, Math.sqrt(budget / (cssW * cssH)));
			break;
		}
	}
	const bufW = Math.max(64, Math.round(cssW * scale));
	const bufH = Math.max(32, Math.round(bufW / aspect));
	return { cssW, cssH, bufW, bufH };
}

// Apply a geometry to the easel + base canvas (+ the selector's overlay, handled by its
// own syncGeometry). Buffer writes CLEAR a canvas, so they're skipped when unchanged —
// a CSS-only change (window resize that doesn't move the buffer) keeps the frame.
export function applyGeometry(canvas: HTMLCanvasElement, easel: HTMLElement, g: Geometry): boolean {
	const bufChanged = canvas.width !== g.bufW || canvas.height !== g.bufH;
	if (bufChanged) { canvas.width = g.bufW; canvas.height = g.bufH; }
	canvas.style.width = g.cssW + "px";
	canvas.style.height = g.cssH + "px";
	easel.style.width = g.cssW + "px";
	easel.style.height = g.cssH + "px";
	return bufChanged;
}

// Pin an exact buffer at 1:1 CSS (the golden capture's legacy 640-base geometry, and the
// tierazon repro's fixed 640×480 window).
export function pinGeometry(canvas: HTMLCanvasElement, easel: HTMLElement, bufW: number, bufH: number): void {
	canvas.width = bufW; canvas.height = bufH;
	canvas.style.width = bufW + "px";
	canvas.style.height = bufH + "px";
	easel.style.width = bufW + "px";
	easel.style.height = bufH + "px";
}
