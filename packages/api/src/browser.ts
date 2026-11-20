/**
 * The parts of the agent API that run in a browser (no file system, no headless renderer): the
 * typed method layer, structural diffs and agent error output. The editor's `window.mochi` is
 * built from these over its open session.
 */
export { txApi, type TxApi } from './methods.js';
export { COMMAND_AREAS, type CommandMethods } from './generated.js';
export { diffDocuments, type DocumentDiff, type ObjectChange } from './diff.js';
export { errorCategory, errorJson, type ErrorCategory, type ErrorJson } from './errors.js';
