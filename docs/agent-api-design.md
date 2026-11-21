# Mochi Maker — Agent interface design

Status: the original design. The built interface is described in agent-api.md.

AI agents must be able to do everything a person can do in Mochi Maker. The
baseline is Blender's Python API: full access to the data and the operators.
Mochi Maker aims higher in five ways:

1. **Typed and self-describing.** Every operation has a JSON Schema and docs
   that can be queried at run time.
2. **Visual feedback by default.** Agents can see what they did.
3. **Explainable.** Tools answer *why* something looks the way it does.
4. **Safe to try.** Transactions, dry runs and undo.
5. **Deterministic.** The same calls give the same document, IDs and images.

All four surfaces share one implementation, the command layer of
[`design.md`](design.md) section 4.2:

```
             ┌──────────── command registry (schemas, docs, apply) ─────────────┐
             │                   @mochi-maker/core                               │
             └──────────────────────────────────────────────────────────────────┘
                 ▲                ▲                  ▲                 ▲
   TypeScript API (§2)     MCP server (§3)     CLI (§4)        live bridge (§5)
   @mochi-maker/api        @mochi-maker/mcp    mochi-maker     editor ⇄ agent
```

---

## 1. Concepts every surface shares

| Concept | Meaning |
|---|---|
| **Session** | One open project: headless in-process, or a running editor reached through the bridge. |
| **Ref** | How a caller names an object: a UID (`mesh_0042`), `@kind:ExportId` (`@param:ParamAngleX`) or `@kind~"Display name"`. Results always use UIDs. |
| **Command** | A named, schema-checked operation (`mesh.generate`, `rig.addBinding`, …). The single way to change a document. |
| **Transaction** | A labeled batch of commands, atomic, one undo step. It can be a dry run. |
| **Revision** | An integer that increases with every commit. Writes may state the revision they expect (optimistic concurrency). |
| **Pose** | `{ parameters?: {ref: value}, parts?: {ref: opacity}, motion?: {ref, time}, expressions?: [ref], physics?: 'off' \| 'settled' }`. Unlisted values take their defaults. |
| **View** | Render settings: size, framing (`canvas`, `fit-drawables`, or a box in canvas pixels), background, overlays. |
| **Error** | A structured error with a code, the failing path, an explanation and suggested fixes (§2.4). |

### 1.1 Command catalog (first release, abridged)

Names are `area.verb`. Each area has `list`/`get` queries as well. The full
catalog is generated from the registry and published as a resource.

| Area | Commands |
|---|---|
| `project` | `new`, `open`, `save`, `setCanvas`, `setExportSettings` |
| `art` | `importPsd`, `importOra`, `importPngs`, `reimport`, `setLayerVisibility` |
| `part` | `create`, `delete`, `move` (reparent and reorder), `rename`, `setSortingScope`, `setInitialOpacity`, `setEnabled` |
| `mesh` | `generate` (from a layer), `create` (explicit), `addVertices`, `deleteVertices`, `moveVertices`, `retriangulate`, `flipEdge`, `setClip`, `setDoubleSided`, `setLegacyBlend`, `delete` |
| `deformer` | `createWarp`, `createRotation`, `wrapInWarp`, `wrapInRotation`, `reparent`, `setGrid`, `setCellMode`, `delete` |
| `param` | `create`, `update`, `setKeys`, `reorder`, `delete`, `group.create`, `group.assign` |
| `rig` | `addBinding`, `removeBinding`, `addKey`, `removeKey`, `fillMissing`, `copyKeyform`, `mirrorKeyform`, `resetKeyform` |
| `keyform` | `set` (any property of one cell: positions, grid, angle, origin, scale, mirror, opacity, draw order, colors), `transform` (translate, rotate or scale a selection of points in a cell, in any space) |
| `blend` | `createShape`, `addTarget`, `setShapeKeyform`, `addConstraint`, `removeTarget` |
| `glue` | `create`, `autoPair`, `setPairs`, `setWeights`, `reorder`, `delete` |
| `physics` | `addSetting`, `updateSetting`, `addInput`, `addOutput`, `setParticles`, `removeSetting` |
| `expression` | `create`, `setEntries`, `setFades`, `delete` |
| `motion` | `create`, `setMeta`, `setCurve`, `addPoints`, `removeCurve`, `addEvent`, `delete` |
| `pose` | `addGroup`, `setGroup`, `removeGroup` |
| `meta` | `setHitAreas`, `setDisplayNames`, `setStandardGroups`, `setUserData`, `setCombinedParameters` |

**Read-only operations** are not commands and never change the document:
`query`, `describe`, `validate`, `explain`, `evaluate`, `render`, `sweep`,
`diff`, `history` and `export`. Export writes files but does not change the
document.

---

## 2. TypeScript API (`@mochi-maker/api`)

### 2.1 Shape

```ts
import { openProject } from '@mochi-maker/api';

const s = await openProject('Hana.mochi');            // headless session
// or: const s = await connectEditor({ port, token }) — same interface (§5)

const angle = s.params.get('@param:ParamAngleX');     // typed proxy (read-only view)

await s.transact('Rig the left eyelid', (tx) => {
  const open = tx.param.create({ exportId: 'ParamEyeLOpen', name: 'Eye L open',
                                  min: 0, max: 1, default: 1, keys: [0, 1] });
  const lid = '@mesh:EyeL_Lid';
  tx.rig.addBinding({ target: lid, parameter: open.uid, keys: [0, 1] });
  tx.keyform.transform({
    target: lid, cell: { [open.uid]: 0 },
    select: { vertices: 'all' }, space: 'canvas',
    scale: { x: 1, y: 0.1, pivot: 'bottom-center' },
  });
});

const img = await s.render({ pose: { parameters: { ParamEyeLOpen: 0.5 } },
                             view: { framing: { around: '@mesh:EyeL_Lid', margin: 40 },
                                     overlays: ['wireframe'] } });
```

- **Two layers.** `tx.<area>.<verb>(args)` is generated from the registry, so
  every command has a typed method with its docs as TSDoc. Underneath,
  `tx.run(name, args)` takes the name as a string. It is fully typed through a
  mapped type over the registry (`CommandArgs<'rig.addBinding'>`), and it is
  what the MCP server and the bridge use.
- **Proxies are views.** `s.params.get(ref)` returns a read-only snapshot at
  the current revision, with typed fields and navigation (`mesh.part`,
  `mesh.deformer`, `param.boundBy()`). Changes always go through commands,
  so there is no hidden mutation path that skips undo or the log.
- **Synchronous inside transactions.** Command calls inside `transact` are
  synchronous, and each returns its result, such as the UIDs of created
  objects. Rendering and export are asynchronous and happen outside
  transactions, or on a dry run (§2.3).
- **Same API in the editor.** The editor exposes `window.mochi` (a session
  bound to the open document) for its scripting console. Scripts run there
  are recorded with author `script`.

### 2.2 Self-description

```ts
s.describe();                       // areas, command names, one-line summaries
s.describe('rig.addBinding');       // JSON Schema of args and result, docs, examples, error codes
s.describe({ search: 'mirror' });   // ranked matches over names, summaries and docs
s.schema('ArtMesh');                // JSON Schema of a document object kind
```

Every command's documentation has a fixed structure: what it does, its
arguments with units and spaces, a minimal example, errors and their fixes,
and related commands. Examples are executed in CI against a fixture project,
so they cannot rot.

### 2.3 Transactions, dry runs and concurrency

```ts
const r = await s.transact('Try a wider grid',
  (tx) => tx.deformer.setGrid({ target: '@warp:Face', rows: 8, cols: 8 }),
  { dryRun: true, expectRevision: 41, preview: { pose: 'default' } });

r.diff;          // structural diff (§2.5)
r.validation;    // lint results after the change
r.preview;       // before/after renders and a difference image
// nothing was committed; call again without dryRun to apply
```

- **Atomic.** If any command fails, nothing is committed. The error says
  which command, at which index, failed (`at: 3`).
- **`expectRevision`.** If someone else, such as the person in the editor,
  committed meanwhile, the call fails with `E_REVISION_MISMATCH`. The error
  includes the diff since the expected revision, so the agent can re-plan.
- **Batches.** A transaction takes up to thousands of commands. Commands
  inside it see each other's results. `tx.ref(n)` names the result of the
  n-th command, for batches built as data (MCP, JSONL scripts).

### 2.4 Errors that help

```json
{
  "code": "E_KEY_NOT_ON_PARAMETER",
  "message": "Key 15 is not in the key list of ParamAngleX (-30, 0, 30).",
  "command": "rig.addBinding", "at": 2,
  "path": "args.keys[1]",
  "fixes": [
    { "description": "Add 15 to ParamAngleX's key list first",
      "command": "param.setKeys", "args": { "target": "param_0007", "keys": [-30, 0, 15, 30] } },
    { "description": "Use the nearest existing key",
      "replace": { "path": "args.keys[1]", "value": 0 } }
  ],
  "docs": "mochi://docs/commands/rig.addBinding#errors"
}
```

- Error codes are stable and documented. Messages name objects by export ID
  and display name, not only by UID.
- **Fixes are machine-applicable:** a command to run first, or a replacement
  value for the failing argument. An agent can apply a fix without having to
  understand the prose.
- Validation results use the same structure, with `severity: 'warning'`.

### 2.5 Seeing, comparing and explaining

| Call | Returns |
|---|---|
| `render({ pose, view })` | PNG plus metadata: the framing box, drawable boxes in image pixels, and the Mochi2D version |
| `sweep({ parameter, values or steps, view })` | a contact sheet, one tile per value, labeled. It shows what a parameter does at a glance. |
| `sweep2d({ x, y, steps })` | a grid over two parameters, for example angle X × angle Y |
| `diff({ from, to })` | structural diff between revisions or a dry run: objects added, removed or changed, with the changed fields and the vertex-displacement maximum and RMS |
| `visualDiff({ from, to, pose, view })` | before, after, and a difference heat map; image metrics (RMS, changed-pixel fractions, as in §4h) |
| `evaluate({ pose })` | numbers: per drawable visibility, opacity, draw and render order, colors, bounding box, and vertices on request |
| `explain(ref, { pose })` | why an object looks as it does at a pose (below) |
| `validate()` | lint results with fixes |
| `history({ since })` | committed transactions with authors and labels |

**`explain`** combines document data with Mochi2D's evaluation introspection
(design M7). Example for a mesh:

```json
{
  "object": "mesh_0042 (ArtMesh_Mouth_Inner, \"Mouth inside\")",
  "visible": false,
  "because": [
    { "kind": "outOfRange", "binding": "ParamMouthOpenY", "keys": [0, 0.3], "value": 0.5,
      "note": "values above 0.301 hide this mesh" }
  ],
  "opacity": { "keyform": 1, "deformerChain": 0.8, "parts": 1, "total": 0.8 },
  "drawOrder": { "value": 512, "scope": "part_0003 (Face)", "renderOrder": 233 },
  "clippedBy": ["mesh_0040 (ArtMesh_Mouth_Mask)"],
  "deformers": ["warp_0011 (Mouth)", "rot_0002 (Head)"],
  "fixes": [{ "description": "Extend the binding's keys to 1", "command": "rig.addKey",
              "args": { "target": "mesh_0042", "parameter": "param_0012", "key": 1 } }]
}
```

`explain` also takes parameters ("which objects does this drive, and how much
do they move over its range?") and parts.

### 2.6 Determinism

- UIDs come from a per-document counter, so the same calls give the same
  UIDs.
- Commands that use randomness take a `seed`. If none is given, one is drawn
  from the document's seeded stream and recorded in the log.
- Stored values are rounded to float32 when written (design 3.3).
- Renders come from Mochi2D's reference renderer with fixed settings. The
  same document, pose and view give the same PNG bytes on the same Mochi2D
  version.
- No output depends on wall-clock time, locale or hash-map iteration order.

---

## 3. MCP server (`@mochi-maker/mcp`)

Run with `mochi-maker mcp [project] [--bridge]` over stdio. Headless by
default. With `--bridge`, it drives a running editor instead (§5).

### 3.1 Tools

The surface is **few, general tools, plus discovery**. One tool per command
would mean around 100 tools and crowd an agent's context. The catalog is
reached through `describe` instead.

| Tool | Purpose |
|---|---|
| `mochi_project` | `new`, `open`, `save`, `close`, `status` (path, revision, counts, dirty flag) |
| `mochi_describe` | search and describe commands, object schemas and error codes |
| `mochi_query` | read the document: kind, filter, fields, paging. Returns compact JSON. |
| `mochi_run` | run a transaction: `{ label, commands: [{ name, args }], dryRun?, expectRevision?, preview? }` → results, the new revision, a diff summary, and the preview images when asked |
| `mochi_undo` / `mochi_redo` | undo or redo n steps; reports what changed |
| `mochi_history` | committed transactions |
| `mochi_render` | render a pose and view → **image content** plus JSON metadata |
| `mochi_sweep` | contact sheet over one or two parameters → **image** |
| `mochi_diff` | structural and visual diff between revisions → JSON plus **images** |
| `mochi_evaluate` | numeric evaluation at a pose |
| `mochi_explain` | §2.5 |
| `mochi_validate` | lint plus a check of the export target version |
| `mochi_import_art` | import a PSD, ORA or PNG folder from the allowed directories |
| `mochi_export` | export to a directory inside the allowed directories; returns the export report |

- An `--expanded-tools` option also exposes the 20 most-used commands as
  their own tools, for clients that work better with specific tools.
- Images are returned as MCP image content (PNG, at most 1024 px on the long
  side by default), next to text that says what was rendered: pose, framing,
  overlays. **Every successful `mochi_run` can return a preview**
  (`preview: { pose, view }`), so an agent sees each step without an extra
  call.
- Overlays an agent can ask for: `wireframe`, `warp-grids`,
  `rotation-handles`, `labels` (export IDs drawn next to drawables), `masks`,
  `bounds`, `inactive` (ghosted). Labels let an agent connect what it sees to
  refs.

### 3.2 Resources

| URI | Content |
|---|---|
| `mochi://project` | summary: canvas, counts, revision, export settings |
| `mochi://document/{kind}` | list of objects of a kind (compact) |
| `mochi://document/{kind}/{uid}` | one object, in full |
| `mochi://schema/document` | JSON Schema of the document |
| `mochi://schema/commands` | the command catalog with JSON Schemas |
| `mochi://docs/{topic}` | guides: coordinate spaces, rigging recipes, error codes |
| `mochi://preview/default.png` | the default pose, re-rendered when the revision changes |
| `mochi://history` | the transaction log |

Resources announce changes through MCP resource-update notifications when the
revision changes, which matters in bridge mode, where a person edits too.

### 3.3 Prompts

A few MCP prompts carry tested workflows, written as step lists over the tools:
"rig a blink", "set up head angle X with warps", "add hair physics",
"review the rig for problems". They are guides only. They contain no hidden
automation.

---

## 4. Command-line tool (`mochi-maker`)

```
mochi-maker new <dir> [--canvas WxH] [--ppu N]
mochi-maker import <project> <art.psd|art.ora|dir>
mochi-maker run <project> <script.ts|commands.jsonl> [--dry-run] [--label L]
mochi-maker query <project> <kind> [--where …] [--fields …] [--json]
mochi-maker validate <project> [--target-version 3|4|5|auto] [--json]
mochi-maker render <project> [--pose pose.json] [--param Id=v …] [--out img.png] [--overlays …]
mochi-maker sweep <project> --param Id [--steps N] --out sheet.png
mochi-maker export <project> --out <dir|file.zip> [--moc-version auto|3|4|5] [--atlas 4096]
mochi-maker diff <project> [--from rev] [--to rev] [--images dir]
mochi-maker history <project> [--export history.jsonl]
mochi-maker replay <history.jsonl> --out <project>
mochi-maker conformance-pack <project…> --out <dir>     # design 7.5
mochi-maker mcp [project] [--bridge] [--allow-dir D …]
mochi-maker bridge [--port P]                            # §5
```

- **Scripts.** A `.ts` or `.js` script default-exports
  `async (session) => {}` and gets the same API as §2. `commands.jsonl` holds
  one `{ name, args }` per line and runs as one transaction. Both kinds are
  recorded in the history with author `script:<path>`.
- **Machine-readable.** `--json` on every command gives JSON output, the
  §2.4 error structure, and exit codes: 0 success, 1 validation errors,
  2 usage errors, 3 internal errors.
- **Batch work.** Commands that take a project also accept a glob, and work
  through all projects even when one fails (same rule as Mochi2D's
  conformance tools).

---

## 5. Live bridge

A person watches an agent work in the editor, and can pause it or take over
at any moment.

**Protocol.** The bridge speaks Mochi
Studio's bridge protocol, version 1: the same paths
(`/host`, `/api`), messages, pairing, tokens and error codes, with
`"app": "mochi-maker"` in `host_hello` and `GET /`. It listens on its own
default port, **47831** (Studio uses 47830), so both apps can run on one
machine. The catalog it sends is `Project.commandInfo()`: each command's
`scope` (`read`, `edit`, `export`), `undoable` and `readOnly`. Where this
section differs from that protocol, the protocol wins.

**As built ([`bridge.md`](bridge.md)).** Studio's protocol has a separate bridge
process: the editor connects to it as the host, and agents connect to it as clients. Because the
protocol wins, `mochi-maker bridge` is that process. 5.1 and 5.2 below are the earlier, provisional
design, kept for the record. The lease (5.3) is built as a simpler rule: the person holds it during
and shortly after their own edits, and while they pause agents.

### 5.1 Topology

A web page cannot listen for connections, so the **agent side listens and
the editor connects**:

```
agent ──MCP/stdio──► mochi-maker mcp --bridge ──listens on 127.0.0.1:<port>──◄── WebSocket ── editor tab
                                                                       (person clicks "Let an agent in")
```

1. `mochi-maker mcp --bridge` starts a WebSocket endpoint on `127.0.0.1` on a
   random free port, and prints a one-time **pairing code** for the person
   and a `ws://127.0.0.1:<port>` address.
2. The person opens **Agent access** in the editor, enters the address and
   code, chooses the permission level (§6), and connects.
3. While connected, **the editor holds the document.** The MCP server forwards
   every API call to the editor over the bridge, and the editor runs it
   through the same command registry. The agent's tools behave as in headless
   mode, with the same results and errors.

In the desktop (Electron) build, the main process can host the endpoint
instead, and the agent's MCP server connects to it. After the handshake, the
protocol is the same in both directions.

### 5.2 Protocol

JSON-RPC 2.0 over WebSocket, with text frames, and PNG images base64-encoded
inside results.

- **Handshake:** `hello { protocol: "mochi-bridge/1", client, pairingProof }`
  → `welcome { session, permissions, revision, capabilities }`. The pairing
  code is never sent in clear. The proof is an HMAC over a server nonce, so a
  connection replayed from a captured frame fails.
- **Requests** (agent → editor): the API methods of §2, under the same names
  (`describe`, `query`, `run`, `render`, `sweep`, `diff`, `evaluate`,
  `explain`, `validate`, `undo`, `redo`, `history`, `export`).
- **Notifications** (editor → agent):
  - `revision { revision, author, label, diffSummary }` after every commit,
    by anyone;
  - `control { holder: 'agent' | 'person', reason }`;
  - `presence { selection, pose }` (optional; it lets the agent see what the
    person is looking at);
  - `closing { reason }`.
- **Agent presence in the editor** (agent → editor): `focus { refs, pose? }`
  highlights what the agent is working on, so the person can follow.

**Compatibility with Mochi Studio.** The live bridge as built follows Mochi
Studio's bridge protocol: the same paths, messages, pairing, tokens and error
codes, with its own app name and port ([`bridge.md`](bridge.md)). Transport,
framing, handshake and methods stay separable.

### 5.3 Taking over

- **Control lease.** One holder at a time may commit: the agent or the
  person. The person always wins:
  - Any editing gesture by the person takes the lease, after the gesture
    finishes, so a half-done drag is never interrupted.
  - The agent's next `run` then fails with
    `E_CONTROL_HELD_BY_PERSON { retryAfter? }`.
  - Reads, renders and dry runs keep working.
- **Modes**, chosen by the person:
  - *Watch*: the agent edits and the person only watches.
  - *Pair* (default): the agent edits, and any edit by the person takes the
    lease until the person clicks "Hand back".
  - *Paused*: nobody but the person edits.
- Agent transactions are ordinary history entries with author `agent:<name>`.
  The person can undo them like their own. Undo is per document, not per
  author. "Undo all agent changes since …" is one command.
- `expectRevision` (§2.3) lets the agent notice concurrent edits instead of
  overwriting them.

---

## 6. Safety

1. **Off by default.** No server or endpoint runs unless the person starts
   one: `mochi-maker mcp` in a terminal, or "Let an agent in" in the editor.
2. **Local only.** Endpoints bind to `127.0.0.1` only. There is no option to
   bind other interfaces in the first release. WebSocket connections must
   pass the pairing proof and must come from the editor's own origin, or from
   no origin for native clients. Others are refused, which blocks other web
   pages from connecting through the browser.
3. **Explicit permission levels**, chosen at pairing and shown in the
   indicator:
   - *Read*: query, render, explain.
   - *Edit*: plus commands.
   - *Edit and export*: plus file writes.

   Downgrading takes effect immediately. Upgrading needs the person.
4. **Visible indicator.** While an agent is connected, the editor shows a
   persistent band at the top of the canvas with:
   - the agent's name and permission level;
   - what it is doing (the current transaction's label);
   - Pause, Take over and Disconnect.

   The band cannot be hidden while connected. Objects the agent is touching
   are outlined in the agent color. On the desktop, the window title and a
   tray icon show the state as well.
5. **Limited reach.** The agent surfaces execute **commands only**. There is
   no tool that runs arbitrary code, opens network connections or reads
   arbitrary files.
   - File access for import and export is limited to the project folder and
     directories the person allowed (`--allow-dir`, or chosen in the
     pairing dialog). Paths are resolved and checked after following
     symbolic links.
   - Scripts (`mochi-maker run script.ts`) are code the person chose to run
     on their own machine. They are a CLI feature, never available to an
     agent through MCP or the bridge.
6. **Recoverable.** Every agent change is in the history and can be undone.
   Before the first agent commit in a bridge session, the editor saves a
   snapshot of the project.
7. **Limits.** Per-request size limits (commands per transaction, image
   size) and a request rate limit, so a runaway agent cannot freeze the
   editor.

---

## 7. Ergonomics checklist

| Need | Where |
|---|---|
| Stable IDs | UIDs (§1); results always return UIDs; refs accept export IDs and names |
| Clear errors with fixes | §2.4, machine-applicable fixes |
| Schema introspection | `describe`, `schema`, MCP resources (§2.2, §3.2) |
| Seeing results | `render`, `sweep`, previews on `run`, labels overlay (§2.5, §3.1) |
| Visual diffs | `visualDiff`, `mochi_diff` (§2.5) |
| Trying safely | dry runs, atomic transactions, undo (§2.3) |
| Deterministic results | §2.6 |
| Working with a person | the bridge, the control lease, presence and focus (§5) |
| Learning the domain | `mochi://docs`, MCP prompts, executed examples (§2.2, §3.3) |
