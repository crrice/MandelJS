// ui/par-import.ts — the .par section: load (file picker, drop on the canvas, paste), an
// entry picker for multi-entry files, the import report, and "save .par". Parsing and the
// state mapping live in config.ts / fractint/*; this module only moves text in and out and
// hands an accepted import to the app (which applies it like a permalink).
import { stateFromPar } from "../config";
import { parseParFile } from "../fractint/par";
import type { ParImport } from "../fractint/import";
import { easel } from "./dom";

export interface ParHooks {
	apply: (r: ParImport) => void;          // push an accepted import into the controls + renderer
	exportPar: (name: string) => string;    // the current state as a .par entry
}

const parFile = document.querySelector(".par-file") as HTMLInputElement | null;
const parPaste = document.querySelector(".par-paste") as HTMLButtonElement | null;
const parSave = document.querySelector(".par-save") as HTMLButtonElement | null;
const parName = document.querySelector(".par-name") as HTMLInputElement | null;
const parEntry = document.querySelector(".par-entry") as HTMLSelectElement | null;
const parEntryField = document.querySelector(".par-entry-field") as HTMLElement | null;
const pasteBox = document.querySelector(".par-paste-box") as HTMLElement | null;
const pasteText = document.querySelector(".par-text") as HTMLTextAreaElement | null;
const pasteGo = document.querySelector(".par-paste-go") as HTMLButtonElement | null;
const report = document.querySelector(".par-report") as HTMLElement | null;
const reportList = document.querySelector(".par-report-list") as HTMLElement | null;
const reportHead = document.querySelector(".par-report-head") as HTMLElement | null;
const reportClose = document.querySelector(".par-report-close") as HTMLButtonElement | null;

let source = "";    // the loaded par text the entry picker imports from
let library = "";   // formulas from loaded .frm files, as frm: blocks, offered to every Fractint import

// A .frm file's formulas are bare `Name { ... }` (often `Name(XAXIS) { ... }`); re-label each
// top-level one as an `frm:Name` block so the par parser files it with the par's own blocks.
function frmAsBlocks(text: string): string {
	let inside = false;
	return text.replace(/\r/g, "").split("\n").map((line) => {
		const code = line.split(";")[0];
		let out = line, from = 0;
		if (!inside && code.includes("{")) {
			inside = true;
			from = code.indexOf("{");
			const name = code.slice(0, from).trim();
			if (!name.includes(":")) out = "frm:" + name.replace(/\(.*\)$/, "").trim() + " " + line.slice(line.indexOf("{"));
		}
		if (inside && code.indexOf("}", from) >= 0) inside = false;
		return out;
	}).join("\n");
}

// The report box: a headline plus one row per note that isn't a plain "applied".
function showReport(head: string, r: ParImport | null, errors: string[] = []): void {
	if (!report || !reportList || !reportHead) return;
	reportHead.textContent = head;
	reportList.textContent = "";
	const rows: { key: string; level: string; msg: string }[] = errors.map((msg) => ({ key: "file", level: "error", msg }));
	if (r) for (const n of r.report) if (n.level !== "applied") rows.push(n);
	for (const n of rows) {
		const li = document.createElement("li");
		li.className = "par-" + n.level;
		li.textContent = n.level + " · " + n.key + ": " + n.msg;
		reportList.appendChild(li);
	}
	report.classList.remove("hidden");
}

// Import one entry of the loaded text (library formulas appended for Fractint entries);
// errors = the file's parse errors, listed with the report.
function importEntry(hooks: ParHooks, name: string, errors: string[] = []): void {
	const e = parseParFile(source).entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
	const r = stateFromPar(e && e.dialect === "fractint" ? source + "\n" + library : source, name);
	if (r.error) { showReport("\"" + name + "\" not imported: " + r.error, null, errors); return; }
	hooks.apply(r);
	if (parName) parName.value = name;
	const counts: Record<string, number> = {};
	for (const n of r.report) counts[n.level] = (counts[n.level] || 0) + 1;
	const tally = ["approximated", "ignored", "unsupported"].filter((k) => counts[k]).map((k) => counts[k] + " " + k);
	showReport("imported \"" + name + "\"" + (tally.length ? " · " + tally.join(" · ") : ""), r, errors);
}

// Load par text: list its entries (the picker shows for more than one) and import the first.
function loadText(hooks: ParHooks, text: string, frms: number): void {
	const file = parseParFile(text);
	if (!file.entries.length) {
		showReport(frms ? "loaded " + frms + " formula file(s); load a .par to use them" : "no parameter entries found", null, file.errors);
		return;
	}
	source = text;
	if (parEntry) {
		parEntry.textContent = "";
		for (const e of file.entries) {
			const o = document.createElement("option");
			o.value = o.textContent = e.name;
			parEntry.appendChild(o);
		}
	}
	parEntryField?.classList.toggle("hidden", file.entries.length < 2);
	importEntry(hooks, file.entries[0].name, file.errors);
}

// Read picked or dropped files: .frm files join the formula library, the rest load as par text.
async function loadFiles(hooks: ParHooks, files: FileList): Promise<void> {
	const pars: string[] = [];
	let frms = 0;
	for (const f of Array.from(files)) {
		const text = await f.text();
		if (/\.frm$/i.test(f.name)) { library += "\n" + frmAsBlocks(text); frms++; }
		else pars.push(text);
	}
	loadText(hooks, pars.join("\n"), frms);
}

// A safe download filename from an entry name.
function parFilename(name: string): string {
	return (name.trim().replace(/[^\w.-]+/g, "_") || "mandeljs") + ".par";
}

export function initParImport(hooks: ParHooks): void {
	if (parFile) parFile.addEventListener("change", () => { if (parFile.files) void loadFiles(hooks, parFile.files); parFile.value = ""; });
	if (parEntry) parEntry.addEventListener("change", () => importEntry(hooks, parEntry.value));
	if (parPaste && pasteBox) parPaste.addEventListener("click", () => { pasteBox.classList.toggle("hidden"); pasteText?.focus(); });
	if (pasteGo && pasteText) pasteGo.addEventListener("click", () => loadText(hooks, pasteText.value, 0));
	if (reportClose && report) reportClose.addEventListener("click", () => report.classList.add("hidden"));
	if (parSave) {
		parSave.addEventListener("click", () => {
			const name = parName && parName.value.trim() ? parName.value.trim() : "mandeljs";
			const url = URL.createObjectURL(new Blob([hooks.exportPar(name)], { type: "text/plain" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = parFilename(name);
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		});
	}
	// Drop a .par (and any .frm files it needs) onto the canvas.
	easel.addEventListener("dragover", (e) => { e.preventDefault(); easel.classList.add("is-drop"); });
	easel.addEventListener("dragleave", () => easel.classList.remove("is-drop"));
	easel.addEventListener("drop", (e) => {
		e.preventDefault();
		easel.classList.remove("is-drop");
		if (e.dataTransfer && e.dataTransfer.files.length) void loadFiles(hooks, e.dataTransfer.files);
	});
}
