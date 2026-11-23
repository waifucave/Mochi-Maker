#!/usr/bin/env node
/**
 * mochi-maker — the headless command-line tool (agent API design section 4).
 *
 * Exit codes: 0 success, 1 command or validation errors, 2 usage errors, 3 internal errors.
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as core from '@mochi-maker/core';
import {
  describeCommand,
  LIMITS,
  listCommands,
  loadProject,
  MochiError,
  parseJson,
  readCapped,
  saveProject,
  searchCommands,
  Session,
  type CommandCall,
  type Kind,
  VERSION,
} from '@mochi-maker/core';
import { NodeFileSystem } from '@mochi-maker/core/node';
import type { ReimportResult } from '@mochi-maker/art';
import {
  OPERATIONS,
  conformancePack,
  exportModel,
  exportTemplate,
  importReportText,
  packReadme,
  renderPack,
  reportText,
  templateZip,
  type ExportOptions,
  type ExportProblem,
  type TemplateApplyResult,
} from '@mochi-maker/export';
import { zipSync } from 'fflate';
import { MochiMcpServer, serveStdio } from '@mochi-maker/mcp';
import { BridgeServer, DEFAULT_PORT } from '@mochi-maker/bridge';
import {
  appendHistory,
  historyPath,
  readHistory,
  replayHistory,
  writeExport,
  REPORT_FILE,
  openPackRenderer,
  Project,
} from '@mochi-maker/api';

const fs = new NodeFileSystem();

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

const VALUE_OPTIONS = new Set([
  'port',
  'state',
  'allow-origin',
  'bridge-url',
  'token',
  'moc-version',
  'atlas',
  'stem',
  'target-version',
  'preview',
  'parent',
  'spacing',
  'margin',
  'tolerance',
  'format',
  'canvas',
  'ppu',
  'origin',
  'label',
  'author',
  'where',
  'fields',
  'limit',
  'offset',
  'search',
  'out',
  'base',
  'assets',
  'allow-dir',
  'scope',
  'versions',
  'seed',
  'random',
  'render-poses',
  'name',
  'description',
  'thumbnail',
  'targets',
  'draw-order',
  'parameters',
  'physics',
]);

export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { positional: [], options: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (VALUE_OPTIONS.has(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        p.options.set(name, [...(p.options.get(name) ?? []), v]);
      } else p.flags.add(name);
    } else p.positional.push(a);
  }
  return p;
}

const opt = (p: Parsed, name: string) => p.options.get(name)?.at(-1);

function out(p: Parsed, json: unknown, human: () => string): void {
  process.stdout.write(p.flags.has('json') ? JSON.stringify(json, null, 2) + '\n' : human() + '\n');
}

function need(p: Parsed, n: number, usage: string): string[] {
  if (p.positional.length < n) throw new UsageError(`usage: mochi-maker ${usage}`);
  return p.positional;
}

async function openProject(dir: string) {
  const { doc, assets } = await loadProject(fs, dir);
  return { session: Session.open(doc), assets };
}

async function cmdNew(p: Parsed): Promise<number> {
  const [, dir] = need(p, 2, 'new <dir> [--canvas WxH] [--ppu N] [--origin X,Y]');
  if (await fs.exists(resolve(dir!, core.MANIFEST)))
    throw new MochiError('E_PROJECT_FORMAT', `${dir} already contains a project.`);
  const [w, h] = (opt(p, 'canvas') ?? '2048x2048').split('x').map(Number);
  const [ox, oy] = (opt(p, 'origin') ?? '')
    .split(',')
    .map((v) => (v === '' ? undefined : Number(v)));
  if (!w || !h || !(w > 0) || !(h > 0))
    throw new UsageError('--canvas is WIDTHxHEIGHT, for example 2048x4096');
  const canvas = {
    width: w,
    height: h,
    pixelsPerUnit: opt(p, 'ppu') ? Number(opt(p, 'ppu')) : undefined,
    originX: ox,
    originY: oy,
  };
  const session = Session.create(canvas);
  await saveProject(fs, dir!, session.doc, new core.MemoryAssetStore());
  await fs.writeText(historyPath(dir!), JSON.stringify(session.log[0]) + '\n');
  out(
    p,
    { project: dir, canvas: session.view.project().canvas },
    () => `Created ${dir} (${w}×${h} canvas).`,
  );
  return 0;
}

async function loadCalls(file: string): Promise<CommandCall[]> {
  const text = new TextDecoder().decode(await readCapped(fs, file, LIMITS.projectBytes));
  if (file.endsWith('.jsonl'))
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l, i) => {
        try {
          return JSON.parse(l) as CommandCall;
        } catch {
          throw new UsageError(`${file}, line ${i + 1}: not valid JSON`);
        }
      });
  const json = parseJson(text);
  if (!Array.isArray(json))
    throw new UsageError(`${file} must hold a JSON array of {"name", "args"} objects`);
  return json as CommandCall[];
}

async function cmdRun(p: Parsed): Promise<number> {
  const [, dir, file] = need(
    p,
    3,
    'run <project> <commands.jsonl|commands.json|script.mjs> [--dry-run] [--label L]',
  );
  const { session, assets } = await openProject(dir!);
  const author = opt(p, 'author') ?? `script:${file}`;
  const label = opt(p, 'label') ?? file!;
  const dryRun = p.flags.has('dry-run');
  let results: unknown;
  if (/\.(mjs|js)$/.test(file!)) {
    if (dryRun) throw new UsageError('--dry-run works with command files, not scripts');
    const mod = (await import(pathToFileURL(resolve(file!)).href)) as { default?: unknown };
    if (typeof mod.default !== 'function')
      throw new UsageError(
        `${file} must default-export a function (session, { core, assets, fs, operations, author }) => ...`,
      );
    results = await (mod.default as (s: Session, ctx: unknown) => unknown)(session, {
      core,
      assets,
      author,
      fs,
      operations: OPERATIONS,
    });
  } else {
    const r = await core.runItems({ session, assets, fs }, label, await loadCalls(file!), {
      dryRun,
      author,
      operations: OPERATIONS,
    });
    await writePreviews(p, r.previews);
    const { previews, ...rest } = r;
    results = { ...rest, previews: previews.map((v) => v.description) };
  }
  if (!dryRun) {
    await saveProject(fs, dir!, session.doc, assets);
    await appendHistory(fs, historyPath(dir!), session.log);
  }
  out(p, results ?? null, () => describeResult(results, dryRun, session));
  return 0;
}

function describeResult(results: unknown, dryRun: boolean, session: Session): string {
  const r = results as (core.TransactionResult & { previews?: string[] }) | undefined;
  if (r && 'changes' in r)
    return (
      `${dryRun ? 'Dry run' : `Revision ${r.revision}`}: ${r.changes.length} object(s) changed.` +
      (r.previews && r.previews.length > 0
        ? `\n${r.previews.map((d) => `  preview: ${d}`).join('\n')}`
        : '') +
      (r.lint && r.lint.length > 0
        ? `\n${r.lint.map((l) => `  ${l.severity}: ${l.message}`).join('\n')}`
        : '')
    );
  return `Done: ${session.revision} transaction(s).`;
}

/** Writes preview images when --preview is given: a .png path for one, else a directory. */
async function writePreviews(p: Parsed, previews: core.Preview[]): Promise<void> {
  const target = opt(p, 'preview');
  if (!target || previews.length === 0) return;
  if (previews.length === 1 && target.toLowerCase().endsWith('.png')) {
    await fs.writeBytes(target, previews[0]!.data);
    return;
  }
  for (const [i, v] of previews.entries())
    await fs.writeBytes(core.joinPath(target, `preview-${i + 1}.png`), v.data);
}

async function cmdImport(p: Parsed): Promise<number> {
  const [, dir, path] = need(
    p,
    3,
    'import <project> <file.psd|file.ora|file.png|folder> [--no-meshes] [--include-hidden] [--parent ref] [--spacing N] [--margin N] [--tolerance N] [--preview out.png] [--dry-run]',
  );
  const { session, assets } = await openProject(dir!);
  const num = (name: string) => (opt(p, name) !== undefined ? Number(opt(p, name)) : undefined);
  const args: Record<string, unknown> = { path };
  if (p.flags.has('no-meshes')) args.meshes = false;
  if (p.flags.has('include-hidden')) args.includeHidden = true;
  if (opt(p, 'parent')) args.parent = opt(p, 'parent');
  if (opt(p, 'format')) args.format = opt(p, 'format');
  for (const k of ['spacing', 'margin', 'tolerance']) if (num(k) !== undefined) args[k] = num(k);
  const dryRun = p.flags.has('dry-run');
  const r = await core.runItems(
    { session, assets, fs },
    `Import ${path}`,
    [{ name: 'art.import', args }],
    {
      dryRun,
      author: opt(p, 'author') ?? 'person',
      operations: OPERATIONS,
    },
  );
  await writePreviews(p, r.previews);
  if (!dryRun) {
    await saveProject(fs, dir!, session.doc, assets);
    await appendHistory(fs, historyPath(dir!), session.log);
  }
  const res = r.itemResults[0] as {
    parts: string[];
    layers: string[];
    meshes: string[];
    notes: string[];
  };
  const { previews, ...rest } = r;
  out(p, { ...rest, previews: previews.map((v) => v.description) }, () =>
    [
      `${dryRun ? 'Dry run: would import' : 'Imported'} ${res.layers.length} layer(s), ${res.parts.length} part(s), ${res.meshes.length} mesh(es).`,
      ...res.notes.map((n) => `  note: ${n}`),
    ].join('\n'),
  );
  return 0;
}

/** A .physics3.json into the project (operation physics.import). */
async function cmdImportPhysics(p: Parsed): Promise<number> {
  const [, dir, path] = need(p, 3, 'import-physics <project> <file.physics3.json> [--dry-run]');
  const { session, assets } = await openProject(dir!);
  const dryRun = p.flags.has('dry-run');
  const r = await core.runItems(
    { session, assets, fs },
    `Import ${path}`,
    [{ name: 'physics.import', args: { path } }],
    { dryRun, author: opt(p, 'author') ?? 'person', operations: OPERATIONS },
  );
  if (!dryRun) {
    await saveProject(fs, dir!, session.doc, assets);
    await appendHistory(fs, historyPath(dir!), session.log);
  }
  const res = r.itemResults[0] as {
    added: string[];
    replaced: string[];
    unmatched: { setting: string; kind: string; parameter: string }[];
    fps: number;
  };
  out(p, res, () =>
    [
      `${dryRun ? 'Dry run: would add' : 'Added'} ${res.added.length} physics setting(s), ${dryRun ? 'replace' : 'replaced'} ${res.replaced.length}.`,
      ...res.unmatched.map(
        (u) => `  not bound: ${u.setting}'s ${u.kind} ${u.parameter} (no parameter with that ID)`,
      ),
    ].join('\n'),
  );
  return 0;
}

/** A .moc3 model folder as a new project (model import). */
async function cmdImportModel(p: Parsed): Promise<number> {
  const [, model, dir] = need(
    p,
    3,
    'import-model <model folder|file.model3.json|model.zip> <new project dir>',
  );
  const r = await Project.importModel(model!, dir!, {
    fs,
    author: opt(p, 'author') ?? 'person',
    features: core.featuresFromEnv(),
  });
  // The notice, on each import.
  for (const n of r.notices) process.stderr.write(n + '\n');
  out(p, { project: dir, report: r.report, notices: r.notices }, () =>
    [importReportText(r.report), `Saved the project in ${dir}.`].join('\n'),
  );
  return 0;
}

/** A project as a model template file. */
async function cmdExportTemplate(p: Parsed): Promise<number> {
  const usage =
    'export-template <project> --out <file.mochitemplate> [--name N] [--description D] [--author A] [--no-physics] [--thumbnail file.png]';
  const [, dir] = need(p, 2, usage);
  const target = opt(p, 'out');
  if (!target) throw new UsageError(`usage: mochi-maker ${usage}`);
  const { session, assets } = await openProject(dir!);
  const thumb = opt(p, 'thumbnail');
  const files = await exportTemplate(session.doc, assets, {
    name:
      opt(p, 'name') ??
      resolve(dir!)
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1)!
        .replace(/\.mochi$/, ''),
    description: opt(p, 'description') ?? '',
    author: opt(p, 'author') ?? '',
    physics: !p.flags.has('no-physics'),
    thumbnail: thumb ? await readCapped(fs, thumb, LIMITS.fileBytes) : null,
  });
  await fs.writeBytes(target, templateZip(files));
  const meta = JSON.parse(new TextDecoder().decode(files.get('template.json')!)) as {
    name: string;
    counts: Record<string, number>;
  };
  out(
    p,
    meta,
    () =>
      `Wrote ${target}: ${meta.name}, ${meta.counts.meshes} meshes, ${meta.counts.deformers} deformers, ${meta.counts.parameters} parameters.`,
  );
  return 0;
}

/** A model template applied to a project's art meshes (modelTemplate.apply). */
async function cmdApplyTemplate(p: Parsed): Promise<number> {
  const usage =
    'apply-template <project> <file.mochitemplate> [--targets ref,…] [--draw-order template|keep] [--redivide] [--no-masks] [--parameters merge|add] [--physics merge|add|none] [--dry-run]';
  const [, dir, path] = need(p, 3, usage);
  const { session, assets } = await openProject(dir!);
  const dryRun = p.flags.has('dry-run');
  const targets = opt(p, 'targets')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const r = await core.runItems(
    { session, assets, fs },
    `Apply template ${path}`,
    [
      {
        name: 'modelTemplate.apply',
        args: {
          path,
          ...(targets ? { targets } : {}),
          options: {
            drawOrder: (opt(p, 'draw-order') ?? 'template') as 'template' | 'keep',
            redivide: p.flags.has('redivide'),
            masksCullingBlend: !p.flags.has('no-masks'),
            parameters: (opt(p, 'parameters') ?? 'merge') as 'merge' | 'add',
            physics: (opt(p, 'physics') ?? 'merge') as 'merge' | 'add' | 'none',
          },
        },
      },
    ],
    { dryRun, author: opt(p, 'author') ?? 'person', operations: OPERATIONS },
  );
  if (!dryRun) {
    await saveProject(fs, dir!, session.doc, assets);
    await appendHistory(fs, historyPath(dir!), session.log);
  }
  const res = r.itemResults[0] as TemplateApplyResult;
  out(p, res, () =>
    [
      `${dryRun ? 'Dry run: would apply' : 'Applied'} ${res.template}: ${res.pairs.length} pair(s), ${res.deformers.length} deformer(s), parameters ${res.parameters.added.length} added and ${res.parameters.merged.length} merged, physics ${res.physics.added.length} added and ${res.physics.replaced.length} replaced.`,
      ...res.pairs.map((x) => `  ${x.target} ← ${x.template} (${x.by})`),
      ...res.unmatched.map((u) => `  unmatched: ${u}`),
      ...res.notes.map((n) => `  note: ${n}`),
    ].join('\n'),
  );
  return 0;
}

function parseWhere(list: string[] | undefined): Record<string, unknown> | undefined {
  if (!list) return undefined;
  const where: Record<string, unknown> = {};
  for (const w of list) {
    const i = w.indexOf('=');
    if (i < 0) throw new UsageError(`--where takes field=value, got "${w}"`);
    const raw = w.slice(i + 1);
    let v: unknown = raw;
    try {
      v = JSON.parse(raw);
    } catch {
      /* a plain string */
    }
    where[w.slice(0, i)] = v;
  }
  return where;
}

async function cmdQuery(p: Parsed): Promise<number> {
  const [, dir, kind] = need(
    p,
    2,
    'query <project> [kind] [--where field=value] [--fields a,b] [--limit N] [--offset N]',
  );
  const { session } = await openProject(dir!);
  const r = session.query({
    kind: kind as Kind | undefined,
    where: parseWhere(p.options.get('where')),
    fields: opt(p, 'fields')?.split(','),
    limit: opt(p, 'limit') ? Number(opt(p, 'limit')) : undefined,
    offset: opt(p, 'offset') ? Number(opt(p, 'offset')) : undefined,
  });
  out(p, r, () =>
    [
      `${r.total} object(s)`,
      ...r.items.map(
        (o) =>
          `  ${o.uid}  ${o.kind}${o.exportId ? `  ${o.exportId}` : ''}${o.name && o.name !== o.exportId ? `  "${o.name}"` : ''}`,
      ),
    ].join('\n'),
  );
  return 0;
}

async function cmdGet(p: Parsed): Promise<number> {
  const [, dir, ref] = need(p, 3, 'get <project> <ref>');
  const { session } = await openProject(dir!);
  const o = session.get(ref!);
  process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  return 0;
}

function exportOptions(p: Parsed, versionOption: string): ExportOptions {
  const o: ExportOptions = {};
  const v = opt(p, versionOption);
  if (v !== undefined) {
    if (!['auto', '3', '4', '5', '6'].includes(v))
      throw new UsageError(`--${versionOption} is auto, 3, 4, 5 or 6`);
    o.mocVersion = v === 'auto' ? 'auto' : (Number(v) as 3 | 4 | 5 | 6);
  }
  const atlas = opt(p, 'atlas');
  if (atlas !== undefined) {
    if (!['1024', '2048', '4096', '8192'].includes(atlas))
      throw new UsageError('--atlas is 1024, 2048, 4096 or 8192');
    o.atlasSize = Number(atlas) as 1024 | 2048 | 4096 | 8192;
  }
  if (opt(p, 'stem')) o.fileStem = opt(p, 'stem')!;
  return o;
}

function problemLines(problems: ExportProblem[]): string[] {
  return problems.map((x) => `${x.severity}: ${x.message} [${x.source}: ${x.code}]`);
}

async function cmdValidate(p: Parsed): Promise<number> {
  const [, dir] = need(p, 2, 'validate <project> [--export] [--target-version auto|3|4|5]');
  const { session, assets } = await openProject(dir!);
  const r = session.validate();
  let errors = r.violations.length + r.lint.filter((l) => l.severity === 'error').length;
  let exportCheck: { ok: boolean; mocVersion?: number; problems: ExportProblem[] } | undefined;
  if (p.flags.has('export') || opt(p, 'target-version') !== undefined) {
    try {
      const e = await exportModel(session.doc, assets, exportOptions(p, 'target-version'));
      exportCheck = {
        ok: true,
        mocVersion: e.report.mocVersion,
        problems: e.report.problems.filter((x) => x.source !== 'lint'),
      };
    } catch (e) {
      if (!(e instanceof MochiError)) throw e;
      const problems = (e.details?.problems as ExportProblem[] | undefined) ?? [
        { severity: 'error', source: 'load-check', code: e.code, message: e.message },
      ];
      exportCheck = { ok: false, problems: problems.filter((x) => x.source !== 'lint') };
      errors += 1;
    }
  }
  out(p, { ...r, export: exportCheck }, () =>
    [
      ...r.violations.map((v) => `invariant: ${v.uid} ${v.path}: ${v.message}`),
      ...r.lint.map((l) => `${l.severity}: ${l.message} [${l.rule}]`),
      ...(exportCheck ? problemLines(exportCheck.problems) : []),
      `${r.violations.length} invariant violation(s), ${r.lint.length} lint result(s).` +
        (exportCheck
          ? exportCheck.ok
            ? ` Export check passed (version ${exportCheck.mocVersion}).`
            : ' Export check failed.'
          : ''),
    ].join('\n'),
  );
  return errors > 0 ? 1 : 0;
}

/** Re-imports changed art (operation art.reimport) and prints what changed and what to re-fit. */
async function cmdReimport(p: Parsed): Promise<number> {
  const [, dir, path] = need(
    p,
    3,
    'reimport <project> <file.psd|file.ora|file.png|folder> [--no-add] [--preview out.png] [--dry-run]',
  );
  const { session, assets } = await openProject(dir!);
  const args: Record<string, unknown> = { path };
  if (p.flags.has('no-add')) args.addNew = false;
  if (opt(p, 'format')) args.format = opt(p, 'format');
  const dryRun = p.flags.has('dry-run');
  const r = await core.runItems(
    { session, assets, fs },
    `Re-import ${path}`,
    [{ name: 'art.reimport', args }],
    { dryRun, author: opt(p, 'author') ?? 'person', operations: OPERATIONS },
  );
  await writePreviews(p, r.previews);
  if (!dryRun) {
    await saveProject(fs, dir!, session.doc, assets);
    await appendHistory(fs, historyPath(dir!), session.log);
  }
  const res = r.itemResults[0] as ReimportResult;
  const { previews, ...rest } = r;
  const name = (uid: string) => session.view.describe(uid);
  out(p, { ...rest, previews: previews.map((v) => v.description) }, () =>
    [
      `${dryRun ? 'Dry run: would re-import' : 'Re-imported'} ${path}: ${res.changed.length} changed, ${res.unchanged} unchanged, ${res.added.length} added, ${res.removed.length} removed.`,
      ...res.changed.map(
        (c) =>
          `  changed: ${c.name}${c.boundsChanged ? ' (bounds changed)' : ''}${c.movedFrom ? ` (was ${c.movedFrom})` : ''}`,
      ),
      ...res.refit.map(
        (x) =>
          `  re-fit: ${name(x.mesh)}: ${x.reasons.join(', ')} (art outside ${(x.uncovered * 100).toFixed(1)} %, over empty ${(x.overEmpty * 100).toFixed(1)} %)`,
      ),
      ...res.added.map((a) => `  added: ${a.path} (not meshed; mesh.generate makes one)`),
      ...res.removed.map(
        (x) =>
          `  removed: ${x.name} (kept, with ${x.meshes.length} mesh(es); flagged in its notes)`,
      ),
      ...res.notes.map((n) => `  note: ${n}`),
    ].join('\n'),
  );
  return 0;
}

async function cmdExport(p: Parsed): Promise<number> {
  const [, dir] = need(
    p,
    2,
    'export <project> --out <dir|file.zip> [--moc-version auto|3|4|5|6] [--atlas N] [--stem S] [--force]',
  );
  const target = opt(p, 'out');
  if (!target) throw new UsageError('export needs --out <dir> or --out <file.zip>');
  const { session, assets } = await openProject(dir!);
  const r = await exportModel(session.doc, assets, exportOptions(p, 'moc-version'));
  try {
    await writeExport(fs, target, r, { force: p.flags.has('force') });
  } catch (e) {
    if (e instanceof MochiError && e.code === 'E_FORBIDDEN') throw new UsageError(e.message);
    throw e;
  }
  const warnings = r.report.problems.filter((x) => x.severity === 'warning');
  out(p, r.report, () =>
    [
      `Exported version ${r.report.mocVersion} (${r.report.versionReason}) to ${target}: ${r.report.files.length} file(s), ${r.report.counts.artMeshes} mesh(es), ${r.report.atlas.pages.length} texture page(s).`,
      ...problemLines(warnings).map((l) => `  ${l}`),
    ].join('\n'),
  );
  return 0;
}

/** design 7.5: the exports, scenarios and Mochi2D's results of projects, at versions 3 to 6. */
async function cmdConformancePack(p: Parsed): Promise<number> {
  const usage =
    'conformance-pack <project…> --out <dir> [--versions 3,4,5,6] [--seed N] [--random N] [--render-poses N] [--no-renders] [--force]';
  const dirs = need(p, 2, usage).slice(1);
  const target = opt(p, 'out');
  if (!target) throw new UsageError(`usage: mochi-maker ${usage}`);
  const versions = (opt(p, 'versions') ?? '3,4,5,6').split(',').map((v) => Number(v.trim()));
  if (!versions.length || versions.some((v) => ![3, 4, 5, 6].includes(v)))
    throw new UsageError('--versions is a list of 3, 4, 5 and 6');
  const int = (name: string, fallback: number) => {
    const v = opt(p, name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v)) throw new UsageError(`--${name} is a whole number`);
    return Number(v);
  };
  if ((await fs.exists(target)) && (await fs.list(target)).length > 0 && !p.flags.has('force'))
    throw new UsageError(`${target} is not empty; use an empty folder, or --force.`);
  const projects = [];
  const names = new Set<string>();
  for (const dir of dirs) {
    const { doc, assets } = await loadProject(fs, dir);
    const base = resolve(dir).split(/[\\/]/).filter(Boolean).at(-1)!;
    let name = base.replace(/\.mochi$/, '');
    for (let n = 2; names.has(name); n++) name = `${base.replace(/\.mochi$/, '')}-${n}`;
    names.add(name);
    projects.push({ name, doc, assets });
  }
  const pack = await conformancePack(projects, {
    versions: versions as (3 | 4 | 5 | 6)[],
    seed: int('seed', 1),
    randomPoses: int('random', 8),
    renderPoses: int('render-poses', 3),
    producer: `mochi-maker ${VERSION}`,
  });
  // Renders need headless Chromium; without it the pack keeps its render scenarios only.
  let renderNote = '';
  if (!p.flags.has('no-renders')) {
    try {
      const renderer = await openPackRenderer();
      try {
        await renderPack(pack, renderer);
      } finally {
        await renderer.close();
      }
    } catch (e) {
      renderNote = `  no renders: ${(e as Error).message.split('\n')[0]}`;
    }
  }
  for (const [path, bytes] of pack.files) await fs.writeBytes(join(target, path), bytes);
  await fs.writeText(join(target, 'manifest.json'), JSON.stringify(pack.manifest, null, 2) + '\n');
  await fs.writeText(join(target, 'README.md'), packReadme(pack.manifest));
  const m = pack.manifest;
  const errors = m.entries.flatMap((e) => e.errors);
  const scenarios = m.entries.reduce((s, e) => s + e.scenarios.length, 0);
  out(p, m, () =>
    [
      `Wrote ${target}: ${m.entries.filter((e) => e.status === 'exported').length} export(s), ${scenarios} scenario(s), ${m.entries.reduce((s, e) => s + [e.render, ...(e.renders ?? [])].filter((r) => r?.png).length, 0)} render(s), ${m.files.length + 2} file(s).`,
      ...(renderNote ? [renderNote] : []),
      ...m.entries
        .filter((e) => e.status === 'skipped')
        .map((e) => `  skipped ${e.project} v${e.version}: ${e.reason?.split('. ')[0]}.`),
      ...Object.entries(m.coverage)
        .filter(([, l]) => l.length === 0)
        .map(([path]) => `  not covered: ${path}`),
      ...errors.map((x) => `  Mochi2D error: ${x}`),
    ].join('\n'),
  );
  return errors.length ? 1 : 0;
}

async function cmdHistory(p: Parsed): Promise<number> {
  const [, dir] = need(p, 2, 'history <project>');
  const entries = await readHistory(fs, historyPath(dir!));
  out(
    p,
    entries,
    () =>
      entries
        .map((e) =>
          e.op === 'tx'
            ? `  tx    ${e.author}  ${e.label}  (${e.commands.length} command(s))`
            : e.op === 'init' || e.op === 'base'
              ? `${e.op}`
              : `  ${e.op}`,
        )
        .join('\n') || 'No history.',
  );
  return 0;
}

async function cmdReplay(p: Parsed): Promise<number> {
  const [, file] = need(
    p,
    2,
    'replay <history.jsonl> --out <dir> [--base <project>] [--assets <project>]',
  );
  const target = opt(p, 'out');
  if (!target) throw new UsageError('replay needs --out <dir>');
  const base = opt(p, 'base') ? (await loadProject(fs, opt(p, 'base')!)).doc : undefined;
  const doc = replayHistory(await readHistory(fs, file!), base);
  const assetDir = opt(p, 'assets') ?? opt(p, 'base') ?? resolve(file!, '..', '..');
  const assets = new core.FolderAssetStore(fs, core.joinPath(assetDir, 'assets'));
  await saveProject(fs, target, doc, assets);
  out(p, { out: target, hash: core.documentHash(doc) }, () => `Replayed into ${target}.`);
  return 0;
}

/**
 * The MCP server over stdio (agent API design 3). The agent may read and write only inside the
 * project folder and the --allow-dir directories (default: the current directory).
 */
function mcpScope(v: string | undefined): 'read' | 'edit' | 'export' {
  if (v === undefined) return 'export';
  if (v !== 'read' && v !== 'edit' && v !== 'export')
    throw new UsageError('--scope is read, edit or export');
  return v;
}

async function cmdMcp(p: Parsed): Promise<number> {
  if (p.flags.has('bridge')) {
    // Bridge mode: the editor holds the document; the token comes from its Agent access.
    const token = opt(p, 'token') ?? process.env.MOCHI_MAKER_TOKEN;
    if (!token)
      throw new UsageError(
        'mcp --bridge needs a token: create one in the editor (Agent access) and pass --token, or set MOCHI_MAKER_TOKEN',
      );
    const allow = p.options.get('allow-dir') ?? [];
    const author = opt(p, 'author') ?? 'agent:mcp';
    const server = new MochiMcpServer({
      allowDirs: (allow.length > 0 ? allow : [process.cwd()]).map((d) => resolve(d)),
      author,
      scope: mcpScope(opt(p, 'scope')),
      bridge: { url: opt(p, 'bridge-url'), token, name: author.replace(/^agent:/, '') },
    });
    await server.start();
    await serveStdio(server);
    return 0;
  }
  const project = p.positional[1];
  const allow = p.options.get('allow-dir') ?? [];
  const allowDirs = [
    ...(allow.length > 0 ? allow : [process.cwd()]),
    ...(project ? [project] : []),
  ];
  const server = new MochiMcpServer({
    allowDirs: allowDirs.map((d) => resolve(d)),
    project: project ? resolve(project) : undefined,
    author: opt(p, 'author') ?? 'agent:mcp',
    scope: mcpScope(opt(p, 'scope')),
  });
  await server.start();
  await serveStdio(server);
  return 0;
}

/** Where the bridge keeps its token hashes, unless --state says otherwise. */
function defaultStateFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'mochi-maker', 'bridge.json');
}

/**
 * The live bridge (agent API design 5): listens on 127.0.0.1 for the editor (host) and agents
 * (clients) until stopped. Prints the pairing code the person enters in the editor.
 */
async function cmdBridge(p: Parsed): Promise<number> {
  const port = opt(p, 'port') !== undefined ? Number(opt(p, 'port')) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UsageError('--port is 0–65535');
  const log = (line: string) => process.stderr.write(`${line}\n`);
  let listening = false;
  const bridge = new BridgeServer({
    port,
    stateFile: p.flags.has('no-state') ? undefined : resolve(opt(p, 'state') ?? defaultStateFile()),
    allowOrigins: p.options.get('allow-origin') ?? [],
    // New codes after the first (used, expired or too many wrong tries).
    onPairingCode: (code) =>
      listening && log(`Pairing code: ${code} (enter it in the editor: Agent access)`),
    onLog: (line) => log(line),
  });
  const actual = await bridge.listen();
  listening = true;
  log(`Mochi Maker bridge on ws://127.0.0.1:${actual} (protocol 1). Stop with Ctrl+C.`);
  log(`Pairing code: ${bridge.pairingCode} (enter it in the editor: Agent access)`);
  await new Promise<void>((done) => {
    const stop = () => void bridge.close().then(done);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function cmdDescribe(p: Parsed): Promise<number> {
  const name = p.positional[1];
  const search = opt(p, 'search');
  if (name) {
    const d = describeCommand(name, OPERATIONS);
    out(p, d, () =>
      [
        `${d.name} (${d.kind}) — ${d.summary}`,
        '',
        d.doc,
        '',
        'Arguments (JSON Schema):',
        JSON.stringify(d.args, null, 2),
        '',
        `Errors: ${d.errors.map((e) => e.code).join(', ') || 'none'}`,
        ...d.examples.map(
          (e) => `Example — ${e.description}:\n  ${JSON.stringify({ name: d.name, args: e.args })}`,
        ),
      ].join('\n'),
    );
  } else {
    const list = search ? searchCommands(search, OPERATIONS) : listCommands(OPERATIONS);
    out(p, list, () =>
      list
        .map((c) => `${c.name.padEnd(28)} ${c.kind === 'operation' ? '[op] ' : ''}${c.summary}`)
        .join('\n'),
    );
  }
  return 0;
}

const HELP = `mochi-maker ${VERSION} — Mochi Maker's command-line tool

Usage:
  mochi-maker new <dir> [--canvas WxH] [--ppu N] [--origin X,Y]
  mochi-maker run <project> <commands.jsonl|commands.json|script.mjs> [--dry-run] [--label L] [--author A] [--preview dir]
  mochi-maker import <project> <file.psd|file.ora|file.png|folder> [--no-meshes] [--include-hidden]
        [--parent ref] [--spacing N] [--margin N] [--tolerance N] [--preview out.png] [--dry-run]
  mochi-maker import-physics <project> <file.physics3.json> [--dry-run]
  mochi-maker import-model <model folder|file.model3.json|model.zip> <new project dir>   (open a .moc3 model as a project)
  mochi-maker export-template <project> --out <file.mochitemplate> [--name N] [--description D] [--author A] [--no-physics]
  mochi-maker apply-template <project> <file.mochitemplate> [--targets ref,…] [--parameters merge|add] [--physics merge|add|none] [--dry-run]
  mochi-maker reimport <project> <file.psd|file.ora|file.png|folder> [--no-add] [--preview out.png] [--dry-run]
  mochi-maker query <project> [kind] [--where field=value] [--fields a,b] [--limit N] [--offset N]
  mochi-maker get <project> <ref>
  mochi-maker validate <project> [--export] [--target-version auto|3|4|5]
  mochi-maker export <project> --out <dir|file.zip> [--moc-version auto|3|4|5|6] [--atlas N] [--stem S] [--force]
  mochi-maker history <project>
  mochi-maker conformance-pack <project…> --out <dir> [--versions 3,4,5,6] [--seed N] [--random N] [--render-poses N] [--no-renders] [--force]
  mochi-maker replay <history.jsonl> --out <dir> [--base <project>] [--assets <project>]
  mochi-maker describe [command] [--search words]
  mochi-maker mcp [project] [--allow-dir dir]... [--scope read|edit|export] [--author agent:name]   (MCP server on stdio)
  mochi-maker mcp --bridge --token mmt_… [--bridge-url ws://127.0.0.1:47831] [--allow-dir dir]...   (MCP on the open editor)
  mochi-maker bridge [--port 47831] [--state file | --no-state] [--allow-origin url]...   (the live bridge)

Every command takes --json for machine-readable output.
Exit codes: 0 success, 1 command or validation errors, 2 usage errors, 3 internal errors.`;

const COMMAND_TABLE: Record<string, (p: Parsed) => Promise<number>> = {
  new: cmdNew,
  run: cmdRun,
  import: cmdImport,
  reimport: cmdReimport,
  'import-physics': cmdImportPhysics,
  'import-model': cmdImportModel,
  'export-template': cmdExportTemplate,
  'apply-template': cmdApplyTemplate,
  export: cmdExport,
  query: cmdQuery,
  get: cmdGet,
  validate: cmdValidate,
  history: cmdHistory,
  replay: cmdReplay,
  'conformance-pack': cmdConformancePack,
  describe: cmdDescribe,
  mcp: cmdMcp,
  bridge: cmdBridge,
};

export async function main(argv: string[]): Promise<number> {
  let p: Parsed | undefined;
  try {
    p = parseArgs(argv);
    const cmd = p.positional[0];
    if (cmd === 'version' || p.flags.has('version')) {
      process.stdout.write(VERSION + '\n');
      return 0;
    }
    if (!cmd || p.flags.has('help') || cmd === 'help') {
      process.stdout.write(HELP + '\n');
      return cmd || p.flags.has('help') ? 0 : 2;
    }
    const fn = COMMAND_TABLE[cmd];
    if (!fn) throw new UsageError(`unknown command "${cmd}". Run mochi-maker --help.`);
    return await fn(p);
  } catch (e) {
    const json = p?.flags.has('json');
    if (e instanceof UsageError) {
      process.stderr.write(
        json
          ? JSON.stringify({ error: { code: 'E_USAGE', message: e.message } }) + '\n'
          : `mochi-maker: ${e.message}\n`,
      );
      return 2;
    }
    if (e instanceof MochiError && e.code !== 'E_INTERNAL') {
      if (json) process.stderr.write(JSON.stringify({ error: e.toJSON() }, null, 2) + '\n');
      else {
        const where = e.command !== undefined ? ` (command ${e.at}: ${e.command})` : '';
        process.stderr.write(`mochi-maker: ${e.code}${where}: ${e.message}\n`);
        for (const f of e.fixes)
          process.stderr.write(
            `  fix: ${f.description}${'command' in f ? ` → ${JSON.stringify({ name: f.command, args: f.args })}` : ''}\n`,
          );
      }
      return 1;
    }
    process.stderr.write(
      `mochi-maker: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    return 3;
  }
}

function invokedDirectly(): boolean {
  try {
    return (
      !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) main(process.argv.slice(2)).then((code) => process.exit(code));
