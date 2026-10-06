# AI Terminal for Obsidian

A desktop-only (macOS) Obsidian plugin that opens terminal panels inside Obsidian so you can run
**Claude Code** (`claude`), the **Antigravity CLI** (`agy`) or your login shell, started in the vault folder.
A local bridge lets the AI read the note you have open, your selection, and Obsidian's links, and open notes.

Status: under construction (see `specs/obsidian-ai-terminal/spec.md`).

## Requirements

- macOS, Obsidian desktop 1.8 or newer
- Python 3.9+ (`/usr/bin/python3` from the Command Line Tools or Homebrew `python3`) — runs the terminal helper
- `claude` and/or `agy` installed and on your login-shell `PATH`
- Node.js 22+ to build

## Build

```sh
npm install
npm run build        # → dist/: main.js, manifest.json, styles.css and the Python helper scripts
npm run dev          # rebuild dist/ on every change
npm test             # vitest + Python unittest suites (Python 3.9 and your python3)
npm run typecheck
```

## Install into a vault

```sh
npm run install-plugin -- ~/Documents/Notes
```

This copies `dist/` into `<vault>/.obsidian/plugins/obsidian-ai-terminal/` (your `data.json` settings are kept).
Then in Obsidian: Settings › Community plugins → turn off Restricted mode if needed → enable **AI Terminal**.

If the script reports **"Operation not permitted"**, macOS is blocking your terminal app from the vault folder:
allow it under System Settings › Privacy & Security › Files and Folders (or Full Disk Access) and run the command
again, or copy the files from `dist/` into the plugin folder with Finder (Cmd+Shift+. shows the hidden `.obsidian`).

## Usage

<!-- Filled in as features land. -->

## Settings

Placement of new panels, the command and arguments of each profile (Claude Code, Antigravity, Shell), Python path,
font, scrollback, Option-as-Meta, the bridge / IDE connection / Antigravity bridge switches and AI session snapshots.

## Safety

<!-- T11: not typing in a note the AI is editing, File Recovery, `agy mcp remove obsidian`, snapshot history after a vault move. -->

## Development

- `src/main.ts` wires the feature modules (`src/*/index.ts`, `*Module.ts`) through the shared extension points in
  `src/core/` (services, spawn contributors, keyboard hooks, bridge routes, session events, ready gate).
- Every `src/**/*.py` that is not a test (`test_*.py`) or inside a `tests/` / `fixtures/` folder is copied flat into `dist/`.
- Tests never touch your real home folder: vitest and the Python runner use a temporary `HOME`.
