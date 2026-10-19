# Spec: solarized-terminal-colors

## Meta
- **Created**: 2026-10-19
- **Type**: dev
- **Status**: approved
- **Mode**: unattended
- **Approved by**: unattended (request marker)
- **Approved at**: 2026-10-19

## Goal
"I'd like to add terminal color. it is solarized (https://github.com/shaunsingh/solarized.nvim)"

## Non-goals
- Importing or loading the Neovim plugin itself (Lua) or any of its non-terminal highlight groups (syntax, Treesitter, LSP, statusline) (inferred) — only its color palette applies to a terminal.
- A general theme editor or user-defined custom palettes (inferred).
- Changing the Obsidian UI colors outside the terminal panels (inferred).
- Making Solarized the default; "Follow Obsidian theme" stays the default (inferred).
- Per-profile colors (a different palette for the Claude, Antigravity and Shell panels) (inferred).

## Confirmed Goal
Add the Solarized color scheme, with the palette from shaunsingh/solarized.nvim, as a choice in Settings › AI Terminal › **Terminal colors**. Choosing it re-colors every open terminal panel (Claude Code, Antigravity, Shell) at once without restarting the program, like the existing Dark / Light choices.

Inferences beyond the literal request:
- Both Solarized variants are offered, **Solarized Dark** and **Solarized Light**, because the Neovim plugin ships both (it switches on `background`) and the existing setting already offers a dark and a light fixed palette (inferred).
- The choice is saved in the plugin settings and survives an Obsidian restart, like the other Terminal colors values (inferred).
- The 16 ANSI colors use the standard Solarized hex values; where the plugin's terminal mapping departs from Solarized (see Research), the standard Solarized slot is used (inferred).

Done when:
- The Terminal colors dropdown lists "Solarized Dark" and "Solarized Light" after the existing three choices.
- Choosing Solarized Dark gives an open panel background `#002b36` and foreground `#839496`; Solarized Light gives `#fdf6e3` and `#657b83` — without restarting the program in the panel.
- The xterm ANSI red/green/yellow/blue/magenta/cyan slots are `#dc322f` / `#859900` / `#b58900` / `#268bd2` / `#d33682` / `#2aa198`.
- In both variants the gray text slots (white, brightBlack, brightWhite) have at least 3:1 contrast with the background (inferred, from L2 review).
- The user guide documents the two new choices.
- `npm test` and `npm run typecheck` pass.

## Research

### Where terminal colors come from today
- The setting type is `TerminalColors = 'obsidian' | 'dark' | 'light'` with dropdown labels in `TERMINAL_COLOR_LABELS` (`src/settings.ts:15-23`); default `'obsidian'` (`src/settings.ts:83`).
- Stored values are validated against `Object.keys(TERMINAL_COLOR_LABELS)`; an unknown value falls back to the default (`src/settings.ts:95, 106`). Adding keys to the labels map therefore extends the allowed values with no extra validation code.
- The settings row "Terminal colors" builds its dropdown from `TERMINAL_COLOR_MODES` (`src/settings.ts:309-317`).
- `src/terminal/theme.ts` builds the xterm `ITheme`: `buildTheme(read, dark)` maps Obsidian CSS variables to all 16 ANSI slots plus background / foreground / cursor / cursorAccent / selection (`src/terminal/theme.ts:81-115`); `buildFixedTheme('dark' | 'light')` derives the fixed palettes from it (`src/terminal/theme.ts:121-125`); `resolveTheme(el, mode)` picks between them (`src/terminal/theme.ts:128-130`). The `Palette` type lists the required keys (`src/terminal/theme.ts:7-32`).
- `TerminalView.currentTheme` calls `resolveTheme` and, for any mode other than `'obsidian'`, paints the area around the grid with `theme.background` (`src/terminal/TerminalView.ts:196-200`). `applyTheme()` runs on `css-change` and when `terminalColors` changes (`src/terminal/TerminalView.ts:169, 191-193`; `src/terminal/index.ts:101`). A new fixed palette gets live switching and the surround color with no change to the view.
- xterm is created with `drawBoldTextInBrightColors: true` (`src/terminal/TerminalView.ts:284`), so bold text in ANSI colors 0–7 is drawn in the bright slot 8–15.

### The solarized.nvim palette (fetched via `gh api`, repo default branch `master`, last push 2024-04-21)
- `lua/solarized/colors.lua`: bases `base03 #002b36, base02 #073642, base01 #586e75, base00 #657b83, base0 #839496, base1 #93a1a1, base2 #eee8d5, base3 #fdf6e3`; accents `red #dc322f, green #859900, yellow #b58900, blue #268bd2, cyan #2aa198, magenta #d33682, violet/purple #6c71c4, orange #cb4b16`; `cursor #268bd2`; `selection #d3cfc1`. These are the standard Solarized values (Ethan Schoonover).
- `lua/solarized/colors.lua` (dark branch) sets `fg = base00` on `bg = base03` and light `fg = base0` on `bg = base3` — the reverse of standard Solarized (dark: base0 on base03; light: base00 on base3).
- `lua/solarized/theme.lua:185-202` (`loadTerminal`): slot 3 = purple and slot 5 = yellow (yellow and magenta swapped vs. ANSI), slots 9–15 repeat 1–7, slot 8 = `#073642`, slots 7/15 = `#eee8d5`.
- The repo is MIT licensed (`LICENSE`); hex color values carry no attribution requirement, but a source comment names the origin.

### Tests and docs
- Theme unit tests: `tests/terminal/theme.test.ts` (fixed palettes at lines 136-146).
- Live switching test: `tests/terminal/view.test.ts:308-328` ("Terminal colors = Dark … without restarting").
- Settings tests assert the dropdown's option keys exactly: `tests/settings.test.ts:204`, and merge fallback at `tests/settings.test.ts:207-213`.
- User doc: `docs/user-guide.md:77` lists the Terminal colors choices. README does not mention them.
- Prior spec requirement: `specs/obsidian-ai-terminal/spec.md` R2.8 (colors follow the Obsidian theme), D9.
- Commands: `npm test` (vitest + Python), `npm run test:ts`, `npm run typecheck` (`package.json`).

## Decisions

Complexity: Simple (0 signals — a static palette table, one settings enum, no external resources, no async, no new state shape). Brownfield: implementation checkpoints resolve from the existing fixed-palette pattern (L1). No checkpoint touches a fenced area (schema, data-loss migration, auth, payment, security).

L2 checkpoints (all resolved; Core 3/3, Scope 3/3, Error/Edge 4/4, Data 2/2, Implementation 2/2 — each 1.00; composite 1.00; 0 unknowns):
- Core: which variants (D1) · where chosen (D1) · live apply in open panels (L1 → D5)
- Scope: which panels (D1) · following Obsidian's light/dark (D6) · non-terminal UI (Non-goals)
- Error/Edge: readability of gray slots (D3) · bold text drawn in bright slots on each variant (D3) · stored value after a downgrade (D7) · CLIs that paint their own colors (D8)
- Data: stored setting values (D1) · palette shape (D4, D5)
- Implementation: palette location + dispatch (D5) · docs (D8)

### D1: Two new Terminal colors choices — `solarized-dark` "Solarized Dark" and `solarized-light` "Solarized Light"
- **Status**: assumed
- **Rationale**: The request names Solarized; the source plugin ships a dark and a light variant, and the setting already has a dark and a light fixed palette, so both are offered. They are added to `TerminalColors` and `TERMINAL_COLOR_LABELS` after `light`, so the dropdown order is: Follow Obsidian theme, Dark, Light, Solarized Dark, Solarized Light. They apply to every panel (Claude Code, Antigravity, Shell), like the other choices. Rejected: only Solarized Light (the plugin README says "based off of the Solarized Light Theme", but the user did not say light, and dark is the more common Solarized use); a separate "Color scheme" setting next to Terminal colors (two settings that both decide the background would conflict).

### D2: Background and foreground use standard Solarized, not the plugin's swapped pair
- **Status**: assumed
- **Rationale**: Solarized Dark = background base03 `#002b36`, foreground base0 `#839496`. Solarized Light = background base3 `#fdf6e3`, foreground base00 `#657b83`. solarized.nvim assigns `fg_dark = base00` in dark mode and `fg_light = base0` in light mode (L1), the reverse of Solarized's definition, which lowers text contrast in both modes (dark: base00 on base03 ≈ 3.4:1 vs base0 ≈ 4.7:1; light: base0 on base3 ≈ 2.9:1 vs base00 ≈ 4.1:1). Steelman against: the user pointed at this plugin and may expect the exact look they have in Neovim. Answer: the plugin calls itself "based off" Solarized and its variable names (`fg_dark`, `fg_light`) show the swap is a naming slip, not a design; the hex values themselves are identical to standard Solarized, so the scheme is recognizably the same and more readable. Rejected: copying the plugin's pair verbatim.

### D3: ANSI slot table
- **Status**: assumed
- **Rationale**: Normal hues, both variants: red `#dc322f` (1), green `#859900` (2), yellow `#b58900` (3), blue `#268bd2` (4), magenta `#d33682` (5), cyan `#2aa198` (6). Bright hues 9–14 repeat the normal hue — the plugin does the same (`theme.lua:196-201`) and so does the existing Obsidian mapping (`theme.ts` "bright = normal hue").
  Gray slots — rule: every gray slot used for text (7, 8, 15) has at least 3:1 contrast with the variant's background (WCAG 1.4.11 level for dim text); slot 0 (black) is exempt because programs use it mainly as a background color.
  - Dark (bg `#002b36`): black (0) base02 `#073642` (1.15:1, exempt), white (7) base2 `#eee8d5` (12.3:1), brightBlack (8) base00 `#657b83` (3.4:1), brightWhite (15) base3 `#fdf6e3` (13.9:1).
  - Light (bg `#fdf6e3`): black (0) base02 `#073642` (12.1:1), white (7) base00 `#657b83` (4.1:1), brightBlack (8) base01 `#586e75` (5.0:1), brightWhite (15) base01 `#586e75` (5.0:1). In light mode "white" must stay readable, the same rule the existing Light palette follows (white is a mid gray); bold black is drawn in slot 8, which stays dark (5.0:1). Slots 8 and 15 share base01 because no lighter Solarized base reaches 3:1 on base3 (base0 2.9:1, base1 2.5:1, base2 1.1:1).
  Rejected: (a) the plugin's slots 3 = violet and 5 = yellow (`theme.lua:190, 192`) — a program printing yellow would show violet, which breaks `ls`, git and the CLIs' warnings; (b) Solarized's original 16-color terminal mapping, where slots 9–15 are grays plus orange/violet — with `drawBoldTextInBrightColors: true` (L1) every bold green/blue/cyan text would turn gray, a well-known Solarized complaint; (c) the plugin's slot 8 `#073642` in dark mode, and base01 `#586e75` (2.8:1) — dim text (hints, comments) would vanish or fall under the 3:1 rule; (d) light slot 8 = base1 `#93a1a1` (2.5:1), for the same reason. Steelman against bright = normal hue: Solarized-aware tools (dircolors-solarized, Vim/tmux Solarized in 16-color mode) expect slots 8–15 to hold the base tones plus orange and violet, so they would show saturated hues where they expect grays, and orange/violet would be unavailable as ANSI colors. Answer: the programs this plugin runs (Claude Code, Antigravity, a shell with default `ls`/git colors) do not assume that layout, while bold-as-bright is always on and turning it off would change TerminalView for every palette (excluded by Constraints); a 24-bit program can still use orange and violet directly. Accepted trade-off: dark-mode black `#073642` on `#002b36` is low contrast; that is standard Solarized, and programs use black mainly as a background color.

### D4: Cursor and selection
- **Status**: assumed
- **Rationale**: cursor `#268bd2` (plugin's `cursor`) in both variants; cursorAccent = the variant's background. Selection: Light `#d3cfc1` (plugin's `selection`); Dark `rgba(147, 161, 161, 0.25)` (base1 at 25%), because the plugin's `#d3cfc1` under `#839496` text is unreadable in dark mode and base02 `#073642` is almost invisible on base03. `selectionInactiveBackground` = `selectionBackground`, as in `buildTheme`; `selectionForeground` is not set (text keeps its own color), as in `buildTheme`. Accepted trade-off: Light text `#657b83` on `#d3cfc1` is 2.9:1 — the same pair the plugin shows in Neovim's Visual mode; Solarized's own light selection base2 `#eee8d5` gives text 3.6:1 but is almost invisible on base3 (1.1:1), so a selection could not be seen. Rejected: one selection color for both variants; base2 for Light (invisible selection); a new non-Solarized tint.

### D5: Palettes live as constants in `src/terminal/theme.ts`; `buildFixedTheme` handles every non-`obsidian` mode
- **Status**: resolved (L1: existing pattern)
- **Rationale**: Add a `SOLARIZED` record (`dark` / `light`) of complete `Palette` objects (all 21 keys, so the type checker catches a missing slot) with a comment naming the source (shaunsingh/solarized.nvim, standard Solarized values) and noting the D2/D3 departures. `buildFixedTheme` widens to `Exclude<TerminalColors, 'obsidian'>` and returns the Solarized palette (plus `selectionInactiveBackground`) for the two new modes; `resolveTheme` stays `mode === 'obsidian' ? readObsidianTheme(el) : buildFixedTheme(mode)`. `TerminalView` needs no change: it already paints the surround with `theme.background` for any non-`obsidian` mode and reapplies on settings change (L1). Settings validation needs no new code: it reads the keys of `TERMINAL_COLOR_LABELS` (L1). Rejected: CSS variables / a stylesheet (xterm takes JS colors, and fixed palettes do not depend on Obsidian); a new `theme/solarized.ts` module (one 40-line table does not justify a file; theme.ts already holds the other palettes).

### D6: Solarized is fixed; it does not follow Obsidian's light/dark switch
- **Status**: assumed
- **Rationale**: Like Dark and Light, a Solarized choice ignores `css-change` theme switches. Rejected: a single "Solarized (follows Obsidian light/dark)" choice — it mixes the follow-Obsidian and fixed semantics in one value; the user can get it later as a third option if wanted.

### D7: No migration; older versions fall back
- **Status**: resolved (L1: `mergeSettings`)
- **Rationale**: The value is stored in the existing `terminalColors` field. A version of the plugin without these keys (downgrade) reads `solarized-*` as unknown and falls back to `obsidian` through the existing rule (`src/settings.ts:106`); no data is lost beyond that one choice. Rejected: a separate settings field.

### D8: Docs say what the setting does and does not color
- **Status**: assumed
- **Rationale**: `docs/user-guide.md` lists the two new choices. Claude Code and Antigravity draw much of their own UI with 24-bit colors from their own theme, which a terminal palette does not change; the guide says so in one sentence and points to Claude Code's `/theme` command. (Inversion probe: "every requirement passes, yet the user says Solarized did not apply" — the panel background and plain/ANSI text change, but Claude's own accent colors do not.) README is unchanged (it does not list the color choices).

## Constraints
- "Follow Obsidian theme" stays the default; the existing Dark and Light palettes keep their exact current values (their tests stay unchanged).
- No new runtime dependency; no change to `TerminalView` or `styles.css`.
- Hex values come from solarized.nvim `lua/solarized/colors.lua` (identical to standard Solarized), except the D4 dark selection color.
- Changing the choice re-colors open panels without restarting their programs (existing R2.8 behaviour).

## Known Gaps
(none)

## Requirements

### R0: Solarized is a Terminal colors choice that re-colors every panel — D1, D2, D3, D4, D5, D6, D7, D8

#### R0.1: Choosing Solarized re-colors open panels with the Solarized palette
- **Given**: the plugin is installed and a Claude Code, an Antigravity and a Shell panel are open
- **When**: the user picks "Solarized Dark" (or "Solarized Light") in Settings › AI Terminal › Terminal colors
- **Then**: all three panels show the Solarized background, foreground and ANSI colors at once, the programs keep running, and the choice is still set after Obsidian restarts

### R1: Settings offer and store the two Solarized choices — D1, D7

#### R1.1: Dropdown lists the Solarized choices after the existing three
- **Given**: default settings
- **When**: `AiTerminalSettingTab.display()` renders the "Terminal colors" row
- **Then**: the dropdown's option keys are, in order, `obsidian`, `dark`, `light`, `solarized-dark`, `solarized-light`, with labels "Follow Obsidian theme", "Dark (black background)", "Light (white background)", "Solarized Dark", "Solarized Light"; the selected value is `obsidian`

#### R1.2: Choosing a Solarized option is saved
- **Given**: the settings tab is open
- **When**: the "Terminal colors" dropdown changes to `solarized-dark`, then to `solarized-light`
- **Then**: `settings.terminalColors` is `solarized-dark`, then `solarized-light`, and the settings are saved each time

#### R1.3: Stored Solarized values load; unknown values still fall back
- **Given**: stored plugin data
- **When**: `mergeSettings({ terminalColors: 'solarized-dark' })`, `mergeSettings({ terminalColors: 'solarized-light' })` and `mergeSettings({ terminalColors: 'solarized' })` run
- **Then**: they return `solarized-dark`, `solarized-light` and `obsidian` respectively

### R2: Solarized Dark palette — D2, D3, D4, D5

#### R2.1: Background, foreground, cursor and selection
- **Given**: nothing (pure function)
- **When**: `buildFixedTheme('solarized-dark')` is called
- **Then**: `background` `#002b36`, `foreground` `#839496`, `cursor` `#268bd2`, `cursorAccent` `#002b36`, `selectionBackground` and `selectionInactiveBackground` `rgba(147, 161, 161, 0.25)`, and `selectionForeground` is undefined

#### R2.2: Hue slots
- **Given**: nothing
- **When**: `buildFixedTheme('solarized-dark')` is called
- **Then**: `red`/`brightRed` `#dc322f`, `green`/`brightGreen` `#859900`, `yellow`/`brightYellow` `#b58900`, `blue`/`brightBlue` `#268bd2`, `magenta`/`brightMagenta` `#d33682`, `cyan`/`brightCyan` `#2aa198`

#### R2.3: Gray slots
- **Given**: nothing
- **When**: `buildFixedTheme('solarized-dark')` is called
- **Then**: `black` `#073642`, `white` `#eee8d5`, `brightBlack` `#657b83`, `brightWhite` `#fdf6e3`

### R3: Solarized Light palette — D2, D3, D4, D5

#### R3.1: Background, foreground, cursor and selection
- **Given**: nothing
- **When**: `buildFixedTheme('solarized-light')` is called
- **Then**: `background` `#fdf6e3`, `foreground` `#657b83`, `cursor` `#268bd2`, `cursorAccent` `#fdf6e3`, `selectionBackground` and `selectionInactiveBackground` `#d3cfc1`, and `selectionForeground` is undefined

#### R3.2: Hue slots
- **Given**: nothing
- **When**: `buildFixedTheme('solarized-light')` is called
- **Then**: the same twelve hue values as R2.2

#### R3.3: Gray slots
- **Given**: nothing
- **When**: `buildFixedTheme('solarized-light')` is called
- **Then**: `black` `#073642`, `white` `#657b83`, `brightBlack` `#586e75`, `brightWhite` `#586e75`

### R4: Gray text slots stay readable — D3

#### R4.1: White, brightBlack and brightWhite reach 3:1 against the background
- **Given**: the WCAG relative-luminance contrast formula
- **When**: `buildFixedTheme('solarized-dark')` and `buildFixedTheme('solarized-light')` are called and `white`, `brightBlack`, `brightWhite` are compared with `background`
- **Then**: every ratio is ≥ 3.0

### R5: Open panels switch to and stay on Solarized without restarting — D5, D6

#### R5.1: Setting change re-colors an open panel and its surround
- **Given**: a running Shell panel with Terminal colors = `obsidian`
- **When**: `settings.terminalColors` is set to `solarized-dark` and `ctx.saveSettings()` runs
- **Then**: the panel's `terminal.options.theme.background` is `#002b36`, the `.ai-terminal-container` element has a non-empty inline `backgroundColor`, and no new PTY process was spawned

#### R5.2: Obsidian's theme switch does not override Solarized
- **Given**: an open panel with Terminal colors = `solarized-light`
- **When**: `body.theme-dark` is added and the workspace `css-change` event fires
- **Then**: `terminal.options.theme.background` stays `#fdf6e3`

#### R5.3: Back to Follow Obsidian theme clears the fixed surround
- **Given**: an open panel with Terminal colors = `solarized-dark`
- **When**: `settings.terminalColors` is set to `obsidian` and `ctx.saveSettings()` runs
- **Then**: `terminal.options.theme.background` is no longer `#002b36` and the container's inline `backgroundColor` is empty

#### R5.4: Solarized looks right in the real app (manual)
- **Given**: Obsidian with the built plugin, an open Claude Code panel and an open Shell panel in a git repository with a modified file
- **When**: the user switches Terminal colors to Solarized Dark, then Solarized Light, and runs `ls -G` and `git status` in the Shell panel
- **Then**: both panels and the area around each grid show the Solarized background (`#002b36` dark teal, then `#fdf6e3` cream); directory names in `ls -G` are blue (`#268bd2`) and the modified file in `git status` is red (`#dc322f`); a bold red word (`printf '\e[1;31mbold\e[0m\n'`) is still red, not gray

### R6: Existing color choices are unchanged — D5

#### R6.1: Dark, Light and Follow Obsidian keep their values
- **Given**: the existing theme tests
- **When**: `buildFixedTheme('dark')`, `buildFixedTheme('light')` and `buildTheme(read, dark)` are called
- **Then**: they return the same values as before this change (existing assertions in `tests/terminal/theme.test.ts` pass unedited)

### R7: User guide documents the choices — D8

#### R7.1: Settings section lists both Solarized choices
- **Given**: the repository docs
- **When**: `docs/user-guide.md` is read
- **Then**: the "Terminal colors" paragraph names "Solarized Dark" and "Solarized Light" along with the existing three choices

#### R7.2: The guide says CLIs keep their own colors
- **Given**: the repository docs
- **When**: `docs/user-guide.md` is read
- **Then**: the "Terminal colors" paragraph says Claude Code / Antigravity draw some colors themselves and mentions Claude Code's `/theme`

## Tasks

No task touches a fenced area (schema, data-loss migration, auth, payment, security); none is marked Fenced. There is no `[infra]` task, so every TT has no dependencies and they all run in parallel.

### TT1: acceptance tests for R1's GWTs
- **Fulfills**: R1 (tests)
- **Depends on**: (none)
- New file `tests/tt1_solarized_settings.test.ts` (render the settings tab like `tests/settings.test.ts`).

### TT2: acceptance tests for R2's GWTs
- **Fulfills**: R2 (tests)
- **Depends on**: (none)
- New file `tests/terminal/tt2_solarized_dark.test.ts`.

### TT3: acceptance tests for R3's GWTs
- **Fulfills**: R3 (tests)
- **Depends on**: (none)
- New file `tests/terminal/tt3_solarized_light.test.ts`.

### TT4: acceptance tests for R4's GWTs
- **Fulfills**: R4 (tests)
- **Depends on**: (none)
- New file `tests/terminal/tt4_solarized_contrast.test.ts` (compute WCAG contrast in the test; colors in `#rrggbb` form).

### TT5: acceptance tests for R5's GWTs
- **Fulfills**: R5 (tests)
- **Depends on**: (none)
- New file `tests/terminal/tt5_solarized_live.test.ts`, using the same harness as `tests/terminal/view.test.ts:308-328`. R5.4 is manual and gets no automated test.

### TT6: acceptance tests for R6's GWTs
- **Fulfills**: R6 (tests)
- **Depends on**: (none)
- New file `tests/terminal/tt6_existing_palettes.test.ts` pinning today's `buildFixedTheme('dark')` / `('light')` values (background, foreground, black, white, brightBlack, brightWhite, red) so a regression is caught.

### TT7: acceptance tests for R7's GWTs
- **Fulfills**: R7 (tests)
- **Depends on**: (none)
- New file `tests/tt7_docs_solarized.test.ts`, reading `docs/user-guide.md` like `tests/tt4_docs_image_paste.test.ts`; match wording loosely.

### T1: Solarized palettes and Terminal colors choices [vertical]
- **Fulfills**: R0, R1, R2, R3, R4, R5, R6
- **Depends on**: TT1, TT2, TT3, TT4, TT5, TT6  ← parallel with T2
- Files: `src/settings.ts` (extend `TerminalColors`, `TERMINAL_COLOR_LABELS`, the type's doc comment), `src/terminal/theme.ts` (`SOLARIZED` palettes per D3/D4 with a source comment, widen `buildFixedTheme` per D5), `tests/settings.test.ts:204` (the exact option-key list gains the two new keys — the only edit to an existing test). No change to `TerminalView.ts` or `styles.css` (Constraints).

### T2: Document the Solarized choices in the user guide [vertical]
- **Fulfills**: R7
- **Depends on**: TT7  ← parallel with T1
- File: `docs/user-guide.md` "Terminal colors" paragraph (`:77`): add "Solarized Dark" and "Solarized Light", and one sentence that Claude Code and Antigravity draw some colors themselves (Claude Code: `/theme`).

## External Dependencies

### Pre-work
(none)

### Post-work
- R5.4 manual check in Obsidian: `npm run build && npm run install-plugin -- <vault>`, then switch Terminal colors to Solarized Dark and Solarized Light with a Claude Code panel and a Shell panel open (`ls -G`, `git status`).

## Spec Review
- **Verdict**: PASS
- **Reviews**: 2
- **Fixed**:
  - [Testability] R5.4 — Given now opens the Shell panel (in a git repo with a modified file) to match Post-work; "readable" replaced with checkable colors (blue `ls -G` directories, red modified file, bold red stays red).
- **Open**: (none)
