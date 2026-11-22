# The desktop build

`packages/desktop` (roadmap M14) is Mochi Maker in an Electron window: the same editor,
with files on disk instead of the browser's downloads and uploads, auto-saved copies, and the
bridge built in. Electron is MIT-licensed (`THIRD_PARTY_NOTICES.md`).

## Building and running

```sh
npm run build && npm run build:editor          # the packages and the editor's build
npm run build -w @mochi-maker/desktop          # app/: the bundled main process, preload and editor
npm run start -w @mochi-maker/desktop          # run it with the Electron from node_modules
npm run package:linux -w @mochi-maker/desktop  # out/Mochi Maker-linux-x64/mochi-maker (unsigned)
```

`build.mjs` bundles the main process (ES module) and the preload (CommonJS, as a sandboxed preload
must be) with Vite. Only `electron` and Node's built-in modules stay outside, so the app needs no
`node_modules`. It then copies the editor's `dist/` in as the page. `package.mjs` runs
@electron/packager: `node package.mjs <linux|win32|darwin> [x64|arm64]` writes
`out/Mochi Maker-<platform>-<arch>/`, with the app in `resources/app.asar`, Electron's `LICENSE`
and `LICENSES.chromium.html` beside the executable, and no signature.

### Windows and macOS: the Desktop workflow

`.github/workflows/desktop.yml` builds the app on each system's own runner: Windows x64
(`windows-latest`), macOS arm64 and x64 (`macos-15`, Apple silicon) and Linux x64. The x64 Mac app
is smoke-tested under Rosetta 2: the Intel runner (`macos-15-intel`) has no GPU, and there the
editor's view finds no WebGL2 (software GL does not start on that VM either), so the editor does
not come up. It runs by hand (Actions › Desktop › Run workflow) and on version tags (`v*`). The macOS x64 job runs
on tags, and by hand only with «macos_x64» checked, since macOS minutes cost ten times a
Linux minute. Each job:

1. installs, builds the packages and the editor, and packages the app with `package.mjs`;
2. on macOS, gives the bundle an ad-hoc signature (Apple silicon runs only signed code);
3. runs the smoke test, `node smoke.mjs <platform> <arch>` (also `npm run smoke -w
   @mochi-maker/desktop`): the packaged app starts, opens golden 1's project folder, exports it into
   a folder (the dialogs answered by `MOCHI_DESKTOP_PICKS`), checks the files and the app identifier,
   and quits;
4. keeps the zipped app as the run's artifact (`mochi-maker-<platform>-<arch>`, 30 days). The macOS
   zip is made with `ditto`, so the bundle keeps its symlinks and permissions.

The builds are unsigned:

- **Windows:** SmartScreen warns on first start until the person chooses "Run anyway". An installer
  (Squirrel or MSI) is a later step.
- **macOS:** an un-notarized app is quarantined when downloaded: the person opens it with
  right-click › Open, or removes the flag (`xattr -dr com.apple.quarantine "Mochi Maker.app"`). A
  universal build would join both architectures with `@electron/universal`.

**Releases**. A version tag (`v0.1.0`) runs the four builds with the tag's version
(`MOCHI_APP_VERSION`, the tag without its «v»), then the `release` job publishes a GitHub release:

- a pre-release, while the apps are unsigned, titled «Mochi Maker 0.1.0»;
- the four zipped apps;
- the notes from `packages/desktop/release-notes.md`: what each zip is, and how to open an unsigned
  app on each system.

The repository is private, so its releases are too. To release: `git tag v0.1.0 && git push
origin v0.1.0`.

**Signing, for later.** Running the workflow by hand with «sign» checked runs the signing steps
instead of the ad-hoc signature. They need these repository secrets, and fail naming the first one
missing:

| Secret | For |
|---|---|
| `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD` | the Developer ID Application certificate, base64 |
| `MAC_SIGNING_IDENTITY` | its name, e.g. `Developer ID Application: … (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | notarization with `notarytool` (an app-specific password) |
| `WINDOWS_CERTIFICATE_PFX_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD` | the code-signing certificate, base64 |

macOS signs with the hardened runtime and `entitlements.mac.plist` (JIT and unsigned executable
memory, which Electron's V8 needs), notarizes and staples; Windows signs `mochi-maker.exe` with
`signtool` and a timestamp. These steps have not run yet: there are no secrets.

**The app identifier** is `com.waifucave.mochimaker`, in `packages/desktop/identity.mjs`:

- **macOS:** the packager (`package.mjs`) writes it as the bundle ID in `Info.plist`, and the
  helper apps' IDs derive from it (`com.waifucave.mochimaker.helper`). The category is
  `public.app-category.graphics-design`. Signing takes the identifier from `Info.plist`.
- **Windows:** the main process sets it as the AppUserModelID (`app.setAppUserModelId`) before any
  window; taskbar grouping and pinning follow it.
- **The data folder follows the product name, «Mochi Maker», not the identifier:**
  `~/Library/Application Support/Mochi Maker` on macOS, `%APPDATA%\Mochi Maker` on Windows,
  `~/.config/Mochi Maker` on Linux. The product is not renamed and the app does not call
  `app.setName`, so auto-saves, recent projects and bridge tokens stay where they are.
- The smoke test checks it on each system: the bundle ID and every helper's under it on macOS, the
  AppUserModelID on Windows, none elsewhere.

## Files

The in-window menus stay as they are. In the desktop build, their File actions go to the disk:

| Action | Desktop behavior |
|---|---|
| Open, Open Folder (Ctrl+O) | A folder dialog: the project folder (`<name>.mochi/`) is read and opened. |
| Recent | The last ten project folders that still exist (`<userData>/recent.json`). |
| Save (Ctrl+S) | Writes the project folder in place, each file atomically (a temporary file, then a rename). Files the project no longer has (deleted meshes, deformers, motions, unused assets) are removed; nothing else in the folder is touched. A project never saved asks for a folder first. |
| Save As (Ctrl+Shift+S) | A save dialog; `.mochi` is added to the name. |
| Import Art, Link Art | A file dialog (PSD, ORA, PNG); the art is imported and linked (below). |
| Import Physics | A file dialog for `.physics3.json`, run through `physics.import`. |
| Import Model | A folder dialog: the model folder's files are read (nothing is written) and imported as a new project ([`import.md`](import.md)); it is unsaved, so Save asks for a folder. |
| Export, Export Motions | A folder dialog: the exported files are written into it. |

Exporting an image sequence, a video or the PSD of the pose writes into a folder chosen
in a dialog. Questions that ask for a name (Save As, a marker, an event, a template, a mesh preset)
are the editor's own dialog, since Electron has no `window.prompt`.

Closing the window with unsaved work asks **Save**, **Don't Save** or **Cancel**. Save saves
(asking for a folder if needed) and then closes; if that save is cancelled, the window stays.
Don't Save closes and removes the project's auto-saved copies.

## Auto-saved copies and recovery

- **When:** every 60 seconds, if the project has unsaved changes (`AUTOSAVE_MS`).
- **What:** the whole project folder, as a save writes it, plus `meta.json` (the name, the
  project's folder if it has one, and the time).
- **Where:** `<userData>/autosave/<key>/<time>/`. Each opened or new project gets its own key.
  `<userData>` is `~/.config/Mochi Maker` on Linux, `%APPDATA%\Mochi Maker` on Windows and
  `~/Library/Application Support/Mochi Maker` on macOS. `MOCHI_DESKTOP_USER_DATA` moves it.
- **How many:** the newest **5** per project. Saving the project, or choosing Don't Save, removes
  its copies.
- **Recovery:** while the app runs, `<userData>/autosave/session.lock` exists, and a clean exit
  removes it. If the next start finds it, the app did not end cleanly: a dialog lists the newest
  copy of each project, to **Recover** or **Discard**. A recovered project counts as unsaved; Save
  writes it back to its own folder.

## The live link on the disk

Import Art links the file. The main process watches it (`fs.watch`, debounced by 150 ms) and tells
the page when it changes. The page then runs the same check as in the browser: a changed size or
modification time re-imports, as one undoable step. There is no polling.

## The bridge

The main process runs the bridge endpoint (`BridgeServer` from `@mochi-maker/bridge`) on
`127.0.0.1:47831`, the same address as `mochi-maker bridge`. So `mochi-maker mcp --bridge` and
other agents reach the desktop app exactly as they reach the browser. Differences:

- it starts with the app, and nothing else needs to run;
- the window pairs itself as the host with the server's pairing code, given to it over IPC and
  never shown;
- `/host` accepts the app's origin, `mochi://app`;
- its state (the host and agent tokens) is in `<userData>/bridge-state.json`.

Agents still need a token, made in Agent access as before. If the port is taken, for example by a
running `mochi-maker bridge`, the app starts without its own bridge and says so in the status line.
`MOCHI_DESKTOP_BRIDGE_PORT` moves it, and `MOCHI_DESKTOP_NO_BRIDGE=1` turns it off.

## Security

- **The page has no Node:** `contextIsolation`, `sandbox` and `nodeIntegration: false`.
  `require` and `process` are undefined there (the end-to-end test checks this).
- **A narrow preload API**, `window.mochiDesktop`:
  - one IPC channel per function;
  - each handler checks that the caller is the app's own page;
  - each argument is checked for shape.
- **Checked paths.** The page cannot name an arbitrary path.
  - Reading art, watching it, saving a project and opening a recent project all go through
    `PathGuard`.
  - A path must be absolute, without NUL, and inside a folder or file the person chose in a dialog
    this session (or a recent project). The check follows symbolic links (`realpath`, through the
    nearest existing ancestor).
  - Writes take only project file names (`mochi-project.json`, `meshes/…json`,
    `assets/sha256-….png` and the like) or relative export paths without `..`.
- **Sizes checked before reading.** A project or model folder is listed and its files' sizes
  summed from the disk before any file is read, and an art or physics file is checked by its size,
  against the caps on files from others ([`limits.md`](limits.md)); one past a cap is refused as
  too large.
- **The app's own scheme.** The page is served from `mochi://app/`, with this content security
  policy:

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' data: blob: ws://127.0.0.1:* http://127.0.0.1:*; worker-src 'self' blob:;
  media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'
  ```

  `X-Content-Type-Options: nosniff` is also set.
- **No way out.** Navigation away from the app is blocked, `window.open` is denied, and the only
  permissions granted are clipboard read and write.
- **Menus.** On Linux and Windows there is no native menu (the in-window menus do it all). On
  macOS there is the minimal application menu: the app menu (Quit), Edit (for copy and paste in
  text fields) and Window.

## Tests

- `packages/desktop/test/identity.test.ts`: the app identifier, the Windows call on Windows only,
  and that the packager gets it while the product name stays.
- `packages/desktop/test/main.test.ts`, in Node without Electron:
  - the path guard, symbolic links included;
  - project writes and pruning, and export writes;
  - the auto-saves (keep 5, crash detection, clearing, bad keys);
  - recent projects;
  - the bridge (start, pairing code, `GET /`, a port already in use).
- `packages/desktop/test/app.test.ts`, the built app in Electron. It runs headless through
  Playwright's Electron driver, with `--ozone-platform=headless` and SwiftShader.
  `MOCHI_DESKTOP_PICKS` answers the dialogs in order. It checks that the app:
  - keeps the page sandboxed and refuses paths no dialog chose;
  - opens, saves and exports;
  - imports, watches and re-checks art;
  - gets the bridge connected;
  - blocks navigation;
  - auto-saves, is killed, then recovers and saves;
  - asks on close (Cancel, then Save);
  - and, when `out/` holds the Linux package, starts it.

  It is skipped when the Electron binary is missing (npm downloads it on install), unless
  `MOCHI_MAKER_REQUIRE_DESKTOP=1`.
