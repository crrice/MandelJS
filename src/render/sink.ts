// render/sink.ts — the render target seam. The pipeline draws ONLY through this
// interface, never touching a canvas directly — which is what lets a future hi-res
// export render to an OffscreenCanvas/BufferSink with zero pipeline changes, and lets
// the Node tests run the paint paths headless.
export interface RenderSink {
	readonly width: number;
	readonly height: number;
	// Translucent grey "working" overlay a new render paints over the stale frame.
	wash(): void;
	// Blit a fully-colored tile buffer (packed RGBA, tile-local rows).
	blitTile(buf: ArrayBuffer, ox: number, oy: number, tw: number, th: number): void;
	// Read-modify-write access to a tile / the whole frame: mutate data32, then commit().
	editTile(ox: number, oy: number, tw: number, th: number): { data32: Uint32Array; commit(): void };
	editFrame(): { data32: Uint32Array; commit(): void };
}

// The on-screen canvas sink. Dimensions are live reads, so a canvas resize (aspect
// selector, tierazon) is picked up by the next render without any resize protocol.
export class CanvasSink implements RenderSink {
	private ctx: CanvasRenderingContext2D;
	public constructor(private canvas: HTMLCanvasElement) {
		this.ctx = canvas.getContext("2d")!;
	}
	public get width(): number { return this.canvas.width; }
	public get height(): number { return this.canvas.height; }
	public wash(): void {
		this.ctx.fillStyle = "rgba(128, 128, 128, 0.5)";
		this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
	}
	public blitTile(buf: ArrayBuffer, ox: number, oy: number, tw: number, th: number): void {
		this.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), tw, th), ox, oy);
	}
	public editTile(ox: number, oy: number, tw: number, th: number): { data32: Uint32Array; commit(): void } {
		const img = this.ctx.getImageData(ox, oy, tw, th);
		return { data32: new Uint32Array(img.data.buffer), commit: () => this.ctx.putImageData(img, ox, oy) };
	}
	public editFrame(): { data32: Uint32Array; commit(): void } {
		return this.editTile(0, 0, this.canvas.width, this.canvas.height);
	}
}

// A plain-memory sink for tests (and the shape a hi-res exporter would use): one
// persistent Uint32 frame, tile edits view into it directly.
export class BufferSink implements RenderSink {
	public readonly frame: Uint32Array;
	public constructor(public readonly width: number, public readonly height: number) {
		this.frame = new Uint32Array(width * height);
	}
	public wash(): void { /* no visual feedback needed off-screen */ }
	public blitTile(buf: ArrayBuffer, ox: number, oy: number, tw: number, th: number): void {
		const src = new Uint32Array(buf);
		for (let r = 0; r < th; r++) this.frame.set(src.subarray(r * tw, r * tw + tw), (oy + r) * this.width + ox);
	}
	public editTile(ox: number, oy: number, tw: number, th: number): { data32: Uint32Array; commit(): void } {
		const data32 = new Uint32Array(tw * th);
		for (let r = 0; r < th; r++) data32.set(this.frame.subarray((oy + r) * this.width + ox, (oy + r) * this.width + ox + tw), r * tw);
		return {
			data32,
			commit: () => { for (let r = 0; r < th; r++) this.frame.set(data32.subarray(r * tw, r * tw + tw), (oy + r) * this.width + ox); },
		};
	}
	public editFrame(): { data32: Uint32Array; commit(): void } {
		return this.editTile(0, 0, this.width, this.height);
	}
}
