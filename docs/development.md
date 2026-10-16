# AI Terminal — Development

How to build the plugin from source, check it in the real Obsidian app, and run the tests.
For users, see the [README](../README.md) and the [User guide](user-guide.md).

## Build and install from source

Needs Node.js 22 or newer, plus everything listed under "What you need" in the README.

1. Build the plugin and copy it into your vault:

   ```sh
   npm install && npm run build && npm run install-plugin -- ~/Documents/MyVault
   ```

   Use the path of your own vault instead of `~/Documents/MyVault`.
   The script copies `dist/` to `<vault>/.obsidian/plugins/ai-terminal/`. Your plugin settings are kept.
   If the folder of the plugin's first id (`plugins/obsidian-ai-terminal/`) is there, the script copies its settings
   over once and tells you to delete that folder.

2. If you see **"Operation not permitted"**, macOS blocks your terminal app from the vault folder. Do one of these:
   - Open System Settings › Privacy & Security › **Files and Folders**. Find your terminal app (Terminal, iTerm …)
     and turn on the folder of your vault (for example "Documents"). Or add the terminal app under
     **Full Disk Access**. Then run the command again.
   - Or copy the files by hand in Finder. Copy the three files in `dist/` (`main.js`, `manifest.json`, `styles.css`)
     into `<vault>/.obsidian/plugins/ai-terminal/`. Create the folder if it does not exist. Press Cmd+Shift+. in
     Finder to see the hidden `.obsidian` folder.

3. In Obsidian, open Settings › **Community plugins**. Turn off **Restricted mode**. Then turn on **AI Terminal**.

4. Open a panel (see [Usage](user-guide.md#usage)). The first time, you see some questions:
   - "Enable AI session snapshots for this vault?" — click **Enable**.
   - Claude Code and Antigravity ask if you trust the folder. Say yes.
   - Antigravity may ask you to sign in.

## First run checklist

Do these steps once after you install. They check the things that only work inside the real Obsidian app.
"Expect" says what you should see. If a step fails, look at [Troubleshooting](user-guide.md#troubleshooting).
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

## Development

```sh
npm install
npm run build        # → dist/: main.js, manifest.json, styles.css (the Python helpers are inside main.js)
npm run dev          # rebuild dist/ on every change
npm test             # vitest + Python unittest suites (Python 3.9 and your python3)
npm run typecheck
```

- `src/main.ts` wires the feature modules (`src/*/index.ts`, `*Module.ts`) through the shared extension points in
  `src/core/` (services, spawn contributors, keyboard hooks, bridge routes, session events, ready gate).
- Obsidian installs only `main.js`, `manifest.json` and `styles.css`. So the Python helpers (every `src/**/*.py` that
  is not a test or inside a `tests/` / `fixtures/` folder) are bundled into `main.js` as text through
  `src/support/bundledScripts.ts`, and written into the plugin folder on load. `tests/build.test.ts` fails when a
  helper is missing from that list.
- Tests never touch your real home folder: vitest and the Python runner use a temporary `HOME`.
- `tests/security/leaks.test.ts` boots the whole plugin and checks that no token appears in logs, Notices, panels,
  command lines, commit messages, settings or files (R15.1). Secrets must only be logged through `src/util/log.ts`.
- The design spec is `specs/obsidian-ai-terminal/spec.md`.

## Releasing

The plugin is listed in the [Obsidian Community directory](https://community.obsidian.md). Obsidian scans every
release automatically (developer policies, code quality, known vulnerabilities, malware).

1. Set the new version (`x.y.z`, no `v`) in `manifest.json` and `package.json`, add `"x.y.z": "<minAppVersion>"` to
   `versions.json`, and commit it to `main`. The directory reads `manifest.json` from the default branch; Obsidian
   uses `versions.json` to offer an older release to people whose Obsidian is too old for the latest one.
2. Run `npm test` and `npm run build`.
3. Create a GitHub release. Its tag must be exactly the version in `manifest.json` (for example `0.1.0`).
   Attach `dist/main.js`, `dist/manifest.json` and `dist/styles.css`.
4. Check the result of the automated review in the developer dashboard on community.obsidian.md.

Rules worth knowing (see the [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
and [developer policies](https://docs.obsidian.md/Community+directory/Developer+policies)):

- The id (`ai-terminal`) must never contain "obsidian". Command ids must not contain the plugin id.
- The README section "What the plugin uses and accesses" must stay true: network use and files outside the vault
  have to be disclosed there.
- Obsidian's lint rules (`eslint-plugin-obsidianmd`) must pass without errors. Disabling an `obsidianmd/*` rule with
  a comment is not allowed; other `eslint-disable` comments need a description after `--`.
