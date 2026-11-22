/**
 * @mochi-maker/export — exports a Mochi Maker document as a model folder for Live2D
 * Cubism-compatible apps, through Mochi2D's public model data, writer and validator.
 */
export {
  exportModel,
  featuresUsed,
  addRuntimeFiles,
  requiredVersion,
  type VersionReason,
  reportText,
  EXPORT_REPORT_FORMAT,
  type ExportOptions,
  type ExportProblem,
  type ExportReport,
  type ExportResult,
} from './export.js';
export {
  lowerDocument,
  type LowerOptions,
  type LowerResult,
  type TexturePlacement,
} from './lower.js';
export { LoweringCache, type LowerStats } from './lowercache.js';
export { BUILD_TEXTURES, FOREIGN_MODEL, MAX_ATLAS } from './caps.js';
export { buildAtlas, atlasNeeds, ATLAS_PADDING, type Atlas, type AtlasRegion } from './atlas.js';
export { safeFileName, curveCounts, motionFile, planFiles } from './files.js';
export {
  checkWriterRules,
  padPositionRuns,
  positionRunFailures,
  expectedGroupRanges,
  drawOrderKey,
  DRAW_ORDER_MAX,
  drawOrderReach,
  idProblem,
  truncateId,
  ID_MAX_BYTES,
  DECIMALS,
  KEY_LIMIT,
  EMPTY_GROUP_MIN,
  EMPTY_GROUP_MAX,
  type RuleViolation,
  type RuleKind,
} from './rules.js';
export {
  PreviewBuilder,
  previewVersion,
  type PreviewBuild,
  type PreviewTimings,
} from './preview.js';
export { dataPatches, applyDataPatches } from './patches.js';
export {
  DeformerMapper,
  invertMap,
  type ForwardMap,
  type InverseOptions,
  type InverseResult,
  type Pose,
} from './mapping.js';
export {
  DEFORMER_OPERATIONS,
  PLACE_TOLERANCE,
  cellOf,
  convertDeformer,
  convertMesh,
  deformerReparent,
  deformerRemove,
  keyformMoveInCanvas,
  meshReparent,
  type Conversion,
} from './reparent.js';
export { OPERATIONS } from './operations.js';
export * from './conformance.js';
export { clipboardCopy, clipboardPaste, fragmentWithAssets } from './clipboard.js';
export { physicsImport } from './physics-import.js';
export {
  MATCH_LIMIT,
  TEMPLATE_EXTENSION,
  TEMPLATE_FORMAT,
  applyTemplate,
  artRect,
  defaultLayout,
  exportTemplate,
  matchName,
  matchTemplate,
  readTemplate,
  retargetMotion,
  shapeCost,
  templateApply,
  templateZip,
  type Layout as TemplateLayout,
  type LoadedTemplate,
  type TemplateApplyArgs,
  type TemplateApplyResult,
  type TemplateMeta,
  type TemplateOptions,
  type TemplatePair,
} from './template.js';
export {
  importModel,
  importReportText,
  invertF32,
  MODEL_IMPORT_NOTICE,
  IMPORT_REPORT_FORMAT,
  type ImportModelOptions,
  type ImportReport,
  type ImportedModel,
} from './modelimport.js';
