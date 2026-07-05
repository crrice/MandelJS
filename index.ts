
const easel = document.querySelector(".easel") as HTMLDivElement;
const canvas = document.querySelector(".fractal") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// Basic fill with black...
ctx.fillStyle = "black";
ctx.fillRect(0, 0, canvas.width, canvas.height);

//--- Config and Iter Function ---\\

interface GenConfig {
	vw: number; // Width of the view area (usually 4)
	vh: number; // Height of the view area (usually 2)

	center: [number, number]; // Center of the view area, usually [-1. 0].

	max_iters: number; // Default 100, higher means slower but more accurate.

	// Define an iteration function.
	// Default is mandelbrot: (z, c) => cAdd(cMult(z, z), c)
	iterFunc: (z: [number, number], c: [number, number]) => [number, number];

	// Coloring function for coordinates that diverge.
	// Argument is the ratio: iterations done / max iterations for the point.
	// Must return a RGB triplet for the color.
	// Default is the constant () => [255, 255, 255] function.
	colorFunc: (ratio: number) => [number, number, number];
}

const DEFAULT_GEN_CONFIG: GenConfig = {
	vw: 4,
	vh: 2,
	center: [-1, 0],

	max_iters: 1000,

	iterFunc: (z, c) => cAdd(cMult(z, z), c),
	colorFunc: () => [255, 255, 255]
};

function genFractal(usercfg: Partial<GenConfig>): void {
	const cfg = {...DEFAULT_GEN_CONFIG, ...usercfg};
	const imgdata = ctx.getImageData(0, 0, canvas.width, canvas.height)!;

	function setPixelColor(px: number, py: number, color: [number, number, number]): void {
		let offset = (py*canvas.width + px)*4;
		color.forEach(c => imgdata.data[offset++] = c);
	}

	for (let px = 0; px < canvas.width; px++) {
	for (let py = 0; py < canvas.height; py++) {
		// Pixel coordinates transformed to space coordinates:
		const tx = (px/canvas.width)*cfg.vw - cfg.vw/2 + cfg.center[0];
		const ty = (py/canvas.height)*cfg.vh - cfg.vh/2 + cfg.center[1];

		// Complex values z and c:
		let z: [number, number] = [tx, ty];
		let c: [number, number] = [tx, ty];

		// Set an iteration limit, i.
		let i = 0;
		while (i++ < cfg.max_iters && cAbsLT(z, 2)) {
			z = cfg.iterFunc(z, c);
		}

		// If the iter limit was not exceeded, color the point, otherwise use black.
		setPixelColor(px, py, i < cfg.max_iters ? cfg.colorFunc(i/cfg.max_iters) : [0, 0, 0]);
		}
	}

	ctx.putImageData(imgdata, 0, 0);

}

//--- Complex Operators ---\\

function cAbsLT(z: [number, number], dist: number): boolean {
	return z[0]**2 + z[1]**2 < dist**2;
}

function cAdd(z1: [number, number], z2: [number, number]): [number, number] {
	return [
		z1[0] + z2[0],
		z1[1] + z2[1],
	];
}

function cMult(z1: [number, number], z2: [number, number]): [number, number] {
	// (a+bi)(c+di) = (ac-bd) + (ad + bc)i
	return [
		z1[0]*z2[0] - z1[1]*z2[1],
		z1[0]*z2[1] + z1[1]*z2[0],
	];
}

//--- Initial Draw Call ---\\

genFractal({});

//---------------\\
// Interactivity \\
//---------------\\

class CanvasBoxZoomer {

	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;

	public constructor(canvas: HTMLCanvasElement) {
		this.canvas = document.createElement("canvas")!;
		this.canvas.width = canvas.width;
		this.canvas.height = canvas.height;

		easel.appendChild(this.canvas);

		this.ctx = this.canvas.getContext("2d")!;
		this.ctx = this.ctx;

		ctx.fillStyle = "#000000ff";
		ctx.strokeStyle = "#000000";
		ctx.lineWidth = 1;

		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
		this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
		this.canvas.addEventListener("mouseup", this.onMouseUp.bind(this));
	}

	//--- Mouse Move Fns ---\\

	private is_down: boolean = false;
	private start_pos: [number, number] = [0, 0];
	private end_pos: [number, number] = [0, 0];

	private onMouseDown(ev: MouseEvent): void {
		this.start_pos = [ev.offsetX, ev.offsetY];
		this.is_down = true;
		console.log("Start: ", this.start_pos);
	}

	private onMouseMove(ev: MouseEvent): void {
		if (!this.is_down) return;
		this.end_pos = [ev.offsetX, ev.offsetY];

		// Get top-left of the start and end...
		const tl = [
			Math.min(this.start_pos[0], this.end_pos[0]),
			Math.min(this.start_pos[1], this.end_pos[1]),
		];

		// Get the distance from that to the other corner...
		const dims = [
			Math.max(this.start_pos[0], this.end_pos[0]) - tl[0],
			Math.max(this.start_pos[1], this.end_pos[1]) - tl[1],
		];

		// Bail early if this is not "recty" enough, lol.
		if (dims.some(d => d < 10)) return;

		// Clear old rect...
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		// Draw new rect...
		this.ctx.beginPath();
		this.ctx.rect(tl[0], tl[1], dims[0], dims[1]);
		this.ctx.stroke();
	}

	private onMouseUp(ev: MouseEvent): void {
		this.end_pos = [ev.offsetX, ev.offsetY];
		this.is_down = false;
		console.log("End: ", this.end_pos);
	}

	//--- API ---\\

	public getCurrentRect(): [number, number, number, number] | undefined {
		// Get top-left of the start and end...
		const tl = [
			Math.min(this.start_pos[0], this.end_pos[0]),
			Math.min(this.start_pos[1], this.end_pos[1]),
		];

		// Get the distance from that to the other corner...
		const dims = [
			Math.max(this.start_pos[0], this.end_pos[0]) - tl[0],
			Math.max(this.start_pos[1], this.end_pos[1]) - tl[1],
		];

		if (dims.some(d => d < 10)) return undefined;
		return [...tl, ...dims] as any;
	}

	public clearRect(): void {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.start_pos = [0, 0];
		this.end_pos = [0, 0];
	}
}

const box_zoomer = new CanvasBoxZoomer(canvas);

const zoom_button = document.querySelector(".zoom-button") as HTMLDivElement;

let cur_cfg: Pick<GenConfig, "vw"|"vh"|"center"> = {
	vw: 4,
	vh: 2,
	center: [-1, 0],
};

zoom_button.addEventListener("click", () => {
	const rect = box_zoomer.getCurrentRect();
	if (!rect) return;

	// Translate rect into new fractal config...
	const rect_center = [rect[0] + rect[2]/2, rect[1] + rect[3]/2];

	// const new_vw = cur_cfg.vw * (rect[2] / canvas.width);
	// const new_vh = cur_cfg.vh * (rect[3] / canvas.height);

	const new_center: [number, number] = [
		(rect_center[0]/canvas.width)*cur_cfg.vw - cur_cfg.vw/2 + cur_cfg.center[0],
		(rect_center[1]/canvas.height)*cur_cfg.vh - cur_cfg.vh/2 + cur_cfg.center[1],
	];

	cur_cfg = {
		// Easy part...
		vw: cur_cfg.vw * (rect[2] / canvas.width),
		vh: cur_cfg.vh * (rect[3] / canvas.height),

		// Fucked part...
		center: new_center,
	};

	genFractal(cur_cfg);

	box_zoomer.clearRect();
});

const reset_button = document.querySelector(".reset-button") as HTMLDivElement;

reset_button.addEventListener("click", () => {
	cur_cfg = {
		vw: 4,
		vh: 2,
		center: [-1, 0],
	};

	genFractal(cur_cfg);
	box_zoomer.clearRect();
})
