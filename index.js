"use strict";
const easel = document.querySelector(".easel");
const canvas = document.querySelector(".fractal");
const ctx = canvas.getContext("2d");
// Basic fill with black...
ctx.fillStyle = "black";
ctx.fillRect(0, 0, canvas.width, canvas.height);
const DEFAULT_GEN_CONFIG = {
    vw: 4,
    vh: 2,
    center: [-1, 0],
    max_iters: 1000,
    iterFunc: (z, c) => cAdd(cMult(z, z), c),
    colorFunc: () => [255, 255, 255]
};
function genFractal(usercfg) {
    const cfg = Object.assign(Object.assign({}, DEFAULT_GEN_CONFIG), usercfg);
    const imgdata = ctx.getImageData(0, 0, canvas.width, canvas.height);
    function setPixelColor(px, py, color) {
        let offset = (py * canvas.width + px) * 4;
        color.forEach(c => imgdata.data[offset++] = c);
    }
    for (let px = 0; px < canvas.width; px++) {
        for (let py = 0; py < canvas.height; py++) {
            // Pixel coordinates transformed to space coordinates:
            const tx = (px / canvas.width) * cfg.vw - cfg.vw / 2 + cfg.center[0];
            const ty = (py / canvas.height) * cfg.vh - cfg.vh / 2 + cfg.center[1];
            // Complex values z and c:
            let z = [tx, ty];
            let c = [tx, ty];
            // Set an iteration limit, i.
            let i = 0;
            while (i++ < cfg.max_iters && cAbsLT(z, 2)) {
                z = cfg.iterFunc(z, c);
            }
            // If the iter limit was not exceeded, color the point, otherwise use black.
            setPixelColor(px, py, i < cfg.max_iters ? cfg.colorFunc(i / cfg.max_iters) : [0, 0, 0]);
        }
    }
    ctx.putImageData(imgdata, 0, 0);
}
//--- Complex Operators ---\\
function cAbsLT(z, dist) {
    return z[0] ** 2 + z[1] ** 2 < dist ** 2;
}
function cAdd(z1, z2) {
    return [
        z1[0] + z2[0],
        z1[1] + z2[1],
    ];
}
function cMult(z1, z2) {
    // (a+bi)(c+di) = (ac-bd) + (ad + bc)i
    return [
        z1[0] * z2[0] - z1[1] * z2[1],
        z1[0] * z2[1] + z1[1] * z2[0],
    ];
}
//--- Initial Draw Call ---\\
genFractal({});
//---------------\\
// Interactivity \\
//---------------\\
class CanvasBoxZoomer {
    constructor(canvas) {
        //--- Mouse Move Fns ---\\
        this.is_down = false;
        this.start_pos = [0, 0];
        this.end_pos = [0, 0];
        this.canvas = document.createElement("canvas");
        this.canvas.width = canvas.width;
        this.canvas.height = canvas.height;
        easel.appendChild(this.canvas);
        this.ctx = this.canvas.getContext("2d");
        this.ctx = this.ctx;
        ctx.fillStyle = "#000000ff";
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
        this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
        this.canvas.addEventListener("mouseup", this.onMouseUp.bind(this));
    }
    onMouseDown(ev) {
        this.start_pos = [ev.offsetX, ev.offsetY];
        this.is_down = true;
        console.log("Start: ", this.start_pos);
    }
    onMouseMove(ev) {
        if (!this.is_down)
            return;
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
        if (dims.some(d => d < 10))
            return;
        // Clear old rect...
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        // Draw new rect...
        this.ctx.beginPath();
        this.ctx.rect(tl[0], tl[1], dims[0], dims[1]);
        this.ctx.stroke();
    }
    onMouseUp(ev) {
        this.end_pos = [ev.offsetX, ev.offsetY];
        this.is_down = false;
        console.log("End: ", this.end_pos);
    }
    //--- API ---\\
    getCurrentRect() {
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
        if (dims.some(d => d < 10))
            return undefined;
        return [...tl, ...dims];
    }
    clearRect() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.start_pos = [0, 0];
        this.end_pos = [0, 0];
    }
}
const box_zoomer = new CanvasBoxZoomer(canvas);
const zoom_button = document.querySelector(".zoom-button");
let cur_cfg = {
    vw: 4,
    vh: 2,
    center: [-1, 0],
};
zoom_button.addEventListener("click", () => {
    const rect = box_zoomer.getCurrentRect();
    if (!rect)
        return;
    // Translate rect into new fractal config...
    const rect_center = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
    // const new_vw = cur_cfg.vw * (rect[2] / canvas.width);
    // const new_vh = cur_cfg.vh * (rect[3] / canvas.height);
    const new_center = [
        (rect_center[0] / canvas.width) * cur_cfg.vw - cur_cfg.vw / 2 + cur_cfg.center[0],
        (rect_center[1] / canvas.height) * cur_cfg.vh - cur_cfg.vh / 2 + cur_cfg.center[1],
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
const reset_button = document.querySelector(".reset-button");
reset_button.addEventListener("click", () => {
    cur_cfg = {
        vw: 4,
        vh: 2,
        center: [-1, 0],
    };
    genFractal(cur_cfg);
    box_zoomer.clearRect();
});
