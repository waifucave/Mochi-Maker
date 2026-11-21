/**
 * @mochi-maker/api — the typed agent API (agent API design 2): projects, transactions with one
 * typed method per command, self-description, queries, validation, history, structural diffs,
 * numeric evaluation through Mochi2D, import, export and saving.
 */
export {
  Project,
  type CommandInfo,
  type DrawableState,
  type EvaluateOptions,
  type Evaluation,
  type ProjectOptions,
  type RenderOptions,
  type RenderResult,
  type SweepOptions,
  type VisualDiff,
} from './project.js';
export { txApi, type TxApi } from './methods.js';
export { COMMAND_AREAS, type CommandMethods } from './generated.js';
export { diffDocuments, type DocumentDiff, type ObjectChange } from './diff.js';
export { errorCategory, errorJson, type ErrorCategory, type ErrorJson } from './errors.js';
export { writeExport, REPORT_FILE } from './write.js';
export {
  HISTORY,
  appendHistory,
  historyPath,
  readHistory,
  replayHistory,
  segments,
} from './history.js';
export { contactSheet, difference, type DiffMetrics } from './images.js';
export { openPackRenderer } from './conformance.js';
export { readModelFolder, type ModelFolder } from './modelfolder.js';
// The standard parameter and parameter-group IDs, for agents that create parameters.
export {
  STANDARD_ID_NOTE,
  STANDARD_PARAMETERS,
  STANDARD_PARAMETER_GROUPS,
  STANDARD_SECTIONS,
  caseOnlyStandard,
  standardParameter,
  standardRange,
  type StandardParameter,
  type StandardSection,
} from '@mochi-maker/core';
