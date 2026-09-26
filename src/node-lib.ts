// node-lib.ts — the Node-facing bundle entry: everything DOM-free that the golden CLI and
// the component tests need, re-exported from one place. Built to dist/node-lib.js by
// build.mjs alongside the browser bundles.
export * from "./kernel/kernel";
export * from "./kernel/assemble";
export * from "./math/dd";
export { FILTERS } from "./filters/index";
export { customPalette, PALETTES } from "./palette";   // DOM-free bakes (themeColors is NOT re-exported)
export * from "./config";
export { compileFormula } from "./formula";
export { FieldStore } from "./render/field";
export type { Levels, TileJob } from "./render/field";
export { BufferSink } from "./render/sink";
export { Emitter } from "./render/events";
export { decideNext, useDDFor, periodEps2For, decideSeedAtC } from "./render/pipeline";
export type { Phase, AdvanceInput, AdvanceDecision } from "./render/pipeline";
export * from "./fractint/par";
export * from "./fractint/colors";
export { translateFrm } from "./fractint/frm-translate";
export type { FrmTranslation, FrmReport, FrmLevel } from "./fractint/frm-translate";
export * from "./math/frame";
export { compileZ0 } from "./formula";
export { z0Key, z0NeedsK2, escapeSpec } from "./render/pipeline";
