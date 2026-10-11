# AI Terminal for Obsidian

## What it is

AI Terminal is an Obsidian plugin for the Mac. It adds terminal panels to Obsidian.
In a panel you can run:

- **Claude Code** (`claude`)
- the **Antigravity CLI** (`agy`)
- your normal **shell** (zsh, bash …)

Every panel starts in your vault folder. So the AI can read and edit your notes, and Obsidian shows the changes.

The plugin also has a small **bridge**. With it, the AI can see the note you have open, the text you selected, and
the links between notes. It can also open a note for you.

Before each message to an AI, the plugin can save a **snapshot** of your notes. If the AI breaks something, you can go back.

## Requirements

- macOS
- Obsidian desktop **1.8 or newer** (mobile does not work)
- **Python 3.9 or newer** — `/usr/bin/python3` (from the Command Line Tools) or Homebrew `python3`
- **git** — `/usr/bin/git` (from the Command Line Tools; install them with `xcode-select --install`)
- `claude` and/or `agy` installed. Test it in Terminal: `claude --version`, `agy --version`
- To build the plugin: Node.js 22 or newer

## Install

1. Build the plugin and copy it into your vault:

   ```sh
   npm install && npm run build && npm run install-plugin -- ~/Documents/Notes
   ```

   Use the path of your own vault instead of `~/Documents/Notes`.
   The script copies `dist/` to `<vault>/.obsidian/plugins/obsidian-ai-terminal/`. Your plugin settings are kept.

2. If you see **"Operation not permitted"**, macOS blocks your terminal app from the vault folder. Do one of these:
   - Open System Settings › Privacy & Security › **Files and Folders**. Find your terminal app (Terminal, iTerm …)
     and turn on the folder of your vault (for example "Documents"). Or add the terminal app under
     **Full Disk Access**. Then run the command again.
   - Or copy the files by hand in Finder. Copy everything in `dist/` (`main.js`, `manifest.json`, `styles.css`,
     `pty_bridge.py`, `mcp_shim.py`, `snapshot_hook.py`) into `<vault>/.obsidian/plugins/obsidian-ai-terminal/`.
     Create the folder if it does not exist. Press Cmd+Shift+. in Finder to see the hidden `.obsidian` folder.

3. In Obsidian, open Settings › **Community plugins**. Turn off **Restricted mode**. Then turn on **AI Terminal**.

4. Open a panel (see [Usage](#usage)). The first time, you see some questions:
   - "Enable AI session snapshots for this vault?" — click **Enable**.
   - Claude Code and Antigravity ask if you trust the folder. Say yes.
   - Antigravity may ask you to sign in.

## First run checklist

Do these steps once after you install. They check the things that only work inside the real Obsidian app.
"Expect" says what you should see. If a step fails, look at [Troubleshooting](#troubleshooting).
You need a test note, for example `X.md` with a few lines of text.

1. **Commands.** Open the developer console (Cmd+Option+I). Press Cmd+P and type `AI Terminal`.
   Expect: "Open Claude Code", "Open Antigravity", "Open shell", "Send note path to terminal" and
   "Restore notes from before an AI session…".
   Expect: no red error lines from AI Terminal (they start with `[AI Terminal`) in the developer console.
2. **macOS permission.** Run "Open shell". Type `ls` and press Enter.
   Expect: a list of your notes, and no "Operation not permitted". If macOS asks
   "“Obsidian” would like to access files in your Documents folder", click **Allow**, then try again.
3. **Korean input and links.** In the shell panel, switch to the Korean input method, type `안녕` and press Enter.
   Expect: an error like `zsh: command not found: 안녕` — the shell got exactly `안녕` (no missing or doubled syllable).
   Then run `echo https://example.com` and Cmd-click the link in the output.
   Expect: the page opens in your default browser. A click without Cmd opens nothing.
4. **Claude Code.** Run "Open Claude Code".
   Expect: a new panel in the right sidebar with Claude Code. Its welcome box shows your vault folder as `cwd`.
   Expect: the cursor is in the panel — you can type without clicking.
   Ask "read one of my notes and summarise it". Expect: Claude can read it (no permission error).
5. **New line in Claude.** In the Claude panel type `one`, press Shift+Enter, type `two`.
   Expect: two lines in Claude's input; nothing is sent until you press Enter.
6. **Antigravity.** Run "Open Antigravity".
   Expect: the Antigravity screen in a new panel, started in your vault folder.
   Click into `X.md`, then into the Antigravity panel, and ask "which note do I have open?".
   Expect: agy uses the obsidian tool `get_active_note` without asking for permission, and answers `X.md`.
7. **AI edits.** Open `X.md`. Ask Claude: "add the line hello at the end of X.md". Approve the edit.
   Expect: the editor shows the new line. You do not need to reload.
8. **Diffs in the terminal.** In Claude run `/config` → **Diff tool** → **terminal**. Ask Claude to change `X.md`.
   Expect: the diff and the Yes/No prompt appear in the panel, and no "Opened changes in Obsidian ⧉".
9. **Active note.** Click into `X.md`, then click into the Claude panel and ask "which note do I have open?".
   Expect: Claude uses the obsidian tool `get_active_note` and answers `X.md`.
10. **Selection.** Select 3 lines in `X.md`. Click into the Claude panel.
    Expect: Claude shows "⧉ 3 lines selected" (near the input box). Type "explain the selected text" and press Enter.
    Expect: the answer is about those lines. Type `/ide`. Expect: Obsidian is connected.
11. **Claude from Terminal.app.** In Terminal.app, `cd` into the vault folder and start `claude`. Type `/ide`.
    Expect: Obsidian is in the list, and connecting works.
12. **Moving panels.** Ask Claude a long question. While it answers, drag the panel's tab into the main editor area.
    Then right-click the tab and choose "Move to new window".
    Expect: the answer keeps going. The screen and the history stay. Nothing restarts.
    Now copy 3 lines of text and paste them into Claude. Expect: one paste with 3 lines; it is not sent line by line.
13. **Split.** Right-click the tab of a running Claude panel and choose "Split right".
    Expect: the new panel starts a fresh Claude conversation; the first panel keeps running with its text.
14. **Close one.** Click × on the tab of a running panel.
    Expect: the dialog "Claude Code is still running — stop it and close?" (or the name of that panel's program).
    Click Cancel: the panel stays and keeps running.
15. **Close all.** Open two panels with running programs. Right-click a tab and choose "Close all".
    Expect: one dialog that lists both panels. "Stop and close" closes both.
16. **Workspace layouts.** Turn on the core plugin **Workspaces** (Settings › Core plugins). Save a layout without
    terminal panels. Open a panel with a running program, then load the saved layout.
    Expect: no stop-and-close dialog; the layout changes and the program of the closed panel stops.
17. **Antigravity snapshot.** Snapshots must be on. Run "Open Antigravity". Change a note. In the Antigravity panel
    type a message, press Enter, and type `abc` right after.
    Expect: the message is sent within 2 seconds, and `abc` appears after it, in the right order.
    The restore command lists a new snapshot "Before input in Antigravity".
18. **Quit.** Open two Claude panels as tabs in the right sidebar, so only one of them is visible.
    Quit Obsidian with Cmd+Q.
    Expect: no dialog. Wait 5 seconds. In Terminal.app run `pgrep -fl pty_bridge.py`. Expect: no output.
19. **Restart.** Start Obsidian again.
    Expect: your panels come back. Each Claude panel continues its own conversation.
    Before you click the hidden tab from step 18, run `pgrep -fl pty_bridge.py` in Terminal.app.
    Expect: one line for each terminal panel that is visible on screen — none for terminal tabs you have not clicked yet.
    Click the hidden tab. Expect: its program starts now (Claude continues its conversation), and
    `pgrep -fl pty_bridge.py` shows one more line.
20. **Force quit.** Open a Claude panel and an Antigravity panel. Force-quit Obsidian (Cmd+Option+Esc).
    Wait 5 seconds. In Terminal.app run `pgrep -fl pty_bridge.py`.
    Expect: no output. (No helper, `claude` or `agy` from Obsidian is left running.)
    Start Obsidian again. Expect: the panels come back.
21. **Send note path.** Open an Antigravity panel. Click into `X.md`, then run "Send note path to terminal" (Cmd+P).
    Expect: the Antigravity panel shows `@X.md` in its input box, the cursor is there, and nothing was sent yet.
    Type "summarize this note" and press Enter. Expect: the answer is about `X.md`.

## Usage

### Opening panels

- **Command palette** (Cmd+P): "Open Claude Code", "Open Antigravity", "Open shell".
  You can give them hotkeys in Settings › Hotkeys.
- **Ribbon icon** (the terminal icon on the left): click it and pick Claude Code, Antigravity or Shell.
- **Placement**: Settings › AI Terminal › Placement.
  - Right sidebar (default): a new tab in the right sidebar.
  - New tab: a tab in the main area.
  - Split below current note: below the note you are editing.
- **More than one panel**: open as many as you like, for example Claude and Antigravity side by side.
  Each panel runs its own program.

### Sending a note's path to a panel

Click into a note, then run **"Send note path to terminal"** (Cmd+P; you can give it a hotkey in Settings › Hotkeys).
It types the note's path into a terminal panel and puts the cursor there. It does not press Enter, so you can add
your question.

- Claude Code and Antigravity get an @ mention: `@IELTS/Grammar/note.md`, or `@"IELTS/Grammar/my note.md"` when the
  path has spaces. Claude Code reads the note right away. Antigravity shows the path and reads the note when it
  needs it.
- Shell gets the path, in quotes when it has spaces.
- The path goes to the panel you used last. If no panel is open, the command tells you to open one.

### Moving and closing panels

- Drag a panel's tab to another place or to another window. The program keeps running.
- "Split" or "Open in new window" in the tab menu makes a **second** panel with a new program.
  The first panel keeps its program.
- Closing a panel while its program runs asks first: "Claude Code is still running — stop it and close?".
  "Close others" and "Close all" ask once for all panels.
- Quitting Obsidian does not ask. All programs stop.

### When a program ends

The panel stays open and shows `[Process exited with code 0 — press Enter to restart]`. Press Enter to start it again.

### After Obsidian restarts

- Each **Claude** panel continues its own conversation.
- **Antigravity** continues its most recent conversation in this vault (see [Known limitations](#known-limitations)).
- The **shell** starts fresh.
- A panel in a background tab starts when you first look at it.

### Keyboard

- **Korean and other input methods** work like in a normal text field. Enter finishes the syllable first.
- **Shift+Enter**: a new line in Claude Code's input (the message is not sent).
- **Option is Meta** (default): Option+← / Option+→ move by word; Claude Code's Meta shortcuts work.
  To type special characters with Option (like Option+2 = ™), turn off Settings › AI Terminal › "Option key acts as Meta".
- **Cmd shortcuts in the terminal**:

  | Keys | Action |
  | --- | --- |
  | Cmd+C | copy the selected terminal text |
  | Cmd+V | paste |
  | Cmd+A | select all terminal text |
  | Cmd+K | clear the screen and the history |
  | Cmd+← / Cmd+→ | go to the start / end of the line |
  | Cmd+W | close the panel |

- **All other Cmd shortcuts** (Cmd+P, Cmd+O …) still go to Obsidian.
- **Other keys** (Ctrl+…, Esc, arrows …) go to the program. Obsidian hotkeys do not run while the terminal has focus.
- **Mouse**: Cmd+click opens a link. Option+drag selects a rectangle. Shift+drag selects text when the program uses the mouse.

### Settings

Settings › AI Terminal: placement; the command and arguments of each profile (for example `--model sonnet`);
Python path; font; scrollback; Option as Meta; the bridge switches; snapshots.

**Terminal colors**: "Follow Obsidian theme" (default), "Dark (black background)" or "Light (white background)".
The change shows at once in open panels.

## The Obsidian bridge

### What the AI can see

The bridge works with the **note editor you used last**. Clicking into a terminal does not change it.

| Tool | What it does |
| --- | --- |
| `get_active_note` | path, full text and cursor line of the last note |
| `get_selection` | the selected text and its lines |
| `list_open_notes` | the notes that are open in tabs |
| `open_note` | opens a note in the main area (optionally at a line) |
| `get_links` | the links of a note and its backlinks |

The bridge cannot change notes. The AI edits note **files** with its own tools, and Claude asks you first.
In Claude Code the tools are called `mcp__obsidian__…`. Antigravity sees them in the `obsidian` server.

### Automatic selection in Claude Code

With "Claude Code IDE connection" on (default), Claude sees your selection without a tool call, like in VS Code.
Select text in a note, click into the Claude panel, and ask. Claude shows "⧉ N lines selected".
`/ide` in Claude shows the connection. A `claude` that you start in Terminal.app inside the vault can connect too (`/ide`).

**Tip — diffs in the terminal.** While Claude is connected, it may show "Opened changes in Obsidian ⧉" and hide the
diff of an edit. To see diffs in the terminal again, type this in Claude once:
`/config` → **Diff tool** → **terminal**. The plugin prints this tip one time per vault.

### Antigravity

agy has no option to add a server for one session. So the plugin adds **one global agy entry** named `obsidian`
(`agy mcp list` shows it). It runs a small script: `~/.config/obsidian-ai-terminal/mcp_shim.py`.

- Only agy started **from Obsidian** gets the tools. agy started anywhere else sees an empty `obsidian` server.
  This is normal.
- agy shows **no note name and no selection** near its input box. Claude shows "⧉ In …" or "⧉ N lines selected"
  through its IDE connection; agy has nothing like that. agy still sees your note: it reads it with the Obsidian
  tools when you ask, for example "summarize the note I have open" or "explain my selection".
  To put the path in agy's input box, run "Send note path to terminal" (see
  [Sending a note's path](#sending-a-notes-path-to-a-panel)).
- To remove the entry: turn off Settings › AI Terminal › "Antigravity bridge", or run `agy mcp remove obsidian`.

Antigravity asks permission before it uses MCP tools. The plugin allows the Obsidian tools for you
(`mcp(obsidian/*)` in agy's settings) and removes this when you turn the Antigravity bridge off.
Restart running Antigravity panels after the first setup.

- agy's settings file is `~/.gemini/antigravity-cli/settings.json`. The plugin only adds this one rule to
  `permissions.allow`. All your other settings and rules stay as they are.
- If you had the rule already, the plugin leaves it there, also when you turn the bridge off.
- If the file cannot be read (for example, it is not valid JSON), the plugin does not change it and shows a short
  message. agy then asks before it uses an Obsidian tool. You can allow the tools in agy.

## Snapshots and restore

### What is saved, and when

- **What**: your notes — `.md`, `.canvas` and `.base` files. Not `.obsidian/`, not `.trash/`, not attachments
  (images, PDFs …).
- **When**, but only if a note changed since the last snapshot:
  - before **each message** you send to Claude Code,
  - before **Enter** in an Antigravity panel,
  - when an AI panel **starts** (new, restored or restarted).
- A snapshot never stops your message. If it is slow, the message goes on after 10 seconds (Claude) or
  2 seconds (Antigravity). If it fails, the panel shows `[Snapshot failed: … — this message is not protected]`.
- Turning off **"Bridge tools"** does **not** turn off snapshots. Claude panels still save a snapshot before each
  message: the plugin's small local server (127.0.0.1, with the token) keeps working for snapshots only, without
  the AI tools. To stop snapshots, turn off **"AI session snapshots"**.

### Where the history lives

`~/.local/share/obsidian-ai-terminal/snapshots/<id>.git` — one history per vault, **outside** the vault.
It is not synced by iCloud or Google Drive. A `.git` folder in your vault is never touched.
The plugin uses `/usr/bin/git` with its own name ("Obsidian AI Terminal"), not your git settings.

If you **move or rename** the vault folder, the history starts again from zero. The old history stays in that folder.

### Restore

1. Run "**Restore notes from before an AI session…**".
2. Pick a time. The list shows the time, the AI, the start of your message, and how many files changed since.
3. You see the changed files. All are ticked. Untick the notes you changed yourself and want to keep.
4. Click **Restore**. If AI panels are running, choose:
   - **Stop them and restore** (safest: the AI cannot write the old text back), or
   - **Restore anyway**, or **Cancel**.

Before it restores, the plugin saves a **"Before restore"** snapshot. Notes that did not exist at the snapshot time
move to Obsidian's trash (`.trash/`).

**Undo a restore**: run the command again and pick the "Before restore" snapshot.

## Safety

- **Do not type in a note while the AI is editing it.** Obsidian reloads a note when its file changes on disk.
  If you type at the same time, one of the two changes can be lost. Obsidian's core plugin **File Recovery**
  (Settings › Core plugins) keeps older versions of each note — keep it on as a safety net.
  Also wait about **2 seconds** after typing before you start a restore; Obsidian may still be saving your typing.
- **Your notes go to the AI company.** Notes and selections that Claude Code or Antigravity read are sent to
  Anthropic or Google, like everything else you send to these tools.
- **The bridge is local and locked.** It listens only on `127.0.0.1` (your Mac, not the network). Every request
  needs a random token that is new each time the plugin starts. The token is never written to logs, Notices,
  snapshots or the settings file. Claude and agy panels get it in their environment, so programs that run inside
  those panels (the AI's commands, its MCP servers) can use the bridge too. They can already read your vault files,
  so this gives them nothing new.
- **The bridge keeps its port until the plugin stops.** If you turn off both "Bridge tools" and
  "AI session snapshots", the local server does not close. It stays on the same port and answers every request
  with "turned off". This way no other program can take that port while open panels still send their token to it.
  When you turn a switch on again, panels that used it before work again without a restart. The port closes when
  you turn the plugin off or quit Obsidian. If both switches are off when the plugin starts, the server starts only
  when you turn one of them on.
  The **Claude Code IDE connection** keeps its port in the same way. When you turn "Claude Code IDE connection" off,
  the plugin removes its lock file, disconnects Claude and refuses new connections, but it keeps the same port.
  When you turn it on again, the lock file comes back with the same port, and Claude panels that were already open
  can connect again (run `/ide` in Claude if it does not reconnect). If the switch is off when the plugin starts,
  this port is not opened at all.
- **Your AI settings stay yours.** The plugin never changes the settings files of Claude Code or Antigravity.
  Claude gets the bridge only for each session it starts. The two exceptions are both for agy: the `obsidian` entry
  and the rule `mcp(obsidian/*)` that allows its tools (see [Antigravity](#antigravity)). The plugin also writes a small lock file `~/.claude/ide/<port>.lock`
  (readable only by you) while the IDE connection is on, and removes it when you turn the connection off or the
  plugin stops.
- **After you uninstall**, run `agy mcp remove obsidian` in Terminal. Obsidian cannot tell the plugin that it was
  deleted, so the plugin cannot remove this entry itself. Also remove the rule `mcp(obsidian/*)` from
  `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. You can also delete `~/.config/obsidian-ai-terminal`
  and, if you do not need the history any more, `~/.local/share/obsidian-ai-terminal`.
- **Snapshot history restarts after a vault move.** Moving or renaming the vault folder starts a new, empty history
  (see [Where the history lives](#where-the-history-lives)).
- Snapshots cover notes only. The AI can also change other files (attachments, `.obsidian` settings, files outside
  the vault). Read the AI's permission prompts.

## Troubleshooting

- **How to reload the plugin** (some messages say "Reload the plugin"): open Settings › Community plugins, turn
  **AI Terminal** off, then turn it on again. This closes the terminal panels and stops their programs, so open
  new panels afterwards.
- **"Command not found: claude — check Settings › Profiles"**. Obsidian started from the Dock may not see the same
  PATH as Terminal. In Terminal run `which claude` (or `which agy`). Copy the full path (for example
  `/Users/you/.local/bin/claude`) into Settings › AI Terminal › Profiles › "Claude Code command".
- **"Python 3 not found — install it or set the path in Settings"**. Run `xcode-select --install`
  (or `brew install python`). Or set Settings › AI Terminal › "Python path", for example `/usr/bin/python3`.
- **macOS asks for permission** ("“Obsidian” would like to access files in …"). Click **Allow**. If you clicked
  "Don't Allow": System Settings › Privacy & Security › Files and Folders › Obsidian → turn the folder on
  (or add Obsidian to Full Disk Access). Then restart the panel.
- **Claude shows no selection** ("⧉ … lines selected" is missing). Check that Settings › AI Terminal ›
  "Claude Code IDE connection" is on. Then start a new Claude panel. Select the text in a **note**, not in the
  terminal. Type `/ide` to see the connection. The `get_selection` tool works even without this connection.
- **Claude shows "Opened changes in Obsidian ⧉" instead of the diff**: `/config` → Diff tool → terminal.
- **agy shows no note name when you click a note**: this is normal. Ask about "the note I have open" and agy looks
  it up, or run "Send note path to terminal" to type the path into the panel (see [Antigravity](#antigravity)).
- **agy shows no obsidian tools outside Obsidian**: this is normal. Only agy started from an Obsidian panel gets them.
- **Antigravity does not use the Obsidian tools** → restart the Antigravity panel; check that agy's settings contain
  `mcp(obsidian/*)`. The file is `~/.gemini/antigravity-cli/settings.json`.
- **"AI session snapshots are off — git is not available"**: install the Command Line Tools with `xcode-select --install`.
- **More details**: open the developer console (Cmd+Option+I). Lines from this plugin start with `[AI Terminal`.
  For more lines, run `localStorage.setItem('obsidian-ai-terminal:debug', '1')` there and reload the plugin.
  Tokens are always shown as `[REDACTED]`.

## Known limitations

- **Antigravity resumes its most recent conversation, not the conversation of each panel.** agy has no way to choose
  a conversation id at start. Two agy panels in one vault may continue the same chat after a restart.
- **The Claude Code IDE connection uses an undocumented protocol.** A Claude Code update could break the automatic
  selection. The bridge tools (`get_selection` …) keep working.
- **Desktop and macOS only.** No Windows, no Linux, no mobile.
- Enter in an Antigravity menu or prompt can make an extra snapshot when notes changed. This does no harm.
- Shift+Enter is made for Claude Code. In Antigravity it may act differently.
- A folder inside the vault that is its own git repository cannot be part of snapshots (the plugin tells you once).

## Development

```sh
npm install
npm run build        # → dist/: main.js, manifest.json, styles.css and the Python helper scripts
npm run dev          # rebuild dist/ on every change
npm test             # vitest + Python unittest suites (Python 3.9 and your python3)
npm run typecheck
```

- `src/main.ts` wires the feature modules (`src/*/index.ts`, `*Module.ts`) through the shared extension points in
  `src/core/` (services, spawn contributors, keyboard hooks, bridge routes, session events, ready gate).
- Every `src/**/*.py` that is not a test (`test_*.py`) or inside a `tests/` / `fixtures/` folder is copied flat into `dist/`.
- Tests never touch your real home folder: vitest and the Python runner use a temporary `HOME`.
- `tests/security/leaks.test.ts` boots the whole plugin and checks that no token appears in logs, Notices, panels,
  command lines, commit messages, settings or files (R15.1). Secrets must only be logged through `src/util/log.ts`.
- The design spec is `specs/obsidian-ai-terminal/spec.md`.
