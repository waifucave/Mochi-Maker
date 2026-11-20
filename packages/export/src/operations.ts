/** Every operation (image-based and deformer-mapping ones), for sessions that run them all. */
import { ART_OPERATIONS } from '@mochi-maker/art';
import type { OperationDef } from '@mochi-maker/core';
import { DEFORMER_OPERATIONS } from './reparent.js';
import { physicsImport } from './physics-import.js';
import { templateApply } from './template.js';
import { clipboardCopy, clipboardPaste } from './clipboard.js';

export const OPERATIONS: readonly OperationDef[] = [
  ...ART_OPERATIONS,
  ...DEFORMER_OPERATIONS,
  physicsImport as unknown as OperationDef,
  templateApply as unknown as OperationDef,
  clipboardCopy as unknown as OperationDef,
  clipboardPaste as unknown as OperationDef,
];
