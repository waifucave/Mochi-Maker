Mochi Maker {{version}}, the desktop app, for Windows (x64), macOS (Apple silicon and Intel) and
Linux (x64). Each zip holds the whole app: unzip it and start it from there.

**These apps are not signed yet.** Your system will warn the first time you open one:

- **Windows** (`mochi-maker-win32-x64.zip`): unzip, then start `mochi-maker.exe`. If SmartScreen
  says «Windows protected your PC», choose **More info**, then **Run anyway**.
- **macOS** (`mochi-maker-darwin-arm64.zip` for Apple silicon, `mochi-maker-darwin-x64.zip` for
  Intel): unzip and move `Mochi Maker.app` to Applications. The first time, right-click it and
  choose **Open**, then **Open** again. Or, in Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Mochi Maker.app"`.
- **Linux** (`mochi-maker-linux-x64.zip`): unzip, then run `./mochi-maker` in the folder.

Each app was built and smoke-tested (it starts, opens a model, exports it and quits) on its own
system by the Desktop workflow. See `docs/desktop.md` for files, auto-saved copies and the bridge,
and `docs/guide/` to get started.
