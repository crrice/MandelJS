# MandelJS

A from-scratch Mandelbrot set explorer, drawn pixel-by-pixel on a `<canvas>` in
TypeScript. Escape-time iteration of `z ↦ z² + c`, with a drag-to-select box zoom.
Drag a rectangle over the canvas and hit **zoom** to descend into the boundary;
**reset** returns to the full view.

Zero runtime dependencies — it compiles to a single static page you can open directly.

## Develop

    npm install     # gets the TypeScript compiler
    npm run build   # index.ts -> index.js
    npm run serve   # http-server on :8080  (or just open index.html)

## Notes

The engine (`index.ts`) has no DOM-framework or library dependencies; it only needs a
host page that provides four hooks: a positioned `.easel` containing a
`canvas.fractal`, plus `.zoom-button` and `.reset-button` controls. `index.html` is the
standalone shell; the same engine is also embedded — wrapped in site chrome — on
[fifthaleph.com/fractal-gen](https://fifthaleph.com/fractal-gen).

Extracted from [fifthaleph-site](https://github.com/crrice/fifthaleph-site), where an
earlier version of this lived under `src/pages/fractal-gen`.
