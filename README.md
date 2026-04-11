# Volt

A lightweight terminal workstation built with Tauri.

I built Volt for myself. VSCodium was eating 300-800 MB of RAM for what I was using it for, so I built something lighter. If you find it useful, use it.

![Volt Welcome](screenshots/volt1.png)

![Volt Workspace](screenshots/volt2.png)

## Why Volt

VSCode/VSCodium uses 300–800 MB of RAM by bundling Chromium and running hundreds of extensions. Volt uses the OS's native webview (Tauri) and bakes features directly in — no extension system, no bundled browser engine.

| | Volt | VSCodium |
|---|---|---|
| RAM usage | ~25–50 MB | 300–800 MB |
| Startup time | <1 second | 3–8 seconds |
| Runtime | Native webview (Tauri) | Bundled Chromium (Electron) |
| Extensions | None (built-in features) | Thousands |
| Installer size | ~10 MB | ~100 MB |

## Features

- **Multi-tab terminals** — multiple terminal sessions with drag-to-reorder tabs
- **Split terminal panes** — split horizontally (`Ctrl+Shift+D`) or vertically (`Ctrl+Shift+E`), draggable dividers, click to focus, close or drag panes out to merge/unmerge tabs
- **Terminal search** — `Ctrl+F` to search terminal scrollback with highlighted matches, case sensitivity and regex toggles
- **File tree** — sidebar with material file icons, search filter, lazy-loaded directories, git status indicators, drag-and-drop to move files/folders
- **Code editor** — CodeMirror 6 with syntax highlighting for JS, TS, Rust, Python, Go, C, C++, Java, HTML, CSS, JSON, YAML, Markdown, Dart, TOML, Shell
- **Markdown preview** — toggle between edit and rendered preview for `.md` files
- **Dynamic tab names** — terminal tabs update to show the running process
- **Tab icons** — material file-type icons for file tabs, terminal icon for shells
- **Quick open** — `Ctrl+P` fuzzy file finder across the entire project
- **Find in files** — `Ctrl+Shift+F` project-wide text search with highlighted results
- **Image preview** — opens PNG, JPG, GIF, WebP, BMP, ICO, AVIF, TIFF with dimensions and file size
- **File operations** — right-click context menu for new file, new folder, rename (with undo), delete, copy path, open in file manager
- **Auto-save & crash recovery** — files auto-save after editing (configurable delay), swap files recover unsaved work after a crash
- **Live file reload** — files edited externally (e.g. from the terminal) auto-update in the editor
- **Recent folders** — welcome screen shows last 5 opened projects for quick access, individually removable
- **Zoom** — `Ctrl+`/`Ctrl-` to adjust font size, `Ctrl+0` to reset
- **Keyboard-driven** — full shortcut set for tabs, files, and navigation
- **Drag and drop** — drop a folder to open it, drop a file to open or paste its path into the terminal; drag files/folders in the tree to move them (with undo)
- **LSP diagnostics** — auto-detects project language and shows errors/warnings in a resizable problems panel (Dart, Rust, Go, Python, C/C++, TypeScript)
- **Flutter-aware** — auto-detects Flutter projects, provides emulator launcher (warm + cold boot)
- **Multi-instance** — run multiple Volt windows for different folders; opening the same folder in a second instance focuses the existing one
- **Settings panel** — `Ctrl+,` opens settings UI with visual controls and a raw JSON editor
- **Session persistence** — remembers window state, open tabs (files + terminals), cursor positions, and restores them per folder
- **Cross-platform** — Windows, macOS, Linux
- **Zero telemetry** — no analytics, no crash reports, no network requests

## Installation

### Download

Grab the latest release from the [Releases](https://github.com/heyuforia/volt/releases) page:

- **Windows** — `.exe` (portable) or `.msi` (installer)
- **macOS** — `.dmg` (see note below)
- **Linux** — `.deb` or `.AppImage`

#### macOS: "App is damaged" fix

macOS blocks apps that aren't signed with an Apple Developer certificate. After installing, if you see _"Volt.app is damaged and can't be opened"_, run this in Terminal:

```bash
xattr -cr /Applications/Volt.app
```

Then open Volt normally. This only needs to be done once.

### Build from source

Requires [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/), and platform-specific dependencies for [Tauri v2](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/heyuforia/volt.git
cd volt
npm install
cargo tauri build
```

The binary will be at `src-tauri/target/release/volt`.

For development with hot reload:

```bash
npm install
cargo tauri dev
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open folder |
| `Ctrl+Shift+O` | Close folder |
| `Ctrl+P` | Quick open file |
| `Ctrl+S` | Save file |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+F` | Search in terminal / Find in file |
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+Shift+D` | Split terminal horizontally |
| `Ctrl+Shift+E` | Split terminal vertically |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+C` | Copy selection in terminal (SIGINT if no selection) |
| `Ctrl+V` | Paste into terminal |
| `Ctrl+Backspace` | Delete word backward in terminal |
| `Shift+Enter` | Newline in terminal (for Claude Code) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+Left` / `Alt+Right` | Next / previous tab (fallback) |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out |
| `Ctrl+0` | Reset zoom |

## Configuration

Volt stores config at `~/.volt/config.json`. Open the settings panel with `Ctrl+,`.

| Setting | Default | Description |
|---|---|---|
| `terminal.fontSize` | `14` | Font size for terminals and editor |
| `terminal.scrollback` | `5000` | Terminal scrollback buffer lines |
| `terminal.shell` | System default | Shell executable path |
| `editor.autoSave` | `true` | Auto-save files after editing |
| `editor.autoSaveDelay` | `1500` | Milliseconds after last edit before auto-saving |
| `ignoredPatterns` | `.git`, `build`, `.dart_tool`, `node_modules`, `.gradle`, `target` | Folders/files to hide from the file tree |
| `lspServers` | `{}` | Override LSP server commands per language (e.g. `{ "python": { "command": "pyright-langserver", "args": ["--stdio"] } }`) |

## Tech Stack

- **[Tauri v2](https://v2.tauri.app)** — Rust backend + native webview frontend
- **[xterm.js](https://xtermjs.org)** — Terminal emulator
- **[CodeMirror 6](https://codemirror.net)** — Code editor
- **[portable-pty](https://docs.rs/portable-pty)** — Cross-platform PTY management
- **Vanilla JS** — No React, Vue, Angular, or Svelte

## License

[MIT](LICENSE)
