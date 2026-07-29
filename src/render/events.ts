// render/events.ts — a tiny typed event emitter, replacing the renderer's four nullable
// callback properties. Zero deps, synchronous dispatch (same timing as the old direct
// callback calls).
export class Emitter<E extends Record<string, unknown>> {
	private handlers: { [K in keyof E]?: Array<(ev: E[K]) => void> } = {};

	// Subscribe; returns an unsubscribe function.
	public on<K extends keyof E>(kind: K, fn: (ev: E[K]) => void): () => void {
		const list = (this.handlers[kind] ??= []);
		list.push(fn);
		return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
	}

	public emit<K extends keyof E>(kind: K, ev: E[K]): void {
		const list = this.handlers[kind];
		if (list) for (const fn of list.slice()) fn(ev);
	}
}
