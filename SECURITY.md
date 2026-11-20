# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting: on the
repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue for a
vulnerability.

Include what is affected (the package, the desktop app or the editor, and the version or commit),
how to reproduce it, and what an attacker gains. The report stays private while it is looked into
and fixed. Once a fix is released, the advisory is published with credit to the reporter, unless
they prefer otherwise.

## Supported versions

Mochi Maker has not reached 1.0. Only the latest release, and the `main` branch, get security
fixes. Older releases do not; update to the latest one.

| Version | Supported |
|---|---|
| latest release | yes |
| `main` | yes |
| older releases | no |

## What Mochi Maker opens to the network

Nothing listens on the network unless the person starts it, and what does listen binds to the
loopback address only.

- **The live bridge** (`mochi-maker bridge`, or built into the desktop app): a WebSocket server on
  `127.0.0.1`, port 47831 by default. It refuses peers that are not loopback, `Host` headers other
  than `localhost`, `127.0.0.1` or `[::1]`, and origins that are not allowed. The editor pairs with
  a code shown in the terminal or the app; agents need a token the person created, with a scope
  (read, edit, export). The state file holds only SHA-256 hashes of the tokens, with mode 600.
  Details: [`docs/bridge.md`](docs/bridge.md).
- **The desktop app** runs its bridge in the main process on the same address. Set
  `MOCHI_DESKTOP_NO_BRIDGE=1` to turn it off. The app makes no other connections: its page is served
  from its own `mochi://` scheme with a strict content security policy, navigation away from the app
  is blocked and `window.open` is denied ([`docs/desktop.md`](docs/desktop.md), "Security").
- **The editor in a browser** (`npm run editor`) is served by Vite's development server on
  `localhost`. The editor makes no requests of its own beyond its files and, when the person
  connects, the bridge.
- **The MCP server** (`mochi-maker mcp`) speaks JSON-RPC on stdio and opens no port; in `--bridge`
  mode it connects to the bridge as a client.
- No telemetry, update checks or crash reports are sent anywhere.

## What Mochi Maker reads and writes on disk

- **Files it parses**, which may come from anyone: PSD, OpenRaster (`.ora`, a zip), PNG, project
  folders and zipped projects, `.physics3.json` files, sounds (WAV), and command files for the CLI.
  These parsers are the main surface for malformed input. A malformed file should fail with an
  error, never crash the app or touch other files; a case where it does is a vulnerability.
- **The MCP server** reads and writes only inside the project folder and the `--allow-dir`
  directories (by default the current directory), checked after following symbolic links.
- **The bridge** never takes file paths: imports carry the bytes, and exports return bytes that the
  agent side writes inside its own allowed directories.
- **The desktop app's page** has no Node access (`contextIsolation`, `sandbox`, no
  `nodeIntegration`). Its preload exposes a narrow API whose handlers check the caller and every
  argument. Paths must lie inside a folder or file the person chose in a dialog in this session, or
  a recent project, checked after following symbolic links; writes take only project file names or
  relative export paths without `..`.
- **The desktop app's own data** (auto-saved copies, recent projects, the bridge state) is in its
  user-data folder: `%APPDATA%\Mochi Maker` on Windows, `~/Library/Application Support/Mochi Maker`
  on macOS and `~/.config/Mochi Maker` on Linux.
- **The CLI** reads and writes the paths it is given, as any command-line tool does.

## Out of scope

- A person who runs Mochi Maker on purpose with files or commands they wrote themselves, or who
  gives an agent a token with export scope and an allowed directory, has granted that access.
- The desktop builds are unsigned (see [`docs/desktop.md`](docs/desktop.md)): the operating
  system warns before the first start, and that warning alone is not a vulnerability.
