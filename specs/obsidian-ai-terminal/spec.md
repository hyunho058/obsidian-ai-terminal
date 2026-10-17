# Spec: obsidian-ai-terminal

## Meta
- **Created**: 2026-10-05
- **Type**: dev
- **Status**: approved
- **Approved by**: user
- **Approved at**: 2026-10-05

## Goal
"I'd like to use claude code, antigravity CLI on Obsidian like terminal. Could you create plugin??"
Follow-ups: "I'd like to control and analyze the documents on the Obsidian."

## Non-goals
- Mobile (iOS / Android) support — mobile Obsidian cannot spawn processes.
- Windows and Linux support (Mac only for this version).
- A custom AI chat UI — the plugin hosts the existing `claude` / `agy` CLIs; it does not reimplement them.
- Publishing to the Obsidian community plugin store — personal use, installed manually into the user's vaults.

## Confirmed Goal
A desktop-only (macOS) Obsidian plugin that embeds a fully working terminal panel inside Obsidian, so the user can run Claude Code (`claude`) and the Antigravity CLI (`agy`) — and a plain shell — started in the vault folder, to analyze and edit their notes.

Scope (confirmed):
1. **Terminal (level 1)** — a terminal panel that supports full-screen interactive TUIs (colors, menus, cursor control, resize); one-click commands to launch Claude Code, Antigravity, or a shell in the vault folder; correct keyboard handling (Obsidian hotkeys do not steal keys while the terminal is focused; Shift+Enter inserts a newline); more than one terminal can be open at once (e.g. Claude and Antigravity side by side).
2. **Obsidian bridge (level 2)** — tools the AI CLI can call to interact with the running Obsidian app: read the currently open note, read the selected text, open a note, and query Obsidian's link data (e.g. backlinks).

Done when: the plugin is installed in the user's vault; from inside Obsidian the user can launch Claude Code and Antigravity in a panel and use them fully; the AIs can read and edit vault notes and Obsidian reflects the changes; and Claude Code can use the bridge tools to read the open note / selection and open a note.

## Research

### Project
- Project directory is empty (no code, no `package.json`, not a git repo) — greenfield.

### Host environment (macOS, arm64)
- Obsidian app 1.14.4 (`~/Library/Application Support/obsidian/obsidian-1.14.4.asar`), installer 1.8.10, Electron 34.2.0 / Chrome 132 (`/Applications/Obsidian.app/.../Electron Framework`). Desktop plugins get Node.js `require` (`child_process`, `http`, `net`, `crypto`).
- Several vaults are registered (`~/Library/Application Support/obsidian/obsidian.json`), including ones in iCloud and Google Drive; the test vault is `~/Documents/MyVault`.
- macOS privacy (TCC) blocked the current terminal session from listing any vault ("Operation not permitted"); processes spawned by Obsidian should inherit Obsidian's own folder access — must be confirmed in-app.
- `claude` 2.1.290 and `agy` 1.2.17 are native Mach-O arm64 binaries in `~/.local/bin` — no Node needed to run them.
- PATH: with a GUI-like minimal env (`PATH=/usr/bin:/bin`) `claude` is NOT found; via `zsh -lic` both `claude` and `agy` resolve. Obsidian launched from the Dock gets the minimal env.
- Python: `/opt/homebrew/bin/python3` 3.14.5; `/usr/bin/python3` 3.9.6 (Command Line Tools at `/Library/Developer/CommandLineTools`).

### PTY feasibility (proof of concept, scratchpad `pty_bridge.py` + `poc.mjs`)
- A stdlib-only Python bridge (`pty.fork`, `select`, `TIOCSWINSZ` + `SIGWINCH`) spawned via Node `child_process.spawn` with stdio `[pipe, pipe, pipe, pipe]` (fd 3 = resize channel, `"cols,rows\n"`) runs both TUIs: Claude Code's trust prompt and Antigravity's sign-in/trust screens rendered with ANSI colors, alt-screen and cursor control.
- Resize 100x30 → 120x40 via fd 3 caused a full redraw at the new width.
- No native Node modules needed (avoids `node-pty` ABI rebuild against Electron 34).
- `agy` probes terminal capabilities on start: DECRQM (`CSI ? 2026 $ p`), kitty keyboard protocol (`CSI > 1 u`), modifyOtherKeys (`CSI > 4 ; 2 m`); it falls back when unanswered.
- Measured idle footprint: bridge ~15 MB / 0% CPU; `claude` ~200 MB; `agy` ~190 MB + 2 `npm` processes ~100 MB each (its configured stdio MCP servers, started via `npx`).

### MCP / IDE integration surfaces
- Claude Code: `claude mcp add` supports transports stdio / sse / http and scopes local / user / project; `--mcp-config <configs...>` loads MCP servers from JSON files or strings for one session; `--ide` auto-connects on startup if exactly one valid IDE is available (`claude --help`, `claude mcp --help`). `~/.claude/ide/` exists (empty — no IDE currently registered).
- Claude Code IDE protocol (used by VS Code / JetBrains): IDE runs an MCP server over WebSocket on 127.0.0.1, writes `~/.claude/ide/<port>.lock` with an auth token; Claude Code discovers it via `/ide` or `--ide` and receives open-file / selection context in real time.
- Antigravity CLI: `agy mcp add` supports types stdio / http (headers via `-H`); config stored globally at `~/.gemini/config/mcp_config.json`. No per-session `--mcp-config` flag in `agy --help`; a project-level MCP config is not confirmed.

### Libraries (npm latest, 2026-10-05)
- `obsidian` 1.13.1 (API types), `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-unicode11` 0.9.0, `@modelcontextprotocol/sdk` 1.32.1, `esbuild` 0.28.2.

### Obsidian API surfaces relevant to the bridge
- Panels: `ItemView` + `registerView`; vault path: `FileSystemAdapter.getBasePath()`; active note: `workspace.getActiveFile()`; selection: `workspace.activeEditor.editor.getSelection()`; open note: `workspace.openLinkText()`; links: `metadataCache.resolvedLinks` (backlinks derived by inverting it); hotkey isolation: keydown handling inside the view (stop propagation) / `Scope`.

### Prior art
- iansinnott/obsidian-claude-code-mcp — Obsidian plugin hosting the Claude Code IDE protocol (WebSocket + `~/.claude/ide/<port>.lock`) plus an HTTP MCP server for other clients (https://github.com/iansinnott/obsidian-claude-code-mcp).
- Community plugin "Claude Code IDE" (https://community.obsidian.md/plugins/claude-code-ide) and Transept-AI/obsidian-claude-code-ide-pro (https://github.com/transept-ai/obsidian-claude-code-ide-pro) — same IDE-protocol approach; bind 127.0.0.1, per-session random token.
- polyipseity "Terminal" community plugin — embedded terminal via a Python pseudoterminal helper (from memory; not verified this session).

## Decisions

> Complexity: **Complex** (6 signals) — external processes (`claude`, `agy`, `python3`, `git`); 3+ subsystems (terminal view + session registry, PTY helper, bridge = WebSocket IDE server + HTTP MCP server + agy shim, snapshots/restore, settings); session lifecycle (spawn → running → exited → restart; detach → reattach); async resources (child processes, two local servers, serialized git queue); multi-actor (user, Claude Code, Antigravity, Obsidian as bridge server); writes outside the vault (`~/.claude/ide/`, agy global MCP config, snapshot store).

### D1: Terminal panel opens in the right sidebar by default
- **Status**: resolved (round 1) — placement is also a setting: `right sidebar` (default) / `new tab` / `split below current note`
- **Rationale**: User chose right sidebar — the note stays fully visible next to the AI, like a chat panel. New tab and split-below were the alternatives; kept as a setting because the sidebar can be narrow for full-screen TUIs (see D20).

### D2: Entry points — ribbon icon + command palette
- **Status**: assumed
- **Rationale**: Commands `Open Claude Code`, `Open Antigravity`, `Open shell` in the command palette (assignable to hotkeys); one ribbon icon opens a small menu of the three. Rejected: a custom toolbar (not idiomatic Obsidian).

### D3: Three launch profiles, started in the vault root, commands editable
- **Status**: assumed
- **Rationale**: Profiles `claude`, `agy`, and the user's login shell. Working directory = vault root (`FileSystemAdapter.getBasePath()`). Each profile's command + arguments is editable in settings (e.g. add `--model`). Rejected: arbitrary user-defined profile lists (YAGNI for personal use).

### D4: Each terminal is its own Obsidian view; any number at once
- **Status**: assumed (revised after L2 review)
- **Rationale**: Each terminal is an `ItemView` with view state `{profile, panelId, sessionId}`; the process lives in the plugin-level session registry (D34), not in the view. In the right sidebar a new terminal opens as a new tab; the user can drag tabs to split Claude and Antigravity side by side or move a panel to another window — the session reattaches without restarting. Obsidian defers restored background tabs; a panel's program starts the first time the panel is shown. Rejected: one view with internal tabs (duplicates Obsidian's own tab/split system).

### D5: When the program exits, keep the panel and offer restart
- **Status**: resolved (round 1)
- **Rationale**: Panel stays open with output readable and prints `[Process exited with code N — press Enter to restart]`; Enter restarts the same profile in the same panel. Rejected: auto-close (loses crash output and the AI's last answer).

### D6: Build the spawn environment from the user's login shell
- **Status**: assumed (revised after L2 review; evidence: `zsh -lc` does NOT find `claude`/`agy`, `zsh -lic` does — `~/.zshrc` adds `~/.local/bin`; `LANG` is unset for a Dock-launched app; system locale `en_KR`)
- **Rationale**: On plugin load, run `$SHELL -lic` once without a PTY, printing the full environment between markers (`env -0`), 5 s timeout. Spawn env, in layers: `process.env` minus Electron/Chromium variables (`ELECTRON_*`, `CHROME_*`) → overlay the captured shell env → `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=obsidian-ai-terminal` → `LANG` if still unset: `<AppleLocale>.UTF-8` when that locale exists in `locale -a`, else `en_US.UTF-8` → per-profile bridge/snapshot variables (D27, D28, D31). Programs are spawned directly with this env; the shell profile runs `$SHELL -l`. If capture fails or times out: `process.env` with `~/.local/bin:/opt/homebrew/bin` prepended, plus a Notice. If a program still isn't found (ENOENT / exit 127), the panel shows a message pointing to the profile command in settings. Rejected: capturing only `PATH` (drops `LANG` → Korean mis-rendered in shell tools; drops API keys / proxy settings from rc files); wrapping every launch in `zsh -lic 'exec …'` (slower; rc-file output leaks into the TUI).

### D7: Python helper lookup order
- **Status**: assumed
- **Rationale**: Settings override → `python3` from the resolved PATH (Homebrew 3.14 here) → `/usr/bin/python3` (CLT 3.9.6). The helper uses only the stdlib and must run on Python ≥ 3.9. If none works, the panel shows how to install Python. Rejected: requiring a specific Python version.

### D8: PTY via a bundled stdlib-only Python helper that owns process shutdown
- **Status**: assumed (proven by PoC; shutdown revised after L2 review)
- **Rationale**: `pty_bridge.py` ships in the plugin folder; Node spawns it with stdio `[pipe, pipe, pipe, pipe]`; fd 3 carries resize messages. The program runs as the leader of a new session / process group inside the PTY, so Node cannot signal it reliably — the helper owns shutdown: on stdin EOF, SIGTERM/SIGHUP to the helper, or parent death (`getppid()` changes; checked every 1 s) it sends SIGHUP to the program's process group, waits 3 s, sends SIGKILL, then exits. This covers Obsidian quit, crash and force-quit (no orphaned `claude` / `agy` / `npx` processes). Rejected: `node-pty` (native module must be rebuilt for Obsidian's Electron ABI, breaks on Obsidian upgrades); `/usr/bin/script` (no resize support); Node-side kill timers (Node may be gone before they fire).

### D9: Terminal renderer — xterm.js 6 themed from Obsidian
- **Status**: assumed
- **Rationale**: `@xterm/xterm` 6 + `addon-fit` (auto-size to panel), `addon-web-links` (clickable URLs), `addon-unicode11` (emoji / CJK width — the user writes Korean). Colors come from Obsidian CSS variables and update on theme change (`css-change` event). Rejected: a hand-written renderer.

### D10: Keyboard routing (Mac conventions + Korean input)
- **Status**: assumed (revised after L2 review)
- **Rationale**: While a terminal is focused:
  - **IME first**: any key event during composition (`isComposing` or keyCode 229) is left to xterm.js's composition handling — Enter commits the Hangul syllable and is not sent as CR; the last syllable is never dropped.
  - **Cmd keys**: Cmd+C copies the terminal selection (no-op without one), Cmd+V pastes, Cmd+A selects all terminal text, Cmd+K clears screen + scrollback, Cmd+←/→ send Ctrl+A / Ctrl+E (line start / end), Cmd+W starts the close flow (D26). All other Cmd shortcuts pass through to Obsidian (Cmd+P, Cmd+O …).
  - **Option** acts as Meta by default (Option+←/→ = word left / right; Claude Code's Meta shortcuts work); setting `optionIsMeta` turns it off to type special characters.
  - **Shift+Enter** sends ESC + CR (newline inside Claude Code's input; Antigravity to verify).
  - Every other key goes to the terminal and never triggers Obsidian hotkeys.
- Rejected: letting Obsidian keep all hotkeys (breaks the Ctrl / Option keys TUIs need).

### D11: Bridge security
- **Status**: assumed (matches prior art)
- **Rationale**: Bridge listens on `127.0.0.1` only, on a random free port, and requires a random per-run token (`crypto.randomUUID()`) on every request; it stops when the plugin unloads. Rejected: fixed port / no token (any local process could read notes).

### D12: One bridge per open vault
- **Status**: assumed
- **Rationale**: Each vault window runs its own plugin instance and bridge; a CLI started in vault A gets vault A's connection info only. Rejected: a shared global bridge (would mix vaults).

### D13: Stack and packaging
- **Status**: assumed
- **Rationale**: TypeScript + esbuild in the standard Obsidian sample-plugin layout; `manifest.json` has `isDesktopOnly: true`; `obsidian` 1.13.x API types. Rejected: webpack/rollup (heavier, no benefit here).

### D14: MCP server implementation
- **Status**: assumed
- **Rationale**: `@modelcontextprotocol/sdk` 1.32.x server, running inside the plugin. Rejected: hand-rolled JSON-RPC (protocol details easy to get wrong).

### D15: Build output and install
- **Status**: provisional — this session is blocked by macOS privacy from writing into vault folders
- **Rationale**: `npm run build` writes `dist/` (`main.js`, `manifest.json`, `styles.css`, `pty_bridge.py`); `npm run install-plugin -- <vault path>` copies `dist/` into `<vault>/.obsidian/plugins/<id>/`. If blocked, the user grants folder access to the terminal app (System Settings › Privacy & Security › Files and Folders) or copies `dist/` in Finder.

### D16: Target vault
- **Status**: assumed
- **Rationale**: Install and test in the test vault `~/Documents/MyVault` first; nothing vault-specific is hard-coded, so it works in any vault.

### D17: macOS folder permission for spawned programs
- **Status**: assumed
- **Rationale**: Programs spawned by Obsidian should use Obsidian's own folder access. Verified on the first in-app run; if macOS shows a permission prompt, the user allows it.

### D18: Settings shape
- **Status**: assumed
- **Rationale**: `{ placement, profiles: { claude: {command, args}, agy: {command, args}, shell: {command, args} }, pythonPath, fontFamily, fontSize, scrollback (default 10000), optionIsMeta (default true, D10), bridgeEnabled, ideConnectionEnabled (D27a), agyBridgeEnabled (D28), snapshots: { enabled: boolean | null (null = not asked yet) } (D31) }` stored per vault via `loadData` / `saveData`.

### D19: Notes are identified by vault-relative paths
- **Status**: assumed
- **Rationale**: Bridge tools take and return paths relative to the vault root (e.g. `Projects/idea.md`) — the same form Obsidian uses internally and the CLIs see from their working directory. Rejected: absolute paths (leak home-directory layout, differ per machine).

### D20: Narrow sidebar
- **Status**: assumed
- **Rationale**: `addon-fit` recalculates columns/rows on every panel resize and sends them to the PTY, so TUIs reflow at any width; if the sidebar is too narrow, the user widens it or switches placement in settings (D1). Rejected: forcing a sidebar width via private Obsidian APIs.

### D21: Panels come back after restart and continue their own conversation
- **Status**: resolved (round 2) for Claude Code and shell; provisional for Antigravity
- **Rationale**: User chose "continue last chat"; the same rule applies to Enter-to-restart (D5). View state `{profile, panelId, sessionId}` is restored by Obsidian's workspace layout. **Claude Code**: a new panel generates a UUID and starts `claude --session-id <uuid>`; restore / restart follows D22, so two Claude panels in one vault each resume their own chat. **Duplicates**: a view whose `panelId` is still attached to another open view 1 s after it attached (tab menu "Split", "Open in new window") gets a new `panelId` and a fresh session; if the other view detaches within that second it was a move, and the session is kept (D34). Rejected: `claude --continue` (most recent conversation in the directory → panels collide). **Antigravity**: `agy --conversation <ID>` exists but no flag sets the ID at start; until the ID can be discovered (Known Gap), restore uses `agy --continue`. **Shell**: starts fresh.

### D22: Resume is checked, not guessed
- **Status**: assumed (revised after L2 review ×2)
- **Rationale**: **Claude Code**: before resuming, look for `~/.claude/projects/*/<uuid>.jsonl` and read its recorded `cwd` (verified: transcripts store `"cwd"` and `"sessionId"`). Comparison: `realpath` + Unicode NFC of the **first** entry that has a `cwd` (any `cwd` inside the vault also counts — Claude may `cd` into subfolders) against `realpath` + NFC of the vault path (handles symlinks and NFC/NFD Korean folder names). Match → `claude --resume <uuid>`. Not found → `claude --session-id <uuid>` (fresh conversation under the same ID, no error). Found but `cwd` differs (vault moved / renamed, path alias) → generate a new UUID, start fresh, and print one line `[Previous conversation belongs to another folder — starting a new one]`. An early exit for any other reason (auth, network, crash) shows the normal exit prompt (D5) and never replaces the session ID. **Antigravity** (no lookup possible yet): if `agy --continue` exits non-zero within 5 s, print `[Previous conversation not found — starting a new one]` and start plain `agy`. Rejected for Claude: the "exits non-zero within 5 s" rule (misreads auth / network failures as "not found" and orphans valid conversations); computing the project folder name from the path (escaping rules for spaces / `~` in iCloud paths are not documented).

### D23: Note edits go through files; the bridge does not write to the editor
- **Status**: resolved (round 2)
- **Rationale**: User chose "edit the file" — the CLI edits the `.md` file with its own tools (Claude Code shows a diff and asks permission); Obsidian reloads the changed file. Rejected: bridge editor-write tools (replace selection / insert at cursor) — more surface, and a second editing path to keep consistent.

### D24: Bridge tool set (read-only + open), based on the last note editor
- **Status**: assumed (revised after L2 review)
- **Rationale**: "Active note" = the **last focused note editor**: the plugin tracks `active-leaf-change` and remembers the last `MarkdownView`, ignoring its own terminal views — so clicking into a terminal does not clear it. Selection and cursor are read from that editor even while it is not focused (CodeMirror keeps its selection). Tools: `get_active_note` → `{path, content, cursorLine}`; `get_selection` → `{path, text, fromLine, toLine}` or `{text: ""}`; `list_open_notes` → `[{path, active}]`; `open_note(path, line?)` → opens the note in the main editor area (never inside the terminal's sidebar), scrolled to `line`; `get_links(path)` → `{outgoing: [path], backlinks: [path]}` from `metadataCache.resolvedLinks`. Paths vault-relative (D19). Full-text search is left to the CLIs. If no note editor has been focused yet, tools return an empty result with a `reason`.

### D25: Simultaneous edits to the same note
- **Status**: assumed
- **Rationale**: If the user types in a note while the AI edits that file, Obsidian's built-in external-change reload applies; Obsidian's core File Recovery snapshots are the safety net. README advises not typing in a note the AI is editing. Rejected: file locking (Obsidian has no API for it).

### D26: Closing a running terminal asks first
- **Status**: resolved (round 5; revised after L2 review ×2)
- **Rationale**: User chose "ask while running". Only **user-initiated** closes ask:
  - **Single close** of a panel whose program is running — Cmd+W in the terminal, the tab's close button, "Close" in the tab menu — shows "<Claude Code | Antigravity | Shell> is still running — stop it and close? [Stop and close] [Cancel]".
  - **Batch close** ("Close others", "Close all") — one combined dialog listing the running panels.
  - **No dialog**: Obsidian quit, popout-window close, workspace-layout load, plugin disable / unload — these stop sessions through the registry (D34). Moving a panel (drag to another split or window) is not a close: the session reattaches.
  - After the program has exited, the panel closes immediately. Stopping = the helper's shutdown sequence (D8).
- **Implementation**: Cmd+W is handled in the terminal key handler; tab-close paths by wrapping `WorkspaceLeaf.detach` for terminal views, grouping detaches in the same tick into one batch and skipping the dialog while a quit / window close / layout load / unload is in progress (detection to verify — Known Gaps).
- Rejected: closing immediately (loses the reply in progress and half-finished multi-file edits).

### D27: Bridge = Claude Code IDE connection + HTTP MCP tools server
- **Status**: resolved (round 3; revised after L2 review ×2)
- **Rationale**: User wants Claude to see the selection automatically (like VS Code). Two transports share one Obsidian state reader (D24):
  - **(a) IDE connection (Claude Code only)** — WebSocket MCP server on `127.0.0.1`, random port; lock file `~/.claude/ide/<port>.lock` (mode 0600) with `{pid, workspaceFolders: [vaultPath], ideName: "Obsidian", transport: "ws", authToken}`, removed on unload. Claude panels are started with `--ide` and `CLAUDE_CODE_SSE_PORT=<wsPort>` in their environment (name verified in the Claude Code binary) so each panel connects to its own vault's server; the lock file's `pid` is the Obsidian process that spawns the panels (`process.pid`, an ancestor of every `claude` it starts, also used by D29's liveness check); `/ide` discovery through the lock file still works for Claude started outside Obsidian (D30). Served: MCP `initialize`, `tools/list` → no tools, and the `selection_changed` notification — sent (debounced 300 ms) only when the last note editor's selection or file changes; focus moving into a terminal never sends an empty selection. **Not offered**: `openDiff`, `close_tab`, `closeAllDiffTabs`, `getDiagnostics`, save / dirty-check methods — so Claude Code keeps diffs and permission prompts in the terminal (D23). Payload format follows prior-art plugins / the VS Code extension (verify against Claude Code 2.1.290). The IDE protocol uses absolute file paths; D19 applies to the MCP tools.
  - **(b) HTTP MCP server (both CLIs)** — Streamable HTTP at `http://127.0.0.1:<port>/mcp`, Bearer token, serving the D24 tools, plus `POST /snapshot` used by the D31 hooks.
- **Rejected**: IDE-only (custom tools on the IDE connection may not be exposed to the model, and agy can't use it); HTTP-only (no automatic selection — user chose automatic).
- **Steelman against (a)**: the IDE protocol is not a published third-party contract; a Claude Code update could change it and silently break auto-selection. **Mitigation**: (b) stays the source of truth for all tools, so if (a) fails Claude still reads the selection via `get_selection`; (a) is isolated in one module behind `ideConnectionEnabled`.

### D28: How each CLI gets the bridge's connection info
- **Status**: resolved for Claude Code; provisional mechanism for Antigravity (user chose: agy gets the bridge)
- **Rationale**:
  - **Claude Code**: per spawn, `--mcp-config '<inline JSON>'` (HTTP URL + `Authorization: Bearer <token>`), `--settings '<inline JSON>'` carrying the D31 hook, `--ide`, and env `CLAUDE_CODE_SSE_PORT` (D27a) — no change to Claude's global or project config.
  - **Antigravity**: one static global stdio entry `obsidian` running `<absolute python3 path from D7> ~/.config/obsidian-ai-terminal/mcp_shim.py`. The shim reads `OBSIDIAN_BRIDGE_URL` / `OBSIDIAN_BRIDGE_TOKEN` from its environment (set when the plugin spawns agy) and proxies MCP JSON-RPC to the HTTP bridge; without them (agy started outside Obsidian) it silently answers `tools: []`. Footprint: every agy session on this Mac starts this small (~15 MB) shim.
  - **Lifecycle**: on load (if `agyBridgeEnabled`), under the lock file `~/.config/obsidian-ai-terminal/agy-config.lock`, run `agy mcp list` and `agy mcp add` only if `obsidian` is missing or its command differs — idempotent and safe with two vault windows loading at once. Turning `agyBridgeEnabled` off runs `agy mcp remove obsidian`. Plugin removal can't be detected; the README documents `agy mcp remove obsidian`. The shim file is copied to its stable path on load.
  - **Fallback** (if agy does not pass its environment to stdio servers): per-vault HTTP entries `obsidian-<vault>` with a stable per-vault port + token kept in plugin data.
- **Rejected**: rewriting a single global HTTP entry on every load (breaks with two vaults open, races); hand-editing the JSON (other entries hold secrets).

### D29: Clean up stale IDE lock files
- **Status**: assumed
- **Rationale**: If Obsidian crashes, its lock file stays behind and Claude Code could try a dead port. On load, the plugin deletes `~/.claude/ide/*.lock` files with `ideName: "Obsidian"` whose `pid` is no longer alive. Never touches other IDEs' lock files.

### D30: Any Claude Code on this Mac may use the IDE connection
- **Status**: resolved (inversion probe)
- **Rationale**: User sees it as a bonus — `claude` started in the Terminal app inside the vault folder can also connect to Obsidian (`/ide`). No extra caller checks beyond the lock-file token. Rejected: restricting to plugin-spawned processes (extra complexity, no benefit for a single-user Mac).

### D31: Snapshot the vault before every message to the AI
- **Status**: resolved (inversion probe + round 5; revised after L2 review ×2)
- **Rationale**: User chose a restore point per message.
  - **Change hint**: a "vault may have changed" flag is set on plugin load, when snapshots are turned on, and on every vault `modify` / `create` / `delete` / `rename` event; it is cleared when a snapshot **starts**. The flag only decides whether to try; git decides whether there is anything to commit (`git add -f -A <pathspecs>` then `git diff --cached --quiet` → nothing to commit = no snapshot). Changes Obsidian doesn't report (sync while Obsidian was closed, dot-folders) are caught by the set-on-load rule. The store enables `core.untrackedCache` to keep the scan fast.
  - **Claude Code**: a `UserPromptSubmit` hook passed per session via `--settings` runs `<python3> ~/.config/obsidian-ai-terminal/snapshot_hook.py`, which `POST`s `{panelId, prompt excerpt}` to the bridge's `/snapshot` and waits at most 10 s; it always exits 0 with no output.
  - **Antigravity** (no prompt-submit hook confirmed): in agy panels the terminal intercepts Enter (outside IME composition); if the flag is set it holds the Enter up to 2 s while the snapshot runs. Keys and pastes typed during the hold are queued behind the Enter and sent in order. If the hold expires first, the panel prints `[Snapshot still running — it may include this message's changes]`.
  - **At spawn** (new, restored, restarted AI panel): one snapshot attempt if the flag is set.
  - **Queue + timeout**: one serialized git queue. The 10 s timeout only means "stop waiting" — git keeps running in the queue and is never killed (killing would leave `index.lock` and wedge every later snapshot). On failure the panel prints `[Snapshot failed: <reason> — this message is not protected]` and the session continues. A stale `.git/index.lock` in the store is removed only when the plugin's own git is not running. If `/usr/bin/git --version` fails, snapshots are disabled with a Notice.
  - **First snapshot**: when the user enables snapshots, the first full snapshot runs in the background right away (a large or cloud vault may take longer than 10 s).
  - **Commit**: message `Before Claude Code: "<first 60 chars of the prompt>" — <YYYY-MM-DD HH:mm>` (agy: `Before input in Antigravity — …`); identity set per command (`-c user.name="Obsidian AI Terminal" -c user.email=noreply@localhost`). Tracked: `*.md`, `*.canvas`, `*.base`; excluded: `.obsidian/`, `.trash/`, attachments.
  - **First use per vault**: a one-time prompt "Enable AI session snapshots for this vault?"; spawns wait for the answer; dismissing it = no snapshot this time and ask again next launch; the answer is stored in `snapshots.enabled`. Shell panels never snapshot.
- **Rejected**: one snapshot per session (a sidebar panel can live for days → stale restore point mixed with the user's own edits); snapshot after replies (can't recover the pre-reply state); trusting vault events alone (misses changes made while Obsidian was closed → a restore would silently revert them); killing git on timeout (wedges the store).

### D32: Snapshot history lives outside the vault
- **Status**: resolved (round 4)
- **Rationale**: History store per vault at `~/.local/share/obsidian-ai-terminal/snapshots/<sha256(vaultPath)[:16]>.git`, used via `git --git-dir=<store> --work-tree=<vault>`; the vault path is recorded in the store's config. Files are staged with `git add -f -A` and explicit pathspecs (`*.md`, `*.canvas`, `*.base`, plus `:(exclude).obsidian/**` and `:(exclude).trash/**`), so `.gitignore` files inside the vault cannot silently drop notes. Nested git repositories inside the vault cannot be snapshotted (git limitation) and are reported once in a Notice. Not synced by iCloud / Google Drive, and never touches a `.git` the user keeps in the vault. If the vault is moved or renamed, history starts fresh (documented). Rejected: `.git` inside the vault (cloud sync of thousands of small files can corrupt it, and it would mix with the user's own git).

### D33: "Restore notes from before an AI session…" command
- **Status**: resolved (round 4; revised after L2 review)
- **Rationale**: Command opens a modal listing snapshots newest-first (time, which AI, prompt excerpt, number of files changed since). Choosing one shows the changed files with checkboxes (all ticked; the user can untick notes they edited themselves). If AI panels are running, the modal warns: "N AI panels are running — they may overwrite restored notes and still remember the old content. [Stop them and restore] [Restore anyway] [Cancel]". Confirm → the plugin first takes a `Before restore` snapshot (so the restore itself is undoable), then restores modified / deleted files to the snapshot version and moves files created after the snapshot to Obsidian's trash (`.trash/`). Rejected: no UI / "ask the AI" (user wants a direct command).

### D34: Sessions live in a plugin-level registry; views attach to them
- **Status**: assumed (L2 review; revised after L2 review ×2)
- **Rationale**: A `SessionRegistry` keyed by `panelId` owns each helper process, its state (`starting | running | exited`) and a **headless terminal mirror** (`@xterm/headless` 6.0.0) fed with all program output and resized together with the PTY on every resize (so lines wrap at the same width); the mirror's own replies to terminal queries are discarded (the visible xterm answers them). A view attaches to its session on open and detaches on close. Detach starts a 2 s grace timer: if a view with the same `panelId` attaches within it (drag to another split / window, view re-creation), the new view's xterm is first sized to the mirror's size and restored from it with `@xterm/addon-serialize` 0.14 (screen, scrollback and terminal modes — bracketed paste, application cursor keys, mouse tracking, alt screen), then fitted to the new view and a redraw is forced by resizing one column smaller and back (same-size `TIOCSWINSZ` sends no SIGWINCH) — no restart, no snapshot, no lost reply; otherwise the session is stopped (D8). Every spawn waits for the plugin's ready signal (shell env captured, bridge servers listening, stale lock files cleaned, agy entry ensured). Rejected: the view owning the process (any view re-creation kills the reply in progress); replaying a raw output ring buffer (loses terminal modes whose escape sequences scrolled out, can start mid-sequence → multi-line paste submits line by line, arrow keys break); re-parenting the xterm element (breaks across popout windows, which have their own `document`).

### D35: One-time hint to show Claude's edit diffs in the terminal
- **Status**: resolved (user decision during implementation, 2026-10-07)
- **Rationale**: T7 found (Claude Code 2.1.292) that while Claude is connected to an IDE and its global setting `diffTool` is `"auto"` (the default — unset counts as auto), Claude hides the edit diff in the terminal ("Opened changes in Obsidian ⧉") and sends it to the IDE's `openDiff`; Yes/No still work in the terminal. `diffTool` exists only in Claude's global config, with no env or `--settings` override. User chose a one-time hint: before the first Claude panel in a vault starts with the IDE connection on, the plugin reads Claude's global config read-only (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`); if `diffTool` is not `"terminal"`, the panel prints once: `Tip: to see Claude's edit diffs here, run /config → Diff tool → terminal (one time).` The hint is remembered per vault (`settings.moduleData`) and never repeated; the plugin never writes Claude's config. Rejected: implementing `openDiff` as a read-only diff tab in Obsidian (undocumented protocol, more work); accepting hidden diffs.

## Constraints
- macOS + Obsidian desktop only; `manifest.json` `isDesktopOnly: true`.
- No native Node modules (no `node-pty`) — the plugin must load on Obsidian's Electron without rebuilding anything.
- PTY helper, agy MCP shim and snapshot hook use the Python standard library only and must run on Python ≥ 3.9.
- Bridge listens on `127.0.0.1` only; every HTTP and WebSocket request requires the per-run random token; lock files are mode 0600; tokens never appear in logs, notices or snapshot messages.
- Never hand-edit `~/.gemini/config/mcp_config.json` (holds other servers' secrets) — only `agy mcp add` / `agy mcp remove`, under the plugin's lock file.
- Never change Claude Code's global or project config — Claude gets the bridge and hook per session via `--mcp-config`, `--settings` and environment variables.
- Never modify or delete another IDE's lock file in `~/.claude/ide/` — only files with `ideName: "Obsidian"` whose `pid` is dead.
- Never touch a `.git` inside a vault; snapshot history lives only in the external store (D32) and never uses the user's git identity.
- The bridge never writes to the editor or note files (D23); its only side effects are opening a note (D24) and taking a snapshot (D31).
- Bridge MCP tool paths are vault-relative (D19).
- Custom key handling must never break IME composition — Korean input works exactly as in a normal text field (D10).
- A snapshot delays a prompt by at most 10 s (Claude hook) or 2 s (agy Enter hold), and a failed or slow snapshot never stops a prompt or a session start (D31). The plugin never kills a running git process.
- Every spawned process ends when its session stops, the plugin unloads, or Obsidian quits or crashes — enforced by the helper (D8).

## Known Gaps
- L2 provisional: Core Behavior — per-panel conversation identity for Antigravity: `agy --conversation <ID>` exists but no flag sets the ID at start, and how to learn a session's ID is unknown. Until found, restore uses `agy --continue` (two agy panels in one vault may resume the same chat).
- L2 provisional: Data Model — whether `agy` passes its environment to stdio MCP servers (needed for the D28 shim). Verify first; fallback = per-vault HTTP entries with a stable port + token.
- L2 provisional: Implementation — installing into a vault is blocked from this session by macOS privacy ("Operation not permitted"); the user grants folder access to the terminal app or copies `dist/` manually (D15).
- agy prompt-submit hook: agy has hooks (`hooks.json`, `PreToolUse` seen in the binary) but no prompt-submit event was confirmed; agy panels use Enter interception for snapshots (D31), which can also fire on Enter in agy's menus / permission prompts when notes changed (harmless extra snapshot).
- Verify in-app: processes spawned by Obsidian can read and write the vault without a permission error (D17).
- Verify against Claude Code 2.1.290 (D27a — undocumented; use prior-art plugins as reference): lock-file fields, WebSocket auth header, `selection_changed` payload; that `--ide` + `CLAUDE_CODE_SSE_PORT` make a panel connect to its own vault's server with `TERM_PROGRAM=obsidian-ai-terminal` (no impersonation of VS Code); and that Claude Code keeps diffs in the terminal when `openDiff` is not offered.
- Verify: how Obsidian sequences attach / detach when a panel is dragged to another split or popout window (new view first or old view first) — the 1 s duplicate rule (D21) and 2 s reattach grace (D34) assume both happen within that window.
- Verify: which Obsidian paths call `WorkspaceLeaf.detach` (single close, Close others / all, popout-window close, workspace-layout load, plugin unload, app quit) and how to tell them apart, so only user-initiated closes ask (D26).
- Verify: `@xterm/addon-serialize` 0.14 restores bracketed-paste, application-cursor and mouse-tracking modes and the alt screen into a fresh xterm (D34).
- Verify: the Shift+Enter newline sequence works in `agy` (D10).

## Requirements

### R0: Run Claude Code and Antigravity inside Obsidian to work on notes
**Covers**: Confirmed Goal, D16

#### R0.1: "Open Claude Code" shows Claude Code's interactive UI in the vault folder
- **Given**: the plugin is installed and enabled in the vault `~/Documents/MyVault`
- **When**: the user runs the command "Open Claude Code"
- **Then**: a terminal panel opens in the right sidebar showing Claude Code's interactive UI, and Claude Code's working directory is the vault root

#### R0.2: "Open Antigravity" shows the Antigravity UI in the vault folder
- **Given**: the plugin is installed and enabled in the vault
- **When**: the user runs the command "Open Antigravity"
- **Then**: a terminal panel opens showing the `agy` interactive UI with the vault root as working directory

#### R0.3: An AI edit to a note appears in Obsidian's editor
- **Given**: a Claude panel is open and note `X.md` is open in the editor
- **When**: Claude edits `X.md` and the user approves the edit
- **Then**: Obsidian's editor shows the new content of `X.md` without a manual reload

#### R0.4: Claude answers about the text selected in Obsidian
- **Given**: lines in note `X.md` are selected and the user clicks into the Claude panel
- **When**: the user types "explain the selected text" and presses Enter
- **Then**: Claude Code shows the selection indicator for `X.md` and its answer is about the selected text

### R1: Opening terminal panels
**Covers**: D1, D2, D3, D4, D20

#### R1.1: Command palette lists the plugin commands
- **Given**: the plugin is enabled
- **When**: the user opens the command palette and types "AI Terminal"
- **Then**: "Open Claude Code", "Open Antigravity", "Open shell" and "Restore notes from before an AI session…" are listed

#### R1.2: Ribbon icon opens a profile menu
- **Given**: the plugin is enabled
- **When**: the user clicks the plugin's ribbon icon and picks "Antigravity"
- **Then**: a menu with Claude Code / Antigravity / Shell was shown and an Antigravity panel opens

#### R1.3: Default placement is a new right-sidebar tab with focus
- **Given**: setting `placement` = right sidebar (default)
- **When**: the user runs "Open Claude Code"
- **Then**: a new terminal tab opens in the right sidebar and keyboard focus is in the terminal

#### R1.4: Placement setting changes where panels open
- **Given**: setting `placement` = "new tab" (or "split below")
- **When**: the user opens a terminal
- **Then**: it opens as a main-area tab (or as a split below the active note)

#### R1.5: Several panels run independently
- **Given**: a Claude panel is running
- **When**: the user runs "Open Antigravity" and then "Open Claude Code" again
- **Then**: three panels exist, each with its own process, and typing in one does not affect the others

#### R1.6: Shell panel starts in the vault root
- **Given**: the vault path is `~/Documents/MyVault`
- **When**: the user opens a shell panel and runs `pwd`
- **Then**: the output is the vault's absolute path

#### R1.7: Edited profile arguments are used
- **Given**: Settings › Profiles › Claude Code arguments = `--model sonnet`
- **When**: the user opens a Claude panel
- **Then**: the spawned command line contains `--model sonnet`

#### R1.8: Resizing a panel reflows the program
- **Given**: a Claude panel is 300 px wide
- **When**: the user widens the sidebar to 600 px
- **Then**: the PTY receives the new columns/rows and Claude Code redraws at the new width within 500 ms

### R2: Terminal rendering and the PTY helper
**Covers**: D7, D8, D9, D13

#### R2.1: Plugin spawns the helper and wires I/O (Node side)
- **Given**: a Python 3 executable has been found
- **When**: a session starts with a 100×30 view
- **Then**: the plugin spawns `pty_bridge.py 100 30 <command…>` with 4 piped stdio streams, writes keystrokes to stdin, and writes stdout bytes into xterm

#### R2.2: Helper relays bytes between pipes and the PTY (Python side)
- **Given**: the helper is running a program
- **When**: the program writes ANSI output, and the helper's stdin receives bytes
- **Then**: the output appears unchanged on the helper's stdout, and the stdin bytes are written to the PTY

#### R2.3: Resize message changes the PTY size
- **Given**: a running session
- **When**: fd 3 receives `120,40\n`
- **Then**: the PTY window size becomes 120×40 and the program receives SIGWINCH

#### R2.4: Program exit code is passed through
- **Given**: a running program
- **When**: it exits with code N
- **Then**: the helper exits with code N and the plugin receives N

#### R2.5: Python lookup order and missing-Python message
- **Given**: `pythonPath` is empty and the resolved PATH contains `/opt/homebrew/bin/python3`
- **When**: a session starts
- **Then**: that Python runs the helper; if no Python 3 is found anywhere, the panel shows "Python 3 not found — install it or set the path in Settings" and nothing is spawned

#### R2.6: Helper runs on Python 3.9
- **Given**: `pythonPath` = `/usr/bin/python3` (3.9.6)
- **When**: the R2.2–R2.4 scenarios run
- **Then**: they produce the same results as on Python 3.14

#### R2.7: Korean, emoji and true color render with correct widths
- **Given**: a program prints Korean text, an emoji and 24-bit colored text
- **When**: the output is rendered
- **Then**: wide characters occupy two cells, columns after them line up, and the colors are shown

#### R2.8: Terminal colors follow the Obsidian theme
- **Given**: a terminal is open in the light theme
- **When**: the user switches Obsidian to the dark theme
- **Then**: the terminal's background/foreground colors change without restarting the program

#### R2.9: URLs in output are clickable
- **Given**: terminal output contains `https://example.com`
- **When**: the user Cmd-clicks it
- **Then**: the URL opens in the default browser

#### R2.10: Plugin loads without native modules
- **Given**: the built `dist/` with `manifest.json` `isDesktopOnly: true`
- **When**: Obsidian 1.14 loads the plugin
- **Then**: it loads without errors and the bundle contains no `.node` files

### R3: Spawn environment
**Covers**: D6

#### R3.1: Login-shell environment is captured
- **Given**: `~/.zshrc` adds `~/.local/bin` to PATH and Obsidian was launched from the Dock
- **When**: the plugin loads
- **Then**: within 5 s the captured environment's PATH contains `~/.local/bin`, and `claude` / `agy` resolve

#### R3.2: Spawn environment is layered
- **Given**: the captured environment
- **When**: any profile is spawned
- **Then**: its environment has `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=obsidian-ai-terminal`, no `ELECTRON_*` / `CHROME_*` variables, captured shell variables (e.g. API keys from rc files), and `LANG` = `<AppleLocale>.UTF-8` if valid else `en_US.UTF-8` when it was unset

#### R3.3: Capture failure falls back with a notice
- **Given**: the shell capture times out after 5 s
- **When**: the plugin finishes loading
- **Then**: the fallback environment has `~/.local/bin:/opt/homebrew/bin` prepended to PATH and a Notice reports the fallback

#### R3.4: Missing program shows a settings hint
- **Given**: the Claude profile command is `claudex`, which is not on PATH
- **When**: the user opens a Claude panel
- **Then**: the panel prints "Command not found: claudex — check Settings › Profiles" followed by the exit prompt

### R4: Keyboard
**Covers**: D10

#### R4.1: Korean IME input reaches the program intact
- **Given**: a terminal is focused and the macOS Korean input method is active
- **When**: the user types "안녕" and presses Enter
- **Then**: the PTY receives the UTF-8 bytes of "안녕" followed by exactly one CR, with no syllable dropped or duplicated

#### R4.2: Cmd shortcuts reach Obsidian
- **Given**: a terminal is focused
- **When**: the user presses Cmd+P
- **Then**: Obsidian's command palette opens and nothing is sent to the PTY

#### R4.3: Copy and paste
- **Given**: text is selected in the terminal
- **When**: the user presses Cmd+C, then Cmd+V in a program that enabled bracketed paste
- **Then**: the clipboard holds the selected text, and the pasted multi-line text arrives wrapped in bracketed-paste markers

#### R4.4: Terminal Cmd keys
- **Given**: a terminal is focused
- **When**: the user presses Cmd+K / Cmd+A / Cmd+← / Cmd+→
- **Then**: screen and scrollback clear / all terminal text is selected / `\x01` is sent / `\x05` is sent

#### R4.5: Option acts as Meta (setting)
- **Given**: `optionIsMeta` = true
- **When**: the user presses Option+← and then Option+B
- **Then**: `ESC b` is sent both times; with `optionIsMeta` = false, Option+key types the macOS special character instead

#### R4.6: Shift+Enter inserts a newline in Claude Code's input
- **Given**: a Claude panel with text in its prompt
- **When**: the user presses Shift+Enter
- **Then**: `ESC CR` is sent and the prompt gets a new line without being submitted

#### R4.7: Obsidian hotkeys don't fire while the terminal is focused
- **Given**: the user bound Ctrl+E to an Obsidian command
- **When**: the terminal is focused and the user presses Ctrl+E
- **Then**: the PTY receives `\x05` and the Obsidian command does not run

### R5: Exit, restart and resume
**Covers**: D5, D21, D22

#### R5.1: Exit message keeps output readable
- **Given**: a running program
- **When**: it exits with code 0
- **Then**: the panel prints `[Process exited with code 0 — press Enter to restart]` and earlier output stays scrollable

#### R5.2: Enter restarts the same profile in the same panel
- **Given**: a panel showing the exit message
- **When**: the user presses Enter
- **Then**: the same profile starts again in that panel (Claude following R5.4–R5.7)

#### R5.3: New Claude panel gets its own session ID
- **Given**: no Claude panel is open
- **When**: the user opens a Claude panel
- **Then**: the command contains `--session-id <uuid>` and the panel's view state stores that UUID

#### R5.4: Restored Claude panel resumes its conversation
- **Given**: `~/.claude/projects/*/<uuid>.jsonl` exists and its first `cwd` equals the vault path (after `realpath` + NFC)
- **When**: the panel restarts or is restored
- **Then**: the command is `claude --resume <uuid>`

#### R5.5: Conversation that moved into a subfolder still resumes
- **Given**: the transcript's first `cwd` is the vault and later entries have `<vault>/Projects`
- **When**: the panel is restored
- **Then**: the command is `claude --resume <same uuid>`

#### R5.6: Missing conversation starts fresh under the same ID
- **Given**: no transcript file for `<uuid>` exists
- **When**: the panel is restored
- **Then**: the command is `claude --session-id <same uuid>` and no error line is printed

#### R5.7: Conversation from another folder is not resumed
- **Given**: the transcript's `cwd` is a different folder (not inside the vault)
- **When**: the panel is restored
- **Then**: a new UUID is generated, `[Previous conversation belongs to another folder — starting a new one]` is printed, and the view state stores the new UUID

#### R5.8: Two Claude panels each resume their own chat
- **Given**: Claude panels A and B with session IDs a and b are open
- **When**: Obsidian is restarted and both panels are shown
- **Then**: A runs `--resume a` and B runs `--resume b`

#### R5.9: Restored background panels start when first shown
- **Given**: a terminal panel restored into a background tab
- **When**: Obsidian finishes starting
- **Then**: no process is spawned for it until the user shows that tab

#### R5.10: Antigravity restore uses --continue with a fallback
- **Given**: an Antigravity panel is restored
- **When**: it starts
- **Then**: the command is `agy --continue`; if that exits non-zero within 5 s, `[Previous conversation not found — starting a new one]` is printed and plain `agy` starts

#### R5.11: Restored shell starts fresh
- **Given**: a shell panel is restored
- **When**: it starts
- **Then**: a new login shell starts in the vault root

#### R5.12: Early failure never replaces the session ID
- **Given**: Claude exits with an auth or network error 2 s after `--resume <uuid>`
- **When**: the exit is handled
- **Then**: the exit prompt is shown and the view state still holds `<uuid>`

### R6: Session registry, moving panels, duplicates, startup gate
**Covers**: D4, D21, D34

#### R6.1: Moving a panel keeps the running program
- **Given**: a Claude panel in the middle of a reply (process ID P)
- **When**: the user drags the panel to the main area or a popout window
- **Then**: the same process P keeps running, the screen and scrollback are restored, and no restart or snapshot happens

#### R6.2: Terminal modes survive a move
- **Given**: Claude Code has enabled bracketed paste and the panel was moved
- **When**: the user pastes three lines
- **Then**: they arrive as one bracketed paste and are not submitted line by line

#### R6.3: Moved panel redraws
- **Given**: a panel was just reattached at the same size
- **When**: reattach completes
- **Then**: within 1 s the program redraws (size nudged by one column and back)

#### R6.4: Headless mirror tracks the PTY size
- **Given**: a running session
- **When**: the PTY is resized to 90×30
- **Then**: the session's headless mirror is also 90×30

#### R6.5: Duplicated panel gets a new session
- **Given**: panel P is running
- **When**: the user picks "Split right" from P's tab menu
- **Then**: the new panel gets a new `panelId` and a fresh session, and P keeps its session

#### R6.6: Detached session stops after the grace period
- **Given**: a session's view detached without a confirmed close (e.g. layout change)
- **When**: no view with its `panelId` attaches within 2 s
- **Then**: the session is stopped through the helper (R7.1)

#### R6.7: Spawns wait for plugin startup
- **Given**: the plugin is still capturing the shell environment
- **When**: a terminal panel opens
- **Then**: the panel shows "Starting…" and the program spawns only after the ready signal (env captured, servers listening, lock files cleaned, agy entry ensured)

### R7: Shutdown and closing panels
**Covers**: D8, D26

#### R7.1: Helper stops the program on stdin EOF
- **Given**: a running program that ignores SIGHUP
- **When**: the helper's stdin is closed
- **Then**: the helper sends SIGHUP to the program's process group, SIGKILL 3 s later, and exits

#### R7.2: Force-quitting Obsidian leaves no processes
- **Given**: Claude and Antigravity panels are running (including agy's `npx` children)
- **When**: Obsidian is force-quit
- **Then**: within 5 s no helper, `claude`, `agy` or their child processes remain

#### R7.3: Cmd+W on a running panel asks first
- **Given**: Claude is running in a focused panel
- **When**: the user presses Cmd+W
- **Then**: the dialog "Claude Code is still running — stop it and close?" appears; Cancel keeps panel and process; "Stop and close" stops the process and closes the panel

#### R7.4: Tab close button on a running panel asks first
- **Given**: Antigravity is running in a panel
- **When**: the user clicks the panel tab's close button
- **Then**: the same confirmation dialog appears

#### R7.5: Exited panel closes without asking
- **Given**: a panel whose program has exited
- **When**: the user presses Cmd+W
- **Then**: the panel closes immediately

#### R7.6: Batch close asks once
- **Given**: two panels with running programs
- **When**: the user picks "Close all"
- **Then**: one dialog lists both panels, and confirming stops both

#### R7.7: Quitting Obsidian does not ask
- **Given**: panels with running programs
- **When**: the user quits Obsidian with Cmd+Q
- **Then**: no dialog appears and all programs end (as in R7.2)

#### R7.8: Disabling the plugin cleans up without asking
- **Given**: running panels, both bridge servers and a lock file
- **When**: the user disables the plugin
- **Then**: no dialog appears, all sessions stop, both servers close, and the lock file is removed

### R8: Bridge state and tools (Obsidian side)
**Covers**: D19, D23, D24

#### R8.1: Selection survives moving focus to the terminal
- **Given**: lines 3–5 of `Notes/X.md` are selected and the user clicks into a terminal
- **When**: a client calls `get_selection`
- **Then**: it returns `{path: "Notes/X.md", text: <lines 3–5>, fromLine: 3, toLine: 5}`

#### R8.2: get_active_note returns the last note editor
- **Given**: `Notes/X.md` was the last focused note editor with the cursor on line 12
- **When**: a client calls `get_active_note`
- **Then**: it returns its vault-relative path, full content and `cursorLine: 12`

#### R8.3: No note editor yet returns an empty result
- **Given**: no note editor has been focused since Obsidian started
- **When**: a client calls `get_active_note` or `get_selection`
- **Then**: it returns an empty result with a `reason`

#### R8.4: list_open_notes lists open notes
- **Given**: notes `A.md` and `B.md` are open, `B.md` last focused
- **When**: a client calls `list_open_notes`
- **Then**: it returns `[{path: "A.md", active: false}, {path: "B.md", active: true}]`

#### R8.5: open_note opens a note in the main area at a line
- **Given**: `Projects/a.md` exists and the terminal is in the right sidebar
- **When**: a client calls `open_note("Projects/a.md", 10)`
- **Then**: the note opens in the main editor area scrolled to line 10; a missing path returns a "not found" error

#### R8.6: get_links returns outgoing links and backlinks
- **Given**: `A.md` links to `B.md` and `C.md` links to `A.md`
- **When**: a client calls `get_links("A.md")`
- **Then**: it returns `{outgoing: ["B.md"], backlinks: ["C.md"]}`

#### R8.7: Paths outside the vault are rejected
- **Given**: the bridge is running
- **When**: a client calls `open_note("../secret.md")` or passes an absolute path
- **Then**: the call returns an error and nothing is opened

#### R8.8: The bridge offers exactly the five read/open tools
- **Given**: the HTTP MCP server is running
- **When**: a client calls `tools/list`
- **Then**: it lists exactly `get_active_note`, `get_selection`, `list_open_notes`, `open_note`, `get_links` and no tool that writes notes

### R9: HTTP MCP server
**Covers**: D11, D12, D14, D27(b)

#### R9.1: Server listens only on localhost
- **Given**: the plugin has loaded
- **When**: the listening sockets are inspected
- **Then**: the MCP server listens on `127.0.0.1:<random port>` and not on any other interface

#### R9.2: Requests need the token
- **Given**: the server is running with token T
- **When**: a request arrives with no token, a wrong token, and then with `Authorization: Bearer T`
- **Then**: the first two get HTTP 401 and the third gets a valid MCP response

#### R9.3: Tools are served over Streamable HTTP via the MCP SDK
- **Given**: an MCP client connected to `http://127.0.0.1:<port>/mcp` with the token
- **When**: it calls `initialize`, `tools/list` and `tools/call get_active_note`
- **Then**: each returns a valid MCP result

#### R9.4: Each open vault has its own server
- **Given**: vaults A and B are open in two Obsidian windows
- **When**: a Claude panel opens in each
- **Then**: the servers use different ports and tokens, and each panel's `--mcp-config` points to its own vault's server

#### R9.5: Server stops on unload
- **Given**: the server is running
- **When**: the plugin unloads
- **Then**: the port is closed

### R10: Claude Code IDE connection
**Covers**: D27(a), D29, D30, D23, D35

#### R10.1: Lock file is written with the right fields
- **Given**: `ideConnectionEnabled` = true
- **When**: the plugin loads
- **Then**: `~/.claude/ide/<port>.lock` exists with mode 0600 and `{pid: <Obsidian process.pid>, workspaceFolders: [<vault path>], ideName: "Obsidian", transport: "ws", authToken}`

#### R10.2: WebSocket connections need the token
- **Given**: the IDE WebSocket server is running
- **When**: a client connects without the lock file's auth token
- **Then**: the connection is rejected

#### R10.3: Claude panels connect to their own vault (Claude side)
- **Given**: a Claude panel spawned with `--ide` and `CLAUDE_CODE_SSE_PORT=<wsPort>`
- **When**: Claude Code starts
- **Then**: Claude Code reports being connected to Obsidian (`/ide` shows Obsidian connected)

#### R10.4: Selection changes are pushed (Obsidian side)
- **Given**: Claude is connected
- **When**: the user selects 3 lines in `X.md`
- **Then**: a `selection_changed` notification is sent within 300 ms after the selection stops changing, and Claude Code shows "3 lines selected" for `X.md`

#### R10.5: Focusing the terminal does not clear the selection
- **Given**: Claude shows a selection from `X.md`
- **When**: the user clicks into the Claude panel
- **Then**: no empty `selection_changed` is sent and the selection indicator stays

#### R10.6: Diffs stay in the terminal (with Claude's Diff tool = terminal)
- **Given**: Claude is connected to Obsidian and Claude's `diffTool` setting is `terminal`
- **When**: Claude proposes an edit to `X.md`
- **Then**: the diff and the permission prompt appear in the terminal, and the plugin answers no `openDiff` request

#### R10.11: One-time Diff tool hint
- **Given**: the IDE connection is on, Claude's global config has no `diffTool` or `diffTool` ≠ `terminal`, and the hint was never shown in this vault
- **When**: the first Claude panel starts
- **Then**: the panel prints `Tip: to see Claude's edit diffs here, run /config → Diff tool → terminal (one time).` once; later Claude panels in this vault don't print it; Claude's config file is unchanged (byte-identical)

#### R10.7: Stale Obsidian lock files are removed, others are kept
- **Given**: `~/.claude/ide/` has a lock file with `ideName: "Obsidian"` and a dead pid, and a lock file of another IDE
- **When**: the plugin loads
- **Then**: the stale Obsidian lock file is deleted and the other IDE's file is unchanged

#### R10.8: Claude started outside Obsidian can connect
- **Given**: Obsidian is open with the vault, and `claude` is started in Terminal.app inside the vault folder
- **When**: the user runs `/ide`
- **Then**: Obsidian is listed and connecting works

#### R10.9: Lock file is removed on unload
- **Given**: the lock file exists
- **When**: the plugin unloads
- **Then**: the lock file is gone

#### R10.10: Turning the IDE connection off
- **Given**: `ideConnectionEnabled` = false
- **When**: the plugin loads and a Claude panel opens
- **Then**: no WebSocket server or lock file exists, the panel is spawned without `--ide` / `CLAUDE_CODE_SSE_PORT`, and the D24 tools still work over HTTP

### R11: Giving each CLI the bridge
**Covers**: D28

#### R11.1: Claude gets the bridge per session only
- **Given**: hashes of `~/.claude.json`, `~/.claude/settings.json` and the vault's `.mcp.json` (if any)
- **When**: a Claude panel is spawned
- **Then**: its command contains `--mcp-config` (bridge URL + `Authorization` header), `--settings` (the UserPromptSubmit hook) and `--ide`; its env has `CLAUDE_CODE_SSE_PORT`; and all three files are unchanged

#### R11.2: Claude can call the bridge tools
- **Given**: a Claude panel and note `X.md` is the last focused note
- **When**: the user asks "which note do I have open?"
- **Then**: Claude calls the `obsidian` server's `get_active_note` and answers `X.md`

#### R11.3: agy entry is registered with absolute paths
- **Given**: `agyBridgeEnabled` = true and `agy mcp list` has no `obsidian` entry
- **When**: the plugin loads
- **Then**: `agy mcp list` shows `obsidian` (stdio) running `<absolute python3> ~/.config/obsidian-ai-terminal/mcp_shim.py`, and all other entries are unchanged

#### R11.4: agy registration is idempotent
- **Given**: the `obsidian` entry already exists with the same command
- **When**: the plugin loads
- **Then**: `agy mcp add` is not run

#### R11.5: Two vaults loading at once leave one entry
- **Given**: two vault windows load the plugin at the same moment
- **When**: both ensure the agy entry
- **Then**: exactly one `obsidian` entry exists and the other entries are unchanged

#### R11.6: Shim proxies agy's tool calls (shim side)
- **Given**: agy was spawned by the plugin with `OBSIDIAN_BRIDGE_URL` and `OBSIDIAN_BRIDGE_TOKEN`
- **When**: agy calls `get_active_note` through the `obsidian` server
- **Then**: the shim forwards it to the HTTP bridge and returns the bridge's result

#### R11.7: Shim outside Obsidian has no tools
- **Given**: `agy` is started in Terminal.app (no bridge variables)
- **When**: agy lists the `obsidian` server's tools
- **Then**: the list is empty and no error is shown

#### R11.8: Turning the agy bridge off removes the entry
- **Given**: the `obsidian` entry exists
- **When**: the user turns `agyBridgeEnabled` off
- **Then**: `agy mcp remove obsidian` runs and the entry is gone

#### R11.9: Shim and hook scripts are installed to a stable path
- **Given**: the plugin loads
- **When**: startup finishes
- **Then**: `~/.config/obsidian-ai-terminal/mcp_shim.py` and `snapshot_hook.py` exist and match the plugin's bundled versions

### R12: Snapshots before every AI message
**Covers**: D31, D32

#### R12.1: First AI panel asks to enable snapshots
- **Given**: `snapshots.enabled` is null for this vault
- **When**: the user opens the first AI panel
- **Then**: a dialog asks "Enable AI session snapshots for this vault?" and the spawn waits; Yes → enabled + a background full snapshot starts; No → disabled; dismiss → still null and no snapshot this time

#### R12.2: History store is outside the vault
- **Given**: snapshots are enabled
- **When**: the first snapshot completes
- **Then**: a store exists at `~/.local/share/obsidian-ai-terminal/snapshots/<sha256(vaultPath)[:16]>.git` and no new `.git` exists in the vault

#### R12.3: Claude prompt triggers a snapshot before the reply (hook side)
- **Given**: snapshots enabled and a note changed since the last snapshot
- **When**: the user submits "make this shorter" in a Claude panel
- **Then**: the hook calls `/snapshot` and a commit `Before Claude Code: "make this shorter" — <date time>` exists before Claude's first edit of that turn

#### R12.4: /snapshot endpoint queues a snapshot (server side)
- **Given**: the bridge is running
- **When**: `POST /snapshot` arrives with a valid token (and without one)
- **Then**: with the token, a snapshot is queued and the response is sent when it finishes or after 10 s; without it, HTTP 401

#### R12.5: No change → no new commit
- **Given**: nothing changed since the last snapshot
- **When**: the user submits a prompt
- **Then**: no new commit is created

#### R12.6: Changes made while Obsidian was closed are captured
- **Given**: a note was edited by another app while Obsidian was closed
- **When**: Obsidian starts and the user submits the first AI prompt
- **Then**: the snapshot taken before that prompt contains the edit

#### R12.7: Antigravity Enter waits for the snapshot
- **Given**: snapshots enabled, a note changed, an agy panel focused
- **When**: the user presses Enter and keeps typing "abc"
- **Then**: Enter is forwarded after the snapshot finishes (≤ 2 s), "abc" arrives after it in order, and if 2 s passed first the panel prints `[Snapshot still running — it may include this message's changes]`

#### R12.8: Starting an AI panel takes a snapshot
- **Given**: snapshots enabled and a note changed
- **When**: an AI panel is opened, restored or restarted
- **Then**: a snapshot is committed before the program starts

#### R12.9: Slow snapshot doesn't block for more than 10 s
- **Given**: a git commit takes 15 s
- **When**: the Claude hook waits
- **Then**: the prompt proceeds after 10 s, the panel prints a "not protected" note, git is not killed, and the commit appears when git finishes

#### R12.10: Failed snapshot is reported and the session continues
- **Given**: git returns an error
- **When**: a snapshot runs
- **Then**: the panel prints `[Snapshot failed: <reason> — this message is not protected]` and the program keeps running

#### R12.11: Stale index.lock is cleaned only when safe
- **Given**: the store has `index.lock` and no plugin git process is running
- **When**: the next snapshot starts
- **Then**: the lock is removed and the snapshot succeeds; if a plugin git process is running, the lock is left alone

#### R12.12: Notes are tracked even if the vault's .gitignore ignores them
- **Given**: the vault has a `.gitignore` containing `*.md`, plus `.obsidian/app.json`, `.trash/old.md` and `img.png`
- **When**: a snapshot runs
- **Then**: all `.md`, `.canvas` and `.base` notes are committed, and `.obsidian/`, `.trash/` and `img.png` are not

#### R12.13: Snapshots use their own identity
- **Given**: the user's global git config
- **When**: a snapshot is committed
- **Then**: the author is "Obsidian AI Terminal <noreply@localhost>" and the user's git config is unchanged

#### R12.14: Nested git repositories are reported once
- **Given**: the vault contains a folder with its own `.git`
- **When**: snapshots run
- **Then**: one Notice says that folder can't be snapshotted, and it is not repeated in the same Obsidian session

#### R12.15: Shell panels never snapshot
- **Given**: snapshots enabled and a note changed
- **When**: the user runs commands in a shell panel
- **Then**: no snapshot is taken

#### R12.16: Missing git disables snapshots
- **Given**: `/usr/bin/git --version` fails
- **When**: the plugin loads
- **Then**: snapshots are disabled and a Notice explains why

#### R12.17: Snapshots run one at a time
- **Given**: two AI panels are restored at startup with changes pending
- **When**: both request a snapshot
- **Then**: the commits run one after the other and neither fails with an `index.lock` error

### R13: Restoring notes
**Covers**: D33

#### R13.1: Restore modal lists snapshots
- **Given**: three snapshots exist
- **When**: the user runs "Restore notes from before an AI session…"
- **Then**: a modal lists them newest first with time, which AI, prompt excerpt and number of files changed since

#### R13.2: Picking a snapshot shows changed files with checkboxes
- **Given**: the restore modal is open
- **When**: the user picks a snapshot
- **Then**: the files changed since then are listed, all ticked

#### R13.3: Restore brings back the snapshot versions
- **Given**: since the snapshot, `A.md` was modified, `B.md` deleted and `C.md` created
- **When**: the user confirms the restore with all files ticked
- **Then**: a `Before restore` snapshot is committed first, `A.md` and `B.md` return to their snapshot content, and `C.md` is moved to `.trash/`

#### R13.4: Unticked files are left alone
- **Given**: `A.md` and `D.md` changed since the snapshot
- **When**: the user unticks `D.md` and confirms
- **Then**: only `A.md` is restored and `D.md` is unchanged

#### R13.5: A restore can be undone
- **Given**: a restore was just done
- **When**: the user restores from its `Before restore` snapshot
- **Then**: the notes return to their state before that restore

#### R13.6: Running AI panels trigger a warning
- **Given**: two AI panels are running
- **When**: the user confirms a restore
- **Then**: a dialog offers [Stop them and restore] [Restore anyway] [Cancel]; the first stops both sessions before restoring

### R14: Settings
**Covers**: D18

#### R14.1: Settings persist
- **Given**: the settings tab is open
- **When**: the user changes placement, profile arguments, font size and `optionIsMeta`, then restarts Obsidian
- **Then**: the settings tab shows the changed values and new panels use them

#### R14.2: Defaults on first install
- **Given**: a fresh install
- **When**: the settings tab opens
- **Then**: placement = right sidebar, scrollback = 10000, `optionIsMeta` = on, bridge / IDE connection / agy bridge = on, snapshots = "not asked yet"

### R15: Security, permissions, documentation
**Covers**: D11, D17, D25

#### R15.1: Tokens never leak
- **Given**: the bridge, IDE connection and snapshots have been used
- **When**: the developer console, Notices and snapshot commit messages are searched for the tokens
- **Then**: no token appears

#### R15.2: Spawned programs can use the vault without a permission error
- **Given**: Obsidian was launched from the Dock with the vault in `~/Documents/MyVault`
- **When**: a shell panel runs `ls` and Claude reads a note
- **Then**: both succeed without "Operation not permitted" (or macOS shows a one-time permission prompt and they succeed after Allow)

#### R15.3: README explains the safety caveats
- **Given**: the README
- **When**: the user reads its "Safety" section
- **Then**: it covers not typing in a note the AI is editing, File Recovery, removing the agy entry with `agy mcp remove obsidian`, and snapshot history restarting after a vault move

### R16: Build and install
**Covers**: D13, D15

#### R16.1: Build produces the plugin folder
- **Given**: a clean checkout
- **When**: the developer runs `npm run build`
- **Then**: `dist/` contains `main.js`, `manifest.json`, `styles.css`, `pty_bridge.py`, `mcp_shim.py` and `snapshot_hook.py`, and no native modules

#### R16.2: Install script copies to a vault or explains the permission block
- **Given**: a built `dist/`
- **When**: the developer runs `npm run install-plugin -- ~/Documents/MyVault`
- **Then**: the files are copied to `<vault>/.obsidian/plugins/obsidian-ai-terminal/`; on "Operation not permitted" it prints how to grant folder access or copy `dist/` in Finder

## Tasks

> File ownership keeps parallel tasks apart: T1 creates the module skeleton and the extension points (`SpawnContributor` for per-profile args/env, keyboard `onKey` / `onEnterIntercept` hooks, bridge `addRoute`, support-script installer, redacting logger). Each later task edits only its own directory plus registrations through those extension points.

### T1: Scaffold plugin, settings and build/install pipeline [infra]
- **Fulfills**: R14, R16, R2.10
- **Depends on**: (none)
- **Scope**: `package.json` (obsidian 1.13, @xterm/xterm 6 + addon-fit / web-links / unicode11 / serialize, @xterm/headless, @modelcontextprotocol/sdk, esbuild, vitest), `tsconfig.json`, `esbuild.config.mjs` (copies `*.py` support files into `dist/`), `manifest.json` (`isDesktopOnly: true`), `styles.css`, `src/main.ts` wiring every feature module through stubs, `src/settings.ts` (full D18 shape + settings tab), extension-point interfaces, `src/util/log.ts` (token-redacting logger), `src/support/installScripts.ts` (copies bundled scripts to `~/.config/obsidian-ai-terminal/`), `scripts/install-plugin.mjs`, test harnesses (vitest; Python `unittest` runnable on 3.9 and 3.14), README skeleton.

### T2: PTY helper, process wrapper and shell environment [infra]
- **Fulfills**: R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R3, R7.1, R7.2
- **Depends on**: T1
- **Scope**: `src/pty/pty_bridge.py` (PTY relay, fd-3 resize, exit code, helper-owned shutdown incl. parent-death watch), `src/pty/PtyProcess.ts` (spawn with 4 pipes, Python lookup D7), `src/env/shellEnv.ts` (D6 capture + layering + fallback). Internal service — no UI yet; tested with a scripted fake TUI and real `claude` / `agy` startup screens.

### T3: Terminal panels, launch commands and session registry [vertical]
- **Fulfills**: R0.1, R0.2, R0.3, R1, R2.7, R2.8, R2.9, R5.1, R5.2, R5.9, R5.11, R6
- **Depends on**: T2
- **Scope**: `src/terminal/TerminalView.ts` (ItemView, xterm + addons, theme from CSS variables, fit → resize), `src/terminal/commands.ts` (palette commands, ribbon menu, placement), `src/session/SessionRegistry.ts` (panelId registry, headless mirror kept at PTY size, serialize-restore + resize nudge on reattach, 1 s duplicate rule, 2 s grace, ready gate), `src/session/profiles.ts` (base commands + `SpawnContributor` application), exit / restart flow. First step: verify attach/detach ordering on drag and popout moves (Known Gap) and `addon-serialize` mode coverage.

### T4: Keyboard routing and the close flow [vertical]
- **Fulfills**: R4, R7.3, R7.4, R7.5, R7.6, R7.7, R7.8
- **Depends on**: T3 — parallel with T5, T6
- **Scope**: `src/terminal/keyboard.ts` (IME guard, Cmd mapping, Option-as-Meta, Shift+Enter, hotkey isolation, `onEnterIntercept` hook for T9), `src/terminal/closeFlow.ts` (Cmd+W, `WorkspaceLeaf.detach` wrapper, batch grouping, no-dialog paths, confirm modal). First step: verify which Obsidian paths call `detach` (Known Gap).

### T5: Conversation identity and resume [vertical]
- **Fulfills**: R5.3, R5.4, R5.5, R5.6, R5.7, R5.8, R5.10, R5.12
- **Depends on**: T3 — parallel with T4, T6
- **Scope**: `src/session/resume.ts` (UUID per Claude panel, transcript lookup by `<uuid>.jsonl`, first-`cwd` realpath + NFC comparison, new-UUID path, agy `--continue` fallback), registered as a `SpawnContributor`; view-state update through the registry API.

### T6: Bridge state reader and HTTP MCP server (+ Claude tools) [vertical]
- **Fulfills**: R8, R9, R11.1 (`--mcp-config` part), R11.2
- **Depends on**: T3 — parallel with T4, T5
- **Scope**: `src/bridge/state.ts` (last-note-editor tracking, selection while blurred, open notes, links), `src/bridge/tools.ts` (5 tools, vault-relative path validation), `src/bridge/httpServer.ts` (127.0.0.1, random port, bearer token, Streamable HTTP via MCP SDK, `addRoute`), `src/bridge/claudeMcpContributor.ts` (`--mcp-config` inline JSON).

### T7: Claude Code IDE connection [vertical]
- **Fulfills**: R0.4, R10 (incl. R10.11 added with D35), R11.1 (`--ide` + `CLAUDE_CODE_SSE_PORT` part)
- **Depends on**: T6 — parallel with T8, T9
- **Scope**: `src/bridge/ideServer.ts` (WebSocket MCP server, token check, `selection_changed` debounced 300 ms from `state.ts`, no diff / tab methods), `src/bridge/lockFile.ts` (write 0600, remove on unload, stale-Obsidian cleanup only), `src/bridge/claudeIdeContributor.ts`. First step: verify lock-file fields, auth header and `selection_changed` payload against Claude Code 2.1.290 and prior-art plugins (Known Gap).

### T8: Antigravity bridge via the MCP shim [vertical]
- **Fulfills**: R11.3, R11.4, R11.5, R11.6, R11.7, R11.8, R11.9 (shim part)
- **Depends on**: T6 — parallel with T7, T9
- **Scope**: `src/bridge/mcp_shim.py` (stdio ↔ HTTP proxy, `tools: []` without env), `src/bridge/agyConfig.ts` (lock file, `agy mcp list` / `add` / `remove`, absolute Python path), `src/bridge/agyEnvContributor.ts` (`OBSIDIAN_BRIDGE_URL` / `TOKEN`). First step: verify agy passes its environment to stdio MCP servers; if not, implement the per-vault HTTP-entry fallback (D28).

### T9: Snapshots before every AI message [vertical]
- **Fulfills**: R12, R11.1 (`--settings` hook part), R11.9 (hook part)
- **Depends on**: T4, T6 — parallel with T7, T8
- **Scope**: `src/snapshot/store.ts` (external git dir, `add -f -A` pathspecs, identity, `untrackedCache`, nested-repo notice), `src/snapshot/queue.ts` (serialized, 10 s wait without kill, safe `index.lock` cleanup, change flag), `src/snapshot/firstUse.ts` (enable prompt + background first snapshot), `src/snapshot/endpoint.ts` (`/snapshot` via `addRoute`), `src/snapshot/snapshot_hook.py`, `src/snapshot/claudeHookContributor.ts` (`--settings` with `UserPromptSubmit`), `src/snapshot/agyEnterHold.ts` (via `onEnterIntercept`), spawn-time snapshot via the registry.

### T10: Restore command [vertical]
- **Fulfills**: R13
- **Depends on**: T9
- **Scope**: `src/snapshot/restoreModal.ts` (snapshot list, file checkboxes, running-AI warning, `Before restore` snapshot, restore + move-to-trash).

### T11: Safety documentation and leak audit [vertical]
- **Fulfills**: R15
- **Depends on**: T5, T7, T8, T10
- **Scope**: README "Safety" section (D25, File Recovery, `agy mcp remove obsidian`, vault-move note), token-leak audit across console / Notices / commit messages, in-app permission check script and instructions (R15.2).

## External Dependencies

### Pre-work
- Obsidian: in `~/Documents/MyVault`, turn off Restricted mode (Settings › Community plugins) so a manually installed plugin can be enabled.
- macOS: give the terminal app that runs Claude Code access to the vault folder (System Settings › Privacy & Security › Files and Folders, or Full Disk Access) so `npm run install-plugin` can copy into the vault — otherwise plan to copy `dist/` in Finder.
- Antigravity: sign in once (`agy` reported "not signed in").
- Recommended: back up the vaults (or let the plugin's first snapshot run) before the first AI session.

### Post-work
- Install into `~/Documents/MyVault`, enable "AI Terminal" in Community plugins, answer the snapshot prompt, and accept the Claude Code / Antigravity folder-trust prompts once.
- Manual in-app verification of behaviors that need real Obsidian: R0.1–R0.4, R6.1–R6.3 (drag / popout moves), R7.2 (force-quit), R7.6 (Close all), R10.3 / R10.4 / R10.8 (IDE connection), R12.7 (agy Enter hold), R15.2 (macOS permission).
- Optional: install into other vaults (for example ones in iCloud or Google Drive).
