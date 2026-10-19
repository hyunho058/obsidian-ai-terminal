# Spec: paste-image

## Meta
- **Created**: 2026-10-18
- **Type**: dev
- **Status**: approved
- **Mode**: unattended
- **Approved by**: unattended (request marker)
- **Approved at**: 2026-10-18

## Goal
"I'd like to build new function, It is image file attach to ai cli. first capture and than press 'command+v'."
Follow-up: "switch into the worktree and start create spec file using unattended mode"

## Non-goals
- Pasting an image into the **Shell** profile (inferred) — a plain shell has no image input; see D2.
- Drag-and-drop of image files onto the terminal panel (inferred).
- Pasting a file copied in Finder (clipboard holds a file reference, not image data) (inferred).
- Reading or decoding the image inside the plugin: saving it to disk, resizing, or converting formats (inferred) — the AI CLI reads the clipboard itself (D1).
- Windows / Linux (the plugin is macOS-only).

## Confirmed Goal
In a Claude Code or Antigravity (`agy`) terminal panel, the user takes a screenshot to the clipboard (e.g. Cmd+Ctrl+Shift+4) and presses **Cmd+V**: the image is attached to the AI CLI's prompt, the same way it is attached when pressing Ctrl+V in a native terminal. Text pastes keep working exactly as today.

Inferences beyond the literal request:
- "AI CLI" means the two agent profiles the plugin ships, `claude` and `agy` (inferred).
- When the clipboard holds both text and an image, Cmd+V pastes the text, as it does today (inferred).
- Ctrl+V keeps sending `\x16` unchanged, so the CLIs' own shortcut still works (inferred).

Done when:
- In a Claude panel, a screenshot copied to the clipboard followed by Cmd+V shows an image placeholder (`[Image #1]`) in Claude Code's prompt.
- The same in an agy panel shows agy's image attachment.
- A text paste with Cmd+V produces exactly the same PTY bytes as before this change (existing R4.3 test stays green).
- `npm test` and `npm run typecheck` pass.

## Research

### How the AI CLIs take an image from the clipboard
- Claude Code 2.1.303 (`~/.local/share/claude/versions/2.1.303`) reads the image from the macOS clipboard itself when it receives **Ctrl+V** (`\x16`): its binary contains "Paste images into Claude Code using control+v (not cmd+v!)", "No image found in clipboard" and the AppleScript class `«class PNGf»` (clipboard read via `osascript`). It shows a pasted image as `[Image #n]`.
- `agy` (`~/.local/bin/agy`) also binds `ctrl+v` and contains `PNGf` and changelog lines about clipboard image reading ("Allowed image pasting from the clipboard in local tmux sessions"). Both CLIs therefore need only the `\x16` byte; the image bytes never pass through the terminal.
- In a native terminal, Cmd+V with an image-only clipboard sends nothing (the terminal has no text to paste); that is why Claude tells users to use Ctrl+V.

### Current paste path in the plugin
- Cmd chords are routed in `createKeyRouter` (`src/terminal/keyboard.ts:147`); `terminalCmdAction` maps Cmd+V to `'paste'` (`src/terminal/keyboard.ts:61-81`).
- `paste(panel)` (`src/terminal/keyboard.ts:159-174`) reads `clipboard.readText()` and calls `term.paste(text)` only when the text is non-empty — so with a screenshot on the clipboard (no text) Cmd+V does nothing today.
- The keydown is cancelled (`cancel(event)`, `src/terminal/keyboard.ts:180`), so the browser's own paste event never fires.
- `typeInto(panel, data)` (`src/terminal/keyboard.ts:103-107`) sends bytes "as typed" through `term.input(data, true)`, so they queue behind an Enter hold like other keys (used for `KEY_SEQUENCES`).
- `TerminalClipboard` (`src/terminal/keyboard.ts:27-30`) has only `readText` / `writeText`. `createClipboard()` (`src/terminal/keyboard.ts:313`) wraps Electron's synchronous `clipboard` (loaded lazily with `require('electron')`, `src/terminal/keyboard.ts:295-311`) and falls back to `navigator.clipboard`.
- The keyboard module injects a clipboard override for tests (`src/terminal/keyboardModule.ts:10, 28`).
- The panel's profile is on the handle: `TerminalPanelHandle.profile` (`src/core/types.ts:31-33`); profile ids are `claude`, `agy`, `shell` (`src/session/profiles.ts:7-11`).

### Tests and docs
- Keyboard tests: `tests/keyboard/keyboard.test.ts` (Cmd+V text paste test at line 110), harness and `FakeClipboard` in `tests/keyboard/helpers.ts:13-25`; `openRunning(h, profile)` opens a running panel of a given profile (`tests/keyboard/helpers.ts:49`).
- Commands: `npm test` (vitest + Python), `npm run test:ts`, `npm run typecheck` (`package.json` scripts). Vitest collects `tests/**/*.test.ts` (`vitest.config.ts`).
- Docs list Cmd+V as "paste": `docs/user-guide.md:62`, `README.md:78`; the in-app checklist is `docs/development.md` (paste check at line 77).
- Prior spec for keyboard routing: `specs/obsidian-ai-terminal/spec.md` D10 / R4.3.

## Decisions

Complexity: Simple (0 signals — one key path in one module, no external resources, no persisted state). Brownfield: implementation checkpoints resolve from existing patterns (L1). All checkpoints below were answered from the request or L1, or chosen as "Agent decides" (`assumed`); none is fenced.

### D1: Cmd+V with an image on the clipboard sends Ctrl+V (`\x16`) to the program
- **Status**: assumed
- **Rationale**: Claude Code and agy both read the image from the macOS clipboard themselves when they receive Ctrl+V (L1), so the plugin only has to translate the key; the image never passes through the PTY and the CLI shows its own attachment UI (`[Image #1]`). Rejected: (a) write the clipboard image to a temp PNG and paste its path — Claude accepts image paths, but it adds file writes, cleanup and a privacy footprint (screenshots left on disk), and agy's handling of pasted paths is unverified; (b) make Cmd+V always send `\x16` — breaks text paste and bracketed paste (R4.3 of the prior spec); (c) leave it and document Ctrl+V — that is today's behaviour the user asked to change. Steelman against D1: the temp-file path works with any program, including one started by hand inside the Shell panel, and does not depend on the CLI being able to reach the clipboard. Answer: both supported CLIs already read the clipboard on Ctrl+V in every terminal, and a CLI that cannot (e.g. over SSH) prints its own "No image found in clipboard" hint, which is the same result the user would get in iTerm2; the Shell case is handled by D2.

### D2: Only the `claude` and `agy` profiles get the image translation; the Shell profile keeps today's behaviour
- **Status**: assumed
- **Rationale**: In zsh/bash `\x16` is `quoted-insert`: it would silently swallow the user's next key, a worse outcome than Cmd+V doing nothing. The plugin cannot cheaply tell which program is in the foreground of a Shell panel (it would need the PTY bridge to report the foreground process group). Rejected: translating in every profile (breaks the shell's next key); detecting the foreground program (new PTY-bridge protocol for a corner case). The profile is read from `panel.profile` at key time. Caveat: the profile id stands in for the program, and Settings › Profiles lets the user change a profile's command (`src/settings.ts`); a `claude` profile pointed at another program still gets `\x16` for an image paste. Accepted — the user chose to run that program as the Claude profile, and Ctrl+V in that program would send the same byte.

### D3: Text wins over an image
- **Status**: assumed
- **Rationale**: Order on Cmd+V: (1) non-empty clipboard text → paste the text exactly as today; (2) otherwise, an image on the clipboard and an agent profile → send `\x16`; (3) otherwise nothing is sent. Copying from a browser or an editor often puts text and an image on the clipboard together, and users expect the text; a screenshot (Cmd+Ctrl+Shift+3/4/5) puts only image data. Rejected: image first (would turn every rich-text copy into an image attachment).
  Edge cases, all keeping today's text-paste rules: "non-empty" means any string with length > 0, whitespace included (today's `deliver` pastes any truthy string); when `readText()` throws or rejects, the error is logged as today ("paste failed") and nothing is sent — the image check is not tried, since the clipboard could not be read; when `readText()` returns a Promise, the image check runs only after it resolves to an empty string. A file copied in Finder also puts its name on the clipboard as text, so rule (1) pastes the name as today even if an icon image is present.

### D4: Image detection through an optional `hasImage()` on `TerminalClipboard`, using Electron's `availableFormats()`
- **Status**: assumed
- **Rationale**: Add `hasImage?(): boolean` to `TerminalClipboard` (`src/terminal/keyboard.ts`). The Electron clipboard answers `clipboard.availableFormats().some((f) => f.startsWith('image/'))`; a throw counts as "no image". The `navigator.clipboard` fallback has no `hasImage`, which the router treats as "no image". The Electron wrapper is split out as an exported `clipboardFromElectron(electron)` so it can be unit-tested with a fake Electron clipboard (vitest cannot load `electron`). Rejected: `readImage().isEmpty()` (decodes the full bitmap on every Cmd+V); `navigator.clipboard.read()` (async and may ask for permission).

### D5: `\x16` is sent "as typed" through `typeInto`
- **Status**: resolved (L1: existing pattern)
- **Rationale**: `typeInto` (`term.input(data, true)`) is how every other translated key is sent, so the byte queues behind an Enter hold in order with the user's other input, like a text paste does. Rejected: `panel.sendInput` (bypasses the hold and could jump ahead of a held Enter).

### D6: Docs and in-app checklist mention image paste
- **Status**: assumed
- **Rationale**: Cmd+V's behaviour changes in a way the user cannot see in the key table, so `docs/user-guide.md` (keyboard table), `README.md` (shortcut table) and `docs/development.md` (first-run checklist, with an "Expect") each get a line. Rejected: no docs (the "paste" row would then be wrong for images).

## Constraints
- Text paste through Cmd+V must produce exactly the same PTY bytes as before (bracketed-paste markers included); the existing Cmd+V test (`tests/keyboard/keyboard.test.ts:110`) must pass unchanged.
- Ctrl+V keeps being sent by xterm as `\x16` in every profile, unchanged.
- No new npm dependencies; no files written by the plugin for this feature; the image bytes are never read by the plugin.
- IME handling and every other Cmd chord are unchanged.

## Known Gaps
- Whether `claude` / `agy` started by Obsidian (not from a terminal app) can read the clipboard through `osascript` is only checkable in the running app — covered by the manual check in Post-work. If that check fails (the CLI says "No image found in clipboard" for a screenshot that iTerm2 + Ctrl+V attaches), D1 is re-opened in favour of rejected option (a), temp PNG + pasted path, before the branch is merged.

## Requirements

Boundary used below: "Cmd+V is pressed" means a browser-like keydown of `{ key: 'v', code: 'KeyV', metaKey: true }` dispatched on the panel's xterm textarea, which reaches the key router registered by `createKeyboardModule` (`src/terminal/keyboardModule.ts`) — the `press(view, …)` helper in `tests/keyboard/helpers.ts`. "The PTY receives" means the fake PTY's `proc.input()`.

### R0: A screenshot pasted with Cmd+V is attached in the AI CLI — D1, D2, D3

#### R0.1: Screenshot attaches in Claude Code (manual)
- **Given**: the plugin is installed in a vault and a Claude panel is running; a screenshot was taken to the clipboard with Cmd+Ctrl+Shift+4
- **When**: the user presses Cmd+V in the Claude panel
- **Then**: Claude Code's prompt shows `[Image #1]`, and submitting the prompt sends the image to Claude

#### R0.2: Screenshot attaches in Antigravity (manual)
- **Given**: an agy panel is running and a screenshot is on the clipboard
- **When**: the user presses Cmd+V in the agy panel
- **Then**: agy shows its image attachment in the prompt, the same as pressing Ctrl+V does

### R1: Cmd+V sends Ctrl+V for an image-only clipboard in agent panels — D1, D3, D5

#### R1.1: Image-only clipboard in a Claude panel sends `\x16`
- **Given**: a running `claude` panel; the clipboard text is `''` and `hasImage()` returns true
- **When**: Cmd+V is pressed
- **Then**: the PTY receives exactly `\x16`, and the keydown is `defaultPrevented`

#### R1.2: Image-only clipboard in an agy panel sends `\x16`
- **Given**: a running `agy` panel; the clipboard text is `''` and `hasImage()` returns true
- **When**: Cmd+V is pressed
- **Then**: the PTY receives exactly `\x16`

#### R1.3: Text on the clipboard wins over an image
- **Given**: a running `claude` panel whose program enabled bracketed paste (`\x1b[?2004h`); the clipboard text is `'one\ntwo'` and `hasImage()` returns true
- **When**: Cmd+V is pressed
- **Then**: the PTY receives `\x1b[200~one\rtwo\x1b[201~` and no `\x16`; with clipboard text `' '` (a single space) the PTY receives `\x1b[200~ \x1b[201~` and no `\x16`

#### R1.4: Nothing on the clipboard sends nothing
- **Given**: a running `claude` panel; the clipboard text is `''` and `hasImage()` returns false (or the clipboard has no `hasImage` method)
- **When**: Cmd+V is pressed
- **Then**: the PTY receives nothing and the keydown is `defaultPrevented`

#### R1.5: A failed text read sends nothing and skips the image check
- **Given**: a running `claude` panel; the clipboard's `readText()` throws (and, in a second case, returns a rejected Promise); `hasImage()` would return true
- **When**: Cmd+V is pressed
- **Then**: the PTY receives nothing, `hasImage()` is not called, and `harness.logs` contains a line that includes `paste failed`

#### R1.6: An async text read is awaited before the image check
- **Given**: a running `claude` panel; `readText()` returns a Promise resolving to `''` and `hasImage()` returns true
- **When**: Cmd+V is pressed
- **Then**: `hasImage()` is first called after the Promise resolved, and the PTY then receives `\x16`; when the Promise resolves to `'hi'` instead, the PTY receives `hi` and no `\x16`

#### R1.7: The `\x16` queues behind a held Enter
- **Given**: a running `claude` panel with an Enter interceptor (`ctx.keyboard.onEnterIntercept`) that holds until released by the test; the clipboard is image-only
- **When**: the user presses Enter, then Cmd+V, and the interceptor is then released
- **Then**: before the release the PTY receives nothing; after it, the PTY input is `\r\x16` in that order

### R2: The Shell profile and Ctrl+V are unchanged — D2

#### R2.1: Image-only clipboard in a Shell panel sends nothing
- **Given**: a running `shell` panel; the clipboard text is `''` and `hasImage()` returns true
- **When**: Cmd+V is pressed
- **Then**: the PTY receives nothing and the keydown is `defaultPrevented`

#### R2.2: Ctrl+V still sends `\x16` in every profile
- **Given**: a running `shell` panel and, separately, a running `claude` panel
- **When**: Ctrl+V (`{ key: 'v', code: 'KeyV', ctrlKey: true }`) is pressed in each
- **Then**: each PTY receives exactly `\x16`

### R3: The Electron clipboard reports whether it holds an image — D4

#### R3.1: An image format means `hasImage()` is true
- **Given**: a fake Electron clipboard whose `availableFormats()` returns `['image/png']` (and, separately, `['text/plain', 'image/tiff']`)
- **When**: `clipboardFromElectron(fake).hasImage()` is called
- **Then**: it returns `true`

#### R3.2: No image format means `hasImage()` is false
- **Given**: a fake Electron clipboard whose `availableFormats()` returns `['text/plain']` (and, separately, `[]`)
- **When**: `clipboardFromElectron(fake).hasImage()` is called
- **Then**: it returns `false`

#### R3.3: A throwing `availableFormats()` means `hasImage()` is false
- **Given**: a fake Electron clipboard whose `availableFormats()` throws
- **When**: `clipboardFromElectron(fake).hasImage()` is called
- **Then**: it returns `false` and does not throw

#### R3.4: Text read and write still go to Electron
- **Given**: a fake Electron clipboard whose `readText()` returns `'abc'`
- **When**: `clipboardFromElectron(fake).readText()` and `.writeText('xyz')` are called
- **Then**: `readText()` returns `'abc'` synchronously (not a Promise) and the fake's `writeText` received `'xyz'`

### R4: Docs describe image paste — D6

#### R4.1: User guide keyboard table
- **Given**: `docs/user-guide.md`
- **When**: its keyboard table row for `Cmd+V` is read (by a test reading the file)
- **Then**: the row mentions pasting an image (screenshot) into Claude Code / Antigravity, and that text wins when both are on the clipboard

#### R4.2: README shortcut table
- **Given**: `README.md`
- **When**: its `Copy / paste` shortcut row (or a row next to it) is read (by a test reading the file)
- **Then**: it states that Cmd+V also attaches a clipboard image in Claude Code and Antigravity panels

#### R4.3: First-run checklist
- **Given**: `docs/development.md`
- **When**: its first-run checklist is read (by a test reading the file)
- **Then**: it has a step that takes a screenshot to the clipboard, presses Cmd+V in a Claude panel, with an `Expect:` naming `[Image #1]`

## Tasks

### T1: Clipboard image detection [infra]
- **Fulfills**: R3
- **Depends on**: (none)
- **Files**: `src/terminal/keyboard.ts` (clipboard section only: `TerminalClipboard`, `ElectronClipboard`, `electronClipboard`, `createClipboard`), `tests/keyboard/helpers.ts`
- **Work**: add `hasImage?(): boolean` to `TerminalClipboard`; add `availableFormats(): string[]` to `ElectronClipboard`; export `clipboardFromElectron(electron: ElectronClipboard): TerminalClipboard` (readText / writeText delegate; `hasImage` = `availableFormats().some((f) => f.startsWith('image/'))`, `false` on throw) and use it in `createClipboard()`; the `navigator.clipboard` fallback gets no `hasImage`. In `tests/keyboard/helpers.ts`, `FakeClipboard` gains `image = false`, `hasImage(): boolean` returning it, and a `hasImageCalls` counter. Existing tests stay green.

### T2: Cmd+V image branch in the key router [vertical]
- **Fulfills**: R0, R1, R2
- **Depends on**: T1, TT1, TT2
- **Files**: `src/terminal/keyboard.ts` (`KEY_SEQUENCES` and `paste` inside `createKeyRouter` only)
- **Work**: in `paste(panel)`, after the text is read (sync, or once the Promise resolves): non-empty text → `term.paste(text)` as today; empty text and `panel.profile` is `claude` or `agy` and `clipboard.hasImage?.()` is true → `typeInto(panel, '\x16')` (only while `panel.terminal === term`, like the text path); otherwise nothing. A throwing / rejecting `readText` keeps today's `paste failed` warning and returns before the image check. Add a `KEY_SEQUENCES` entry for the byte (e.g. `pasteImage: '\x16'`, commented "Cmd+V with an image on the clipboard — Ctrl+V, the AI CLIs read the image themselves"). Do not change any other key.

### T3: Docs and first-run checklist [vertical]
- **Fulfills**: R4
- **Depends on**: TT4  ← parallel with T2 (different files)
- **Files**: `docs/user-guide.md`, `README.md`, `docs/development.md`
- **Work**: the three doc changes in R4.1–R4.3, in the docs' existing tone; keep the README `## Safety` and other sections checked by `tests/readme.test.ts` intact.

### TT1: acceptance tests for R1's GWTs
- **Fulfills**: R1 (tests)
- **Depends on**: T1
- **Files**: new `tests/keyboard/tt1_image_paste.test.ts` (uses `makeKeyboardHarness`, `openRunning`, `press` from `tests/keyboard/helpers.ts`; a custom clipboard for R1.5 / R1.6 is passed through `makeKeyboardHarness({ keyboard: { clipboard } })`)

### TT2: acceptance tests for R2's GWTs
- **Fulfills**: R2 (tests)
- **Depends on**: T1
- **Files**: new `tests/keyboard/tt2_shell_image_paste.test.ts`

### TT3: acceptance tests for R3's GWTs
- **Fulfills**: R3 (tests)
- **Depends on**: T1
- **Files**: new `tests/keyboard/tt3_clipboard_image.test.ts` (calls `clipboardFromElectron` with a plain fake object)

### TT4: acceptance tests for R4's GWTs
- **Fulfills**: R4 (tests)
- **Depends on**: (none)
- **Files**: new `tests/tt4_docs_image_paste.test.ts` (reads the three doc files like `tests/readme.test.ts` does)

## External Dependencies

### Pre-work
(none)

### Post-work
- Manual in-app check (R0.1, R0.2, and the Known Gap): `npm run build && npm run install-plugin`, reload the plugin in Obsidian, take a screenshot with Cmd+Ctrl+Shift+4, press Cmd+V in a Claude panel (expect `[Image #1]`) and in an agy panel (expect agy's attachment). If either CLI reports "No image found in clipboard", re-open D1 before merging.

## Spec Review
- **Verdict**: PASS
- **Reviews**: 2
- **Fixed**:
  - [Readiness] T2 — Files line now includes `KEY_SEQUENCES` (the Work adds an entry there)
  - [Testability] R1.5 — Then now checks `harness.logs` contains a line including `paste failed` (the harness log sink has no level or line-start)
  - [Testability] R1.3 — the whitespace case now states the exact bytes `\x1b[200~ \x1b[201~`
  - [Grounding] Research — `src/terminal/keyboard.ts` line numbers corrected
- **Open**: (none)
