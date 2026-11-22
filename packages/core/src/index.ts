/**
 * @mochi-maker/core — the headless document core: the document model, commands, transactions,
 * undo and redo, the replayable log, queries, validation and the project format.
 *
 * Node file-system access is in '@mochi-maker/core/node'.
 */
export * from './errors.js';
export * from './limits.js';
export * from './f32.js';
export * from './schema.js';
export * from './model.js';
export * from './standard.js';
export * from './features.js';
export { decode, encode, visitRefs, EXTRA, F32Num, type JsonTree } from './codec.js';
export { stringifyJson, parseJson } from './json.js';
export {
  emptyDocument,
  applyPatches,
  compareUids,
  DocReader,
  DocView,
  Draft,
  type CanvasInit,
  type Document,
  type Patch,
} from './document.js';
export * as rig from './rig.js';
export {
  INTERPOLATIONS,
  autoHandles,
  clipMotion,
  curveKeys,
  keysToCurve,
  sampleSegments,
  templateMatch,
  type Interpolation,
  type MotionKey,
} from './keys.js';
export {
  REPLACE_KINDS,
  ReplaceArgs,
  planReplace,
  type ReplaceKind,
  type ReplaceProblem,
  type TextChange,
} from './replace.js';
export { brushWeight, type Brush } from './brush.js';
export { fieldAt, solveField } from './record.js';
export { FRAGMENT_FORMAT, copyFragment, type Fragment, type FragmentRef } from './fragment.js';
export { checkInvariants, type Violation } from './invariants.js';
export { lint, type LintResult } from './lint.js';
export {
  defineCommand,
  checkArgs,
  resolveArgs,
  type CommandDef,
  type CommandScope,
  type CommandExample,
} from './command.js';
export {
  COMMANDS,
  getCommand,
  type ArgsOf,
  type CommandMap,
  type CommandName,
  type ResultOf,
} from './commands/index.js';
export {
  listCommands,
  describeCommand,
  searchCommands,
  objectSchema,
  errorCodes,
  type CommandSummary,
  type CommandDescription,
} from './describe.js';
export { query, summarize, toJson, type QueryOptions, type QueryResult } from './query.js';
export {
  Session,
  Tx,
  replay,
  LOG_FORMAT,
  LOG_VERSION,
  type ChangeSummary,
  type CommandCall,
  type LogEntry,
  type RecordedCall,
  type SessionOptions,
  type TransactionOptions,
  type TransactionResult,
} from './session.js';
export { canonicalText, documentHash, hash64 } from './serialize.js';
export {
  MemoryFileSystem,
  MemoryAssetStore,
  FolderAssetStore,
  joinPath,
  sha256Hex,
  type AssetStore,
  type FileSystem,
} from './fs.js';
export {
  saveProject,
  loadProject,
  readBundle,
  decodeBundle,
  projectFiles,
  MIGRATIONS,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  MANIFEST,
  type Migration,
  type ProjectBundle,
  type LoadOptions,
  type SaveReport,
} from './project.js';
export {
  defineOperation,
  runItems,
  type OperationContext,
  type OperationDef,
  type OperationOutput,
  type Preview,
  type RunItemsResult,
} from './operations.js';
export * from './stacking.js';
