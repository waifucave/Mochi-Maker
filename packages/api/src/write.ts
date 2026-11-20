/** Writing an export to disk: a folder or a deterministic zip (design 4.3, step 6). */
import { MochiError, joinPath, parseJson, type FileSystem } from '@mochi-maker/core';
import { reportText, type ExportResult } from '@mochi-maker/export';
import { zipSync } from 'fflate';

export const REPORT_FILE = 'mochi-export.json';

/**
 * Writes an export to `target`: a `.zip` file (fixed timestamps, so the archive is byte-identical
 * for the same export), or a folder. A folder must be empty or hold a previous export, whose files
 * the new export no longer has are removed; `force` writes into any folder.
 */
export async function writeExport(
  fs: FileSystem,
  target: string,
  r: ExportResult,
  options: { force?: boolean } = {},
): Promise<void> {
  const report = new TextEncoder().encode(reportText(r.report));
  if (target.toLowerCase().endsWith('.zip')) {
    const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
    const mtime = new Date('1980-01-01T00:00:00Z');
    for (const [path, bytes] of r.files) entries[path] = [bytes, { mtime }];
    entries[REPORT_FILE] = [report, { mtime }];
    await fs.writeBytes(target, zipSync(entries, { level: 6 }));
    return;
  }
  const reportPath = joinPath(target, REPORT_FILE);
  let previous: string[] = [];
  if (await fs.exists(reportPath)) {
    const old = parseJson(await fs.readText(reportPath)) as { files?: { path: string }[] };
    previous = (old.files ?? []).map((f) => f.path);
  } else if ((await fs.list(target)).length > 0 && !options.force)
    throw new MochiError(
      'E_FORBIDDEN',
      `${target} is not empty and holds no previous export; use an empty folder, or force.`,
    );
  for (const old of previous) if (!r.files.has(old)) await fs.remove(joinPath(target, old));
  for (const [path, bytes] of r.files) await fs.writeBytes(joinPath(target, path), bytes);
  await fs.writeBytes(reportPath, report);
}
