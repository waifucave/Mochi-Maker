**Mochi Maker {{version}} is a first pre-release.** Mochi Maker is an open-source editor for
creating and rigging models for Live2D Cubism-compatible apps, built on the Mochi2D runtime and
MIT licensed. This is the desktop app for Windows (x64), macOS (Apple silicon and Intel) and Linux
(x64). It is early software, not yet at a 1.0 release: keep copies of your work, and of any model
you open.

## Download

Each zip holds the whole app. Unzip it and start the app from there; there is no installer.

| System | Zip | Start |
| --- | --- | --- |
| Windows (x64) | `mochi-maker-win32-x64.zip` | `mochi-maker.exe` in the unzipped folder |
| macOS, Apple silicon | `mochi-maker-darwin-arm64.zip` | `Mochi Maker.app` (move it to Applications) |
| macOS, Intel | `mochi-maker-darwin-x64.zip` | `Mochi Maker.app` (move it to Applications) |
| Linux (x64) | `mochi-maker-linux-x64.zip` | `./mochi-maker` in the unzipped folder |

## The apps are not signed

Signing needs certificates that the project does not have yet, so your system does not know who
made these apps and warns the first time you open one:

- **Windows:** SmartScreen says «Windows protected your PC». Choose **More info**, then
  **Run anyway**.
- **macOS:** the apps carry only an ad-hoc signature, so the first open is refused.
  - On macOS 15 (Sequoia) and later, it says Apple could not verify the app is free of malware.
    Choose **Done**, then System Settings › Privacy & Security, and **Open Anyway** next to
    Mochi Maker; confirm with your password.
  - On macOS 14 and earlier, right-click (or Control-click) `Mochi Maker.app`, choose **Open**,
    then **Open** again.
  - On any version, this in Terminal does the same:
    `xattr -dr com.apple.quarantine "/Applications/Mochi Maker.app"`.
- **Linux:** no warning. If the app stops at once with a message about `chrome-sandbox`, your
  system does not let it start Chromium's sandbox from an unzipped folder. Either make the helper
  belong to root (`sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`, in the
  folder), or start it with `./mochi-maker --no-sandbox`, which runs it without that sandbox.

Each app was built from this release's commit, and smoke-tested on its own system (it starts,
opens a project, exports it and quits), by the repository's Desktop workflow.

## What works

- Making a model from layered art: PSD, OpenRaster or a folder of PNGs; meshes generated for you
  and editable by hand; parts, warp and rotation deformers, parameters and keyforms.
- Clipping masks, multiply and screen colors, hit areas, physics, expressions, pose, motions with
  a timeline, sounds and motion sync.
- Export of `.moc3` files (versions 3 to 6) with their textures and runtime files, through
  Mochi2D, for apps that read these files.
- Opening an existing `.moc3` model folder as an editable project (File › Import Model…), for
  models you made or have permission to edit.
- Projects saved as folders on disk, auto-saved copies with recovery, and the live bridge that
  lets AI agents work in the open editor with your permission.

The getting-started guide (`docs/guide/` in the repository) goes from a layered PSD to a model
that moves, and `docs/desktop.md` describes the app's files, auto-saves and bridge.

## What is switched off

Glue and blend-shape authoring are not available in this build. Their code and tests are in the
repository behind the feature flags `glue` and `blendShapes`, which are off by default. Projects
that hold glue or blend shapes still open, but they do not export while the flags are off.

See the README's "Patents" section and `docs/core.md` (Feature flags).

## Reporting a problem

Open an issue on this repository (the **Issues** tab) with the steps that show the problem, your
system, and, if you can, a project that shows it. Report a security problem privately instead:
the **Security** tab › **Report a vulnerability** (`SECURITY.md` in the repository says more).

The changes in this release are in `CHANGELOG.md`, and the terms of use in `TERMS.md`.
