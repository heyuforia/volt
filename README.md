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

- **Multi-tab terminals** — split your workflow across multiple terminal sessions with drag-to-reorder tabs
- **File tree** — sidebar with material file icons, search filter, lazy-loaded directories
- **Code editor** — CodeMirror 6 with syntax highlighting for JS, TS, Rust, Python, Go, C, C++, Java, HTML, CSS, JSON, YAML, Markdown, Dart, TOML, Shell
- **Markdown preview** — toggle between edit and rendered preview for `.md` files
- **Dynamic tab names** — terminal tabs update to show the running process
- **Tab icons** — material file-type icons for file tabs, terminal icon for shells
- **Quick open** — `Ctrl+P` fuzzy file finder across the entire project
- **Find in files** — `Ctrl+Shift+F` project-wide text search with highlighted results
- **File operations** — right-click context menu for new file, new folder, rename, delete
- **Auto-save & crash recovery** — files auto-save after editing (configurable delay), swap files recover unsaved work after a crash
- **Live file reload** — files edited externally (e.g. from the terminal) auto-update in the editor
- **Recent folders** — welcome screen shows last 5 opened projects for quick access
- **Zoom** — `Ctrl+`/`Ctrl-` to adjust font size, `Ctrl+0` to reset
- **Keyboard-driven** — full shortcut set for tabs, files, and navigation
- **LSP diagnostics** — auto-detects project language and shows errors/warnings from Dart, Rust, Go, Python, C/C++, or TypeScript language servers
- **Flutter-aware** — auto-detects Flutter projects, provides emulator launcher (warm + cold boot)
- **Single instance per folder** — opening a folder that's already open in another Volt window focuses that window instead
- **Settings panel** — `Ctrl+,` opens settings UI with visual controls and a raw JSON editor
- **Session persistence** — remembers window state, open tabs (files + terminals), cursor positions, and restores them per folder
- **Cross-platform** — Windows, macOS, Linux
- **Zero telemetry** — no analytics, no crash reports, no network requests

## Installation

### Download

Grab the latest release from the [Releases](https://github.com/heyuforia/volt/releases) page:

- **Windows** — `.exe` (portable) or `.msi` (installer)
- **macOS** — `.dmg`
- **Linux** — `.deb` or `.AppImage`

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
| `Ctrl+P` | Quick open file |
| `Ctrl+S` | Save file |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+F` | Find in current file |
| `Ctrl+Shift+T` | New terminal |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+C` | Copy selection in terminal (SIGINT if no selection) |
| `Ctrl+V` | Paste into terminal |
| `Ctrl+Backspace` | Delete word backward in terminal |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+` / `Ctrl-` | Zoom in / out |
| `Ctrl+0` | Reset zoom |

## Configuration

Volt stores config at `~/.volt/config.json`. Settings are accessible via the gear icon in the status bar.

| Setting | Default | Description |
|---|---|---|
| `terminal.fontSize` | `14` | Font size for terminals and editor |
| `terminal.scrollback` | `5000` | Terminal scrollback buffer lines |
| `terminal.shell` | System default | Shell executable path |
| `editor.autoSave` | `true` | Auto-save files after editing |
| `editor.autoSaveDelay` | `1500` | Milliseconds after last edit before auto-saving |
| `ignoredPatterns` | `.git`, `build`, `.dart_tool`, `node_modules`, `.gradle`, `target` | Folders/files to hide from the file tree |

## Tech Stack

- **[Tauri v2](https://v2.tauri.app)** — Rust backend + native webview frontend
- **[xterm.js](https://xtermjs.org)** — Terminal emulator
- **[CodeMirror 6](https://codemirror.net)** — Code editor
- **[portable-pty](https://docs.rs/portable-pty)** — Cross-platform PTY management
- **Vanilla JS** — No React, Vue, Angular, or Svelte

## License

[MIT](LICENSE)
