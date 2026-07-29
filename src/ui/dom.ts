// ui/dom.ts — the page's fixed DOM handles + the debug flag, in one place. Module scripts
// are deferred, so the queries run after the DOM is parsed. This module (not the renderer)
// owns the on-screen canvas; the P2 render-sink abstraction will build on this seam.
export const easel = document.querySelector(".easel") as HTMLDivElement;
export const canvas = document.querySelector(".fractal") as HTMLCanvasElement;
export const ctx = canvas.getContext("2d")!;

// Debug instrumentation toggle (URL: ?debug=1). Off by default so the production
// console stays quiet; on, every completed render logs timing + iteration counts.
export const DEBUG = new URLSearchParams(location.search).has("debug");
