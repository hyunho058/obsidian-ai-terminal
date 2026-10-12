# AI Terminal for Obsidian

Use AI assistants like **Claude Code** and **Antigravity** inside Obsidian, right next to your notes.

## What is this?

Claude Code (from Anthropic) and Antigravity (from Google) are AI assistants that can read and edit files on your
computer. Normally you use them in the Terminal app, a window where you type text.

This plugin puts that window inside Obsidian as a panel. The AI starts in your vault folder, so it works directly
with your notes. You can ask things like:

- "Summarize the note I have open."
- "Explain the text I selected."
- "Find my notes about IELTS and make a list with links to them."
- "Fix the spelling in this note."

What you get:

- **AI panels in Obsidian.** Open Claude Code, Antigravity or a normal terminal as a panel, like any other tab.
- **The AI knows what you are looking at.** It can see the note you have open and the text you selected.
- **Changes show up at once.** When the AI edits a note, you see the change in Obsidian.
- **Undo for AI changes.** Before each message you send, the plugin saves a copy of your notes. If the AI breaks
  something, you can go back.

## What you need

- A **Mac** with the **Obsidian desktop app**, version 1.8 or newer. Windows, Linux and phones are not supported.
- **Claude Code** or the **Antigravity CLI** (or both), and an account for it:
  - Claude Code: [install guide](https://code.claude.com/docs/en/setup)
  - Antigravity CLI: [install guide](https://antigravity.google/product/antigravity-cli)
- **Apple's command line tools.** The plugin needs Python and git, which come with them. Open the **Terminal** app,
  paste this line and press Enter:

  ```sh
  xcode-select --install
  ```

  Then follow the window that opens. If it says the tools are already installed, you are done.

To check that the AI is ready, type `claude --version` (or `agy --version`) in Terminal. You should see a version number.

## Install

AI Terminal is not in Obsidian's community plugin list yet, so you install it by hand.

1. Open the [Releases page](https://github.com/hyunho058/obsidian-ai-terminal/releases/latest) and download
   `obsidian-ai-terminal.zip`. Double-click it to unzip. You get a folder named `obsidian-ai-terminal`.
2. In Obsidian, open **Settings › Community plugins**. If **Restricted mode** is on, turn it off.
3. Next to **Installed plugins**, click the **folder icon**. Finder opens the plugins folder of your vault.
4. Drag the `obsidian-ai-terminal` folder into it.
5. Back in Obsidian, click the **reload icon** next to **Installed plugins**. Then turn on **AI Terminal**.

If step 3 does not open a folder: open your vault folder in Finder and press Cmd+Shift+. to show hidden folders.
Open `.obsidian`, create a folder named `plugins` if there is none, and drag `obsidian-ai-terminal` into it.

## First start

1. Click the **terminal icon** in the left ribbon and pick **Claude Code** (or Antigravity, or Shell).
   A panel opens on the right.
2. The first time, you see a few questions:
   - "Enable AI session snapshots for this vault?" → click **Enable**. This turns on undo for AI changes.
   - The AI asks if you trust the folder → choose **Yes**.
   - macOS asks "“Obsidian” would like to access files in …" → click **Allow**.
   - Antigravity may ask you to sign in with Google.
3. Type your question in the panel and press Enter.

## How to use

| To do this | Do this |
| --- | --- |
| Open an AI panel | Click the terminal icon on the left, or press Cmd+P and type "AI Terminal" |
| Ask about a note | Click into the note, then ask in the panel: "summarize the note I have open" |
| Ask about part of a note | Select the text, click into the panel and ask: "explain the selected text" |
| Point the AI at a note | Click into the note, press Cmd+P and run "Send note path to terminal". The note's name appears in the panel. Add your question and press Enter |
| Start a new line without sending (Claude) | Shift+Enter |
| Copy / paste | Cmd+C / Cmd+V |
| Undo what the AI changed | See [Undo AI changes](#undo-ai-changes) |

Panels work like normal Obsidian tabs: you can drag them, split them or move them to another window, and the AI
keeps running. When you restart Obsidian, the panels come back and Claude continues its conversation.

### Undo AI changes

1. Press Cmd+P and run **"Restore notes from before an AI session…"**.
2. Pick a time from the list. It shows when it was, which AI, and the start of your message.
3. You see the notes that changed. Untick any note you changed yourself and want to keep.
4. Click **Restore**.

Restored by mistake? Run the command again and pick **"Before restore"**.

Snapshots save your notes only (`.md`, `.canvas` and `.base` files), not images, PDFs or settings.
They stay on your Mac, outside the vault.

## Safety

- **Do not type in a note while the AI is editing it.** One of the two changes can be lost. Keep Obsidian's
  **File Recovery** on (Settings › Core plugins). It keeps older versions of each note.
- **Your notes go to the AI company.** Notes and text the AI reads are sent to Anthropic (Claude Code) or
  Google (Antigravity), like everything else you send to these tools.
- **Read the AI's permission questions.** The AI can also change files that snapshots do not cover
  (images, settings, files outside the vault).
- **Snapshot history restarts after a vault move.** Moving or renaming the vault folder starts a new, empty history.
- **The plugin's own connection is local.** The link between Obsidian and the AI panels works only on your Mac and
  is locked with a key that changes every time. Other computers cannot reach it.
- **Clean up after you uninstall.** If you used Antigravity, open Terminal and run `agy mcp remove obsidian`.
  Obsidian cannot tell the plugin that it was removed, so the plugin cannot do this itself.
  See the [full clean-up steps](docs/user-guide.md#safety).

## Common problems

- **"Command not found: claude"**: Obsidian cannot find the AI program. In Terminal, run `which claude`
  (or `which agy`). Copy the path it prints, for example `/Users/you/.local/bin/claude`, into
  Settings › AI Terminal › "Claude Code command" (or "Antigravity command").
- **"Python 3 not found"**: install Apple's command line tools (see [What you need](#what-you-need)).
- **macOS blocked access** ("Operation not permitted"): open System Settings › Privacy & Security ›
  Files and Folders › Obsidian and turn on the folder of your vault. Then open a new panel.
- **A message says "Reload the plugin"**: in Settings › Community plugins, turn **AI Terminal** off, then on again.
  This closes the open panels.
- **Antigravity does not show the note name near its input box**: this is normal. Ask about "the note I have open",
  or run "Send note path to terminal".

For more, see [Troubleshooting](docs/user-guide.md#troubleshooting) in the user guide.

## More

- [User guide](docs/user-guide.md): every feature and setting, what the AI can see, where snapshots are saved,
  known limitations.
- [Development](docs/development.md): build from source, the in-app test checklist, running the tests.
