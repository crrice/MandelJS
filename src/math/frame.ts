// math/frame.ts — the view's pixel→plane basis: rotation, skew and xmag (Fractint's
// center-mag Rot/Skew/Xmag, conventions C2.2/C2.6) as a 2×2 affine around the center.
// Frame coordinates are resolution-independent: u runs -½…½ left→right across the full
// frame width, v runs -½…½ bottom→top (Im up), and the frame corners sit ON the edges
// (C2.6's kx = ky = 1). An axis-aligned view (rot = skew = 0, xmag = 1) keeps the legacy
// (u·spanX, v·spanY) products verbatim, so every existing render stays bit-exact.
import type { View } from "../kernel/kernel";

// The plane basis: a unit step in u moves the point by (ux, uy), a unit step in v by
// (vx, vy). Fractint's M = Rot(-rot) · [[1, tan skew], [0, 1]] · diag(spanX/xmag, spanY):
// on screen (Im up) the content appears rotated counter-clockwise by rot degrees.
export interface Frame { axis: boolean; ux: number; uy: number; vx: number; vy: number; }

// Is the view axis-aligned (the legacy mapping)? Absent fields read as the defaults;
// xmag 0 means 1, as in Fractint.
export function isAxisView(v: View): boolean {
	return !v.rot && !v.skew && (v.xmag || 1) === 1;
}

export function viewFrame(v: View): Frame {
	if (isAxisView(v)) return { axis: true, ux: v.spanX, uy: 0, vx: 0, vy: v.spanY };
	const w = v.spanX / (v.xmag || 1), h = v.spanY;
	const r = (v.rot || 0) * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
	const t = Math.tan((v.skew || 0) * Math.PI / 180);
	return { axis: false, ux: cr * w, uy: -sr * w, vx: (cr * t + sr) * h, vy: (cr - sr * t) * h };
}

// Plane offset from the view center at frame coordinates (u, v), written to the _ox/_oy
// scratch exports (no allocation; copy them into locals right after the call).
export let _ox = 0, _oy = 0;
export function planeOffset(f: Frame, u: number, v: number): void {
	if (f.axis) { _ox = u * f.ux; _oy = v * f.vy; return; }
	_ox = f.ux * u + f.vx * v;
	_oy = f.uy * u + f.vy * v;
}

// The finest plane span across the frame: the width shrinks by xmag > 1 (rotation and
// skew never shrink a pixel). The precision gates + zoom budgets read this; the legacy
// value (spanX) is returned unchanged for xmag = 1.
export function fineSpan(v: View): number {
	const m = Math.abs(v.xmag || 1);
	return m > 1 ? v.spanX / m : v.spanX;
}
