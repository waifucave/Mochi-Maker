# The live bridge (M11)

With the bridge, a person watches an agent work in the editor, and can pause the agent or take
over at any moment. It speaks Mochi Studio's bridge protocol, version 1:
the same paths, messages, pairing, tokens and error codes, with `"app": "mochi-maker"` and its own
default port, **47831**.

```
agent ─MCP/stdio─► mochi-maker mcp --bridge ─┐
agent ─WebSocket (any language) ─────────────┼─► mochi-maker bridge (127.0.0.1:47831) ◄─ WebSocket ─ editor (host)
                                             │        /api: clients              /host: the editor
```

## Using it

1. **Start the bridge:** `mochi-maker bridge`. It prints a six-digit pairing code. Nothing listens
   until the person starts it.
2. **Connect the editor:** open **Agent access** (toolbar) and click Connect, then enter the code.
   The editor keeps its host token in the browser, so it does not need to pair again.
3. **Give an agent a token:** in Agent access, create a token with a name and a scope:
   - **Read:** look, query, render and evaluate;
   - **Edit:** also change the document;
   - **Export:** also export files.

   The token is shown once.
4. **Connect the agent:**
   `mochi-maker mcp --bridge --token mmt_… [--bridge-url ws://127.0.0.1:47831] [--allow-dir dir]`,
   or any WebSocket client that speaks the protocol.

While agents are connected, a band over the viewport shows:

- who is connected, with their scopes;
- what they are running;
- who may edit now;
- **Pause agents** and **Disconnect** buttons.

Revoking a token in Agent access disconnects its agents.

## `mochi-maker bridge`

```sh
mochi-maker bridge [--port 47831] [--state file | --no-state] [--allow-origin url]...
```

| Topic | Behavior |
|---|---|
| **Listening** | On `127.0.0.1` only, with two WebSocket paths: `/host` for the editor and `/api` for agents. `GET /` returns `{ app, version, protocol, studio: { connected }, endpoints }`. |
| **Refused connections** | HTTP 403 when the peer is not a loopback address, or the `Host` header is not `localhost`, `127.0.0.1` or `[::1]`. Also when the `Origin` is not allowed: `/host` needs `http(s)://localhost` or `127.0.0.1` (any port) or an `--allow-origin`, and `/api` accepts no origin or an allowed one. |
| **Pairing** | Codes are six digits, valid 10 minutes and once; five wrong tries make a new one. There is one host at a time: a newer one replaces the older (close code 4000). |
| **Secrets** | The state file (default `~/.config/mochi-maker/bridge.json`, mode 600) holds only SHA-256 hashes of host and client tokens. Host tokens start with `mmh_`, client tokens with `mmt_`. |
| **Clients** | A client says `hello` with its token within 5 seconds, or is closed (4401). The bridge checks each command's existence and scope, allows 30 commands per second per client, and waits up to 120 s for the editor's answer (`timeout`). |
| **Events** | Forwarded to subscribed clients that have the `read` scope. |

The protocol is implemented in `@mochi-maker/bridge`: `BridgeServer`, and `BridgeClient` for Node.

## The editor as host

**Catalog.** The editor sends this catalog after `host_welcome`:

| Command | Scope | What it does |
|---|---|---|
| `status` | read | name, revision, document hash, counts, canvas, export settings, undo state, the control lease |
| `describe`, `query`, `history`, `diff`, `validate` | read | as in the agent API |
| `evaluate` | read | Mochi2D's evaluation at a pose, off the person's screen (`revision` for an earlier one) |
| `render` | read | a PNG (base64). `source: "editor"` is exactly what the person sees: their pose, zoom and pan. Otherwise a pose, size, `around` framing, `view` or `revision` is rendered off-screen, without moving the person's view. |
| `presence` | read | the person's selection, pose and the lease |
| `focus` | read | outlines objects in the agent color, so the person can follow |
| `run` | edit | one transaction: `{ label, commands, dryRun?, expectRevision? }` → results, revision, structural diff |
| `undo`, `redo` | edit | n steps (any author) |
| `import_art`, `reimport_art` | edit | art the agent sends as base64 files, imported with `art.import` or re-imported with `art.reimport`. Stored under `agent-art/<name>` in the editor, so a re-import matches what was imported. |
| `export` | export | the export's report and files (base64); the agent side writes them |
| `export_movie` | export | a motion as PNG frames or a WebM or MP4 video (`{ motion, format?, width?, height?, fps?, background?, range? }`), rendered off-screen with physics from the motion's start; files as base64 |
| every document command and operation | its own scope | one command as its own transaction, labeled with its name |

Operations that read a file path (`art.import`, `art.reimport`, `sound.import`) are not offered directly, because a
path cannot reach the editor's files. `import_art` carries the bytes instead.

**Events:** `revision` (after every commit by anyone: revision, author, label, change count, kinds),
`control`, `presence` and `project`.

**Every command runs through the same command layer as the person's edits:**

- its history entry has the author `agent:<client name>`;
- the person can undo it like their own;
- the preview rebuilds as for any edit.

The host checks scopes again, as the protocol asks.

**Errors** keep the protocol's `code`. Mochi Maker adds its own fields: `mochiCode`, `path`,
`details` and `fixes`.

- A person holding the lease gives `control_held`.
- A missing object gives `invalid_arguments` with `mochiCode: "E_NOT_FOUND"`, and so on.

## Working alongside a person: the control lease

The person always wins, and a gesture is never interrupted:

1. **While the person edits**, agents' edits are refused with `control_held` (`E_CONTROL_HELD`,
   `details: { holder: "person", retryAfter }`). This covers a gesture in the viewport (a drag, a
   click, adding a vertex) and 1.5 seconds after it, after any of the person's own commits, and
   after their undo and redo. A drag that is running therefore never meets an agent's commit.
2. **Pause agents** holds the lease until the person resumes (`holder: "paused"`).
3. **Other agent calls** keep working: reads, renders, evaluations and dry runs are never blocked.
4. **Collisions.** Each agent transaction is atomic and runs between the person's gestures, so the
   two cannot interleave. `expectRevision` lets an agent notice that the person changed the
   document since it last looked.

## MCP in bridge mode

`mochi-maker mcp --bridge` connects to the bridge as a client, and the MCP tools work on the
editor's document:

- **Status:** `mochi_project` only gives `status`. The person opens and saves projects in the editor.
- **`mochi_run`**, **`mochi_undo`** and the other edits are recorded in the editor's history as
  `agent:<name>`. The person sees them land.
- **`mochi_render` without arguments** shows exactly what the person sees. With a pose, size,
  `around` or `revision`, it renders off-screen. `mochi_sweep` and `mochi_diff { visual: true }`
  are composed from those renders.
- **Files stay on the agent's side:**
  - `mochi_import_art` reads the art inside `--allow-dir` and sends its bytes;
  - `mochi_export` receives the files and writes them inside `--allow-dir`.

  The editor itself reads and writes no files for agents.
- **Scopes:** the token's scopes limit the session, and `--scope` can only narrow them further.
- **Resources** announce updates when the editor's document changes, by anyone.

## Safety

| Rule | How |
|---|---|
| **Off by default** | No bridge runs unless the person starts `mochi-maker bridge`. The editor connects only when the person clicks Connect, and agents need a token the person created. |
| **Local only** | The bridge binds to 127.0.0.1 and checks the peer, the Host header and the origin. |
| **A token per connection** | Every client says hello with its token, and the bridge knows only the tokens' hashes. Revoking a token closes its connections. |
| **Scopes** | They are checked by the bridge, then again by the editor. MCP sessions are limited by the token's scopes. |
| **No file access beyond the scopes** | File paths never cross the bridge. Import sends bytes (edit scope); export returns bytes (export scope), written by the agent side inside its allowed directories. |
| **Visible and recoverable** | The band shows connected agents and what they run. Every agent change is in the history with its author and can be undone. |
| **Limits** | Messages up to 16 MiB (a longer one closes its connection with code 1009; the bridge goes on), 30 commands per second per client, and 10 000 commands per transaction. Art sent through the bridge must fit in one message; [`limits.md`](limits.md) lists every cap. |

## Tests

- **`packages/bridge/test/bridge.test.ts`** (Node, with a scripted host) covers:
  - `GET /`, and the origin, Host and path checks;
  - pairing, wrong codes, host tokens and host replacement;
  - token hashes in a mode-600 state file;
  - scopes, unknown commands, bad arguments, events by name and prefix;
  - unknown tokens, missing hellos and protocol versions;
  - revocation, and the editor leaving;
  - the rate limit and timeouts.
- **`packages/editor/test/bridge.test.ts`** runs a real bridge in the test process, with the editor
  in headless Chromium as the host, a WebSocket client, and the MCP server in bridge mode. It
  covers:
  - pairing through the UI;
  - an agent's transaction landing in the editor's history, which the person then undoes;
  - scope refusals, the control lease during a drag and while paused;
  - renders of the person's view and off-screen poses;
  - every MCP tool in bridge mode, including export and import through the allowed directories;
  - revocation and disconnection.
