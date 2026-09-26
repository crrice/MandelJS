// fractint/par.ts — the Fractint .par CONTAINER: a file of named entries `Name { ... }`, each a
// run of whitespace-separated commands (mostly key=value), plus raw `xxx:Name { ... }` blocks
// (frm: formulas, lsys:, ifs: …) that other front ends consume. Pure text in, plain data out:
// no DOM, no AppState — mapping commands onto MandelJS state is the importer's job.
//
// Container rules (conventions C1.1, Fractint 20.04 cmdfiles.c):
//   ;           starts a comment running to the end of the line
//   \           as the LAST character of a physical line (CR dropped) joins the next line: that
//               line's leading chars <= ' ' are skipped and the parts meet with no separator
//               (the par writer breaks long tokens like colors= and center-mag= this way)
//   tokens      whitespace ends a command; several per line; kept in file order (later wins)
//   blocks      a name containing ':' is captured RAW (body text verbatim, comments included)
//
// Dialects: the same `Name { ... }` shape also carries MandelJS's own files — the legacy
// "MandelJS parameter set" (one URL row per line: cx/cy/span …) and the Fractint-valid export,
// which adds a `; mandeljs: <query>` comment line for a lossless round trip.
//---------------------------------------------------------------------------\\

export interface ParToken { key: string; value: string | null; }   // "key=value", or a bare "key" (value null)
export type ParDialect = "mandeljs" | "fractint" | "unknown";
export interface ParEntry {
	name: string;
	tokens: ParToken[];      // in file order; continuations joined
	lines: string[];         // the same text as logical lines (continuations joined, comments stripped, trimmed, non-empty) — for line-based dialects whose values hold spaces
	comments: string[];      // every ';' comment inside the entry (text after the ';', trimmed)
	mandeljs: string | null; // the query string of the `; mandeljs: <query>` lines (joined), if any
	dialect: ParDialect;
}
export interface ParBlock { kind: string; name: string; body: string; }   // `kind:name { body }`, body verbatim
export interface ParFile { entries: ParEntry[]; blocks: ParBlock[]; errors: string[]; }

const MANDELJS_TAG = "mandeljs:";

export function parseParFile(text: string): ParFile {
	const lines = text.replace(/\r/g, "").split("\n");
	const out: ParFile = { entries: [], blocks: [], errors: [] };
	let i = 0;
	while (i < lines.length) {
		const semi = lines[i].indexOf(";");
		const code = semi < 0 ? lines[i] : lines[i].slice(0, semi);
		const open = code.indexOf("{");
		if (open < 0) { i++; continue; }
		const name = code.slice(0, open).trim();
		// Collect the body line by line up to the first '}' outside a comment.
		const raw: string[] = [];
		let rest = lines[i].slice(open + 1), closed = false;
		for (;;) {
			const s = rest.indexOf(";");
			const close = (s < 0 ? rest : rest.slice(0, s)).indexOf("}");
			if (close >= 0) { raw.push(rest.slice(0, close)); closed = true; break; }
			raw.push(rest);
			if (++i >= lines.length) break;
			rest = lines[i];
		}
		i++;
		if (!closed) out.errors.push("\"" + name + "\": missing closing }");
		const colon = name.indexOf(":");
		if (colon >= 0) out.blocks.push({ kind: name.slice(0, colon).toLowerCase(), name: name.slice(colon + 1).trim(), body: raw.join("\n") });
		else out.entries.push(entryFromBody(name, raw));
	}
	return out;
}

function entryFromBody(name: string, raw: string[]): ParEntry {
	const logical: string[] = [], comments: string[] = [];
	let pending: string | null = null;   // a line ended by '\', waiting for its continuation
	for (const line of raw) {
		const semi = line.indexOf(";");
		let code = semi < 0 ? line : line.slice(0, semi);
		if (semi >= 0) comments.push(line.slice(semi + 1).trim());
		if (pending != null) code = pending + code.replace(/^[\x00-\x20]+/, "");
		pending = null;
		if (semi < 0 && code.endsWith("\\")) pending = code.slice(0, -1);
		else logical.push(code);
	}
	if (pending != null) logical.push(pending);
	const lines = logical.map((l) => l.trim()).filter((l) => l !== "");
	const tokens: ParToken[] = [];
	for (const l of lines) {
		for (const t of l.split(/\s+/)) {
			const eq = t.indexOf("=");
			tokens.push(eq < 0 ? { key: t, value: null } : { key: t.slice(0, eq), value: t.slice(eq + 1) });
		}
	}
	let mandeljs: string | null = null;
	// The query may span several `; mandeljs:` lines (Fractint reads at most 512 chars per
	// line), joined in order.
	for (const c of comments) if (c.toLowerCase().startsWith(MANDELJS_TAG)) mandeljs = (mandeljs ?? "") + c.slice(MANDELJS_TAG.length).trim();
	const entry: ParEntry = { name, tokens, lines, comments, mandeljs, dialect: "unknown" };
	entry.dialect = parDialect(entry);
	return entry;
}

// A "; mandeljs:" line or the legacy writer's marks (its header comment, its cx/cy/span rows)
// mean MandelJS; Fractint's own framing/type commands mean Fractint. The mandeljs line wins:
// the export writes both, and the query is the lossless one.
export function parDialect(e: ParEntry): ParDialect {
	if (e.mandeljs != null) return "mandeljs";
	if (e.comments.some((c) => /MandelJS parameter set/i.test(c))) return "mandeljs";
	if (e.lines.some((l) => /^(cx|cy|span)=/.test(l))) return "mandeljs";
	if (e.tokens.some((t) => /^(type|reset|center-mag|corners)$/i.test(t.key))) return "fractint";
	return "unknown";
}

// The value of the LAST `key=` in the entry (Fractint applies commands in order, so the last
// one wins); keys compare case-insensitively. null when absent or bare.
export function parGet(e: ParEntry, key: string): string | null {
	const k = key.toLowerCase();
	for (let j = e.tokens.length - 1; j >= 0; j--) if (e.tokens[j].key.toLowerCase() === k) return e.tokens[j].value;
	return null;
}

// The `kind:name` block (e.g. parBlock(file, "frm", "MandAutoCritInZ")); names compare
// case-insensitively, as Fractint's formula lookup does.
export function parBlock(f: ParFile, kind: string, name: string): ParBlock | null {
	const k = kind.toLowerCase(), n = name.toLowerCase();
	for (const b of f.blocks) if (b.kind === k && b.name.toLowerCase() === n) return b;
	return null;
}
