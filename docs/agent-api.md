# Agent API — reference (M5)

Design: [`agent-api-design.md`](agent-api-design.md). Everything except `explain`, which needs
Mochi2D's evaluation introspection (Mochi2D 0.6.0). Rendering came with Mochi2D 0.4.0.

## TypeScript API (`@mochi-maker/api`)

```ts
import { Project } from '@mochi-maker/api';

const p = await Project.open('Hana.mochi', { author: 'agent:my-agent' });
const r = p.transact('Rig the eye', (tx) => {
  const open = tx.param.create({ exportId: 'ParamEyeLOpen', min: 0, max: 1, default: 1, keys: [0, 1] });
  tx.rig.addBinding({ target: '@mesh:EyeL', parameter: open.uid });
  return open.uid;
});
r.value; // the body's return value: 'param_0042'
const e = await p.evaluate({ parameters: { ParamEyeLOpen: 0 } });
await p.save();
```

| Member | What it does |
|---|---|
| `Project.open(dir)`, `Project.create(dir, canvas)`, `Project.memory(canvas)`, `Project.fromSession(session, assets)` | open or make a project |
| `Project.importModel(model, dir, { date?, features? })` | a `.moc3` model folder (or its `.model3.json`) as a new project in `dir`, saved; returns `{ project, report, notices }` ([`import.md`](import.md)) |
| `transact(label, (tx) => …, { dryRun, expectRevision, author })` | one atomic transaction. `tx.<area>.<verb>(args)` is one typed method per command, with its docs as TSDoc; `tx.run(name, args)` takes the name as a string. |
| `run(label, [{ name, args }], options)` | commands and operations (`art.import`, `mesh.generate`, `mesh.reparent`, `keyform.moveInCanvas`, …) given as data |
| `describe()`, `describe(name)`, `describe({ search })`, `schema(kind)`, `errorCodes()` | self-description |
| `commandInfo()` | every command and operation in Mochi Studio's bridge shape: `{ name, summary, details, scope, undoable, readOnly, inputSchema }` |
| `query(q)`, `get(ref)`, `validate()`, `history()`, `undo()`, `redo()` | reading and history |
| `diff(from, to?)` | structural diff between revisions the project has been at: objects added, removed and changed, the changed fields, and mesh and warp point displacement (max and RMS) |
| `evaluate({ parameters, vertices })` | Mochi2D's evaluation of the exported model: per drawable visibility, opacity, draw and render order, colors and bounds, in canvas pixels |
| `render({ parameters, width, height, around, margin, view, reference, revision })` | a PNG of a pose from Mochi2D's renderer (headless Chromium): a fast preview by default, the reference render with `reference: true`; `around` frames one mesh; `revision` renders an earlier revision |
| `sweep(parameter, { values or steps, as: 'sheet' or 'frames', columns, … })` | the parameter at several values, as one contact sheet or separate frames, with one view for all |
| `visualDiff(from, to, options)` | before and after renders at the same pose and view, a difference image (changed pixels red) and metrics: RMS, changed fraction, largest channel difference |
| `close()` | closes the renderer |
| `importArt(path, args)`, `reimportArt(path, args, { dryRun })`, `exportResult(options)`, `export(out, options)`, `save()` | files; `reimportArt` runs `art.reimport` and reports what changed and what to re-fit |

The method layer (`packages/api/src/generated.ts`) is generated from the command registry. A test
fails when it is out of date; `UPDATE_GENERATED=1 npx vitest run packages/api/test/generated.test.ts`
rewrites it.

In the editor, the same surface is `window.mochi`, bound to the open session. See
[`editor.md`](editor.md#windowmochi-agents-in-the-editor). Browser code can import the parts that
run without Node from `@mochi-maker/api/browser`: the method layer, diffs and error output.

## MCP server (`@mochi-maker/mcp`)

```sh
mochi-maker mcp [project] [--allow-dir dir]... [--scope read|edit|export] [--author agent:name]
mochi-maker mcp --bridge --token mmt_… [--bridge-url ws://127.0.0.1:47831] [--allow-dir dir]...
```

With `--bridge`, the tools work on the document open in a running editor, through the live bridge
([`bridge.md`](bridge.md)). In that mode:

- the editor runs every command, and its history records the agent as author;
- `mochi_render` without arguments shows what the person sees;
- files are read and written only on the agent's side, inside `--allow-dir`.

Newline-delimited JSON-RPC 2.0 on stdio, MCP protocol versions 2025-06-18, 2025-03-26 and
2024-11-05. Requests are handled one at a time, in order.

| Tool | Purpose |
|---|---|
| `mochi_project` | `new`, `open`, `importModel` (`model`: a `.moc3` model folder or its `.model3.json`; `path`: the new project; the result adds `report` and `notices`), `save`, `close`, `status` |
| `mochi_describe` | commands, operations, object schemas, error codes |
| `mochi_query` | objects by kind, filter, fields and paging; one object by `ref` |
| `mochi_run` | a transaction: `{ label, commands, dryRun?, expectRevision?, preview? }` → results, revision, changes, a structural diff, and with `preview` a render of the result |
| `mochi_undo`, `mochi_redo` | n steps, with the diff |
| `mochi_history` | the transactions, with authors |
| `mochi_diff` | structural diff between revisions; `visual: true` adds before, after and difference images with metrics |
| `mochi_render` | a PNG of a pose, as MCP image content (at most 1024 px a side) |
| `mochi_sweep` | a parameter at up to 16 values: a contact sheet or frames |
| `mochi_evaluate` | numbers at a pose |
| `mochi_validate` | invariants, lint and, with `targetVersion`, the export check |
| `mochi_import_art` | PSD, ORA, PNG or a folder, from an allowed directory |
| `mochi_reimport_art` | the same art after it changed: new pixels for matched layers, meshes kept in place, new and removed layers, and the meshes that may need re-fitting; `dryRun` only reports |
| `mochi_export` | a model folder or zip, in an allowed directory |
| `mochi_export_movie` | a motion as PNG frames, a WebM (alpha when transparent) or an MP4, into a folder in an allowed directory; rendered by the editor, so `--bridge` mode only |

**Resources:**

- `mochi://project`, `mochi://history`;
- `mochi://document/{kind}`, `mochi://document/{kind}/{uid}`;
- `mochi://schema/document`, `mochi://schema/commands`;
- `mochi://docs/{topic}` (getting-started, spaces, blend-shapes, export-versions, errors);
- `mochi://docs/commands/{name}`;
- `mochi://standard/parameters` and `mochi://standard/parameter-groups`: the standard
  parameter IDs with their ranges, sections, meanings and Eye blink / Lip sync groups, and the
  standard group IDs. `param.create` with those values keeps a model recognizable to apps.

Subscribed resources get `notifications/resources/updated` whenever the document changes.

**Prompts:** `rig_blink`, `head_angle_x`, `review_rig`, `make_motion`, `export_model`. They are step lists over
the tools, with no hidden automation.

**Safety** (design 6):

- **Files:** the agent can only run commands. It can read and write files only inside the project
  folder and the `--allow-dir` directories (default: the current directory), checked after
  following symbolic links.
- **Limits:** at most 10 000 commands per transaction and 30 tool calls per second.

**Scopes** (design 6, item 3). Each tool carries its scope in `_meta["mochi-maker/scope"]`:

- `read`: describe, query, history, diff, render, sweep, evaluate, validate, and opening, closing and checking
  the status of a project;
- `edit`: run, undo, redo, import art, and creating and saving a project;
- `export`: export.

`--scope` sets what the session allows (default `export`, everything). A call beyond it fails
with category `forbidden`.

**Errors.** A failed tool call has `isError: true` and `{ error: { category, code, message,
command?, at?, path?, details?, fixes?, docs? } }`.

- `category` is from Mochi Studio's bridge protocol (version 1): `invalid_arguments`,
  `unknown_command`, `forbidden`, `no_project` (the bridge's `no_model`), `rate_limited`, `failed`.
- `code` is Mochi Maker's stable code, such as `E_KEY_NOT_ON_PARAMETER`.
- `fixes` are machine-applicable: a command to run first, or a replacement value.

Tool names are snake_case, like the bridge's commands.
