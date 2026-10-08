# loop.md — Loop Contract

> Supervisor document for verifying **obsidian-ai-terminal** (T1–T11, commits f3b29c1…f4224f0) against `specs/obsidian-ai-terminal/spec.md`.
> Status: **approved by user — 2026-10-07**

## Goal
Prove that the implemented plugin satisfies every sub-requirement in `spec.md` `## Requirements` (R0–R16, 123 sub-requirements incl. R10.11) and its `## Constraints`, without violating the approved Decisions D1–D35 — fixing gaps within the Auto-fix fence, and accounting for every requirement that can only be checked in the real Obsidian app.

## Scope & non-goals
- In: source under `src/`, tests under `tests/` and `src/**/test_*.py`, `README.md`, `styles.css`, build scripts. The loop may add tests, fix bugs that make a sub-requirement fail, and update docs.
- Out: the user's real state — `~/.claude*`, `~/.gemini/**`, `~/.config/obsidian-ai-terminal`, `~/.local/share/obsidian-ai-terminal`, every Obsidian vault. No real model calls. No changes to `spec.md` Decisions/Requirements (spec changes = escalate).

---

## Gate 1 — Pass/Fail  (100% required, binary)

| Check | Command |
|-------|---------|
| build | `npm run build` |
| typecheck | `npm run typecheck` |
| lint | N/A — no linter is configured in this project (TypeScript strict mode via typecheck instead) |
| tests (TS) | `npx vitest run` |
| tests (Python 3.9 + 3.14) | `npm run test:py` |
| no native modules | `test -z "$(find dist -name '*.node')"` |
| no orphaned helpers after tests | `! pgrep -f 'pty_bridge.py|mcp_shim.py'` |
| user's real state untouched | `test ! -e ~/.config/obsidian-ai-terminal && test ! -e ~/.local/share/obsidian-ai-terminal && [ -z "$(find ~/.claude/ide -name '*.lock' -exec grep -l '"ideName": *"Obsidian"' {} + 2>/dev/null)" ]` and the modification time of `~/.gemini/config/mcp_config.json` is identical before and after the test commands (`stat -f %m`, metadata only — the file is never opened) |

## Gate 2 — Quantitative  (measured vs threshold)

| Metric | Threshold | How measured |
|--------|-----------|--------------|
| Sub-requirements **missing or contradicted** by the code | **0** of 123 | Traceability matrix built by separate checker subagents (code + tests vs each Given/When/Then); a deviation listed as approved below does not count as contradicted |
| Sub-requirements **accounted for** (automated test OR an item in README "First run checklist") | **100%** (123/123) | Same matrix |
| Sub-requirements with an **automated test** that exercises the Given/When/Then | **≥ 70%** (≥ 87/123) | Same matrix (GUI-only items like real drag/popout, real IME, real macOS permission are expected to be checklist-only) |
| Full TS suite stability | **3/3** consecutive green runs of `npx vitest run` | run 3× |
| `dist/main.js` size | **≤ 4 MB** (now 2.8 MB) | `stat -f %z dist/main.js` |

## Gate 3 — Qualitative  (score + grounds + action; checker-scored, maker ≠ checker)
Each item must score **≥ 7/10**.

- **Spec alignment** — Decisions D1–D35 and every Constraint are honoured; deviations are only the approved ones below.
- **Security posture** — tokens never leak (argv/logs/notices/commits/data.json), servers bind 127.0.0.1 with per-run tokens, 0600 lock files, user configs never written (except the agy `obsidian` entry via `agy mcp`).
- **Robustness of process & session lifecycle** — no orphaned processes, sane shutdown on quit/crash/disable, resume/duplicate/move logic.
- **Architecture fit** — modules use the T1 extension points; no hidden cross-module coupling; clear seams.
- **User-facing clarity** — README (written for a non-native English reader), panel messages, Notices and dialogs are short, plain and actionable.

```
<item>: <score>/10
  grounds: <specific, checkable observation — file:line, measured fact>
  action: <change that raises it | "none — meets bar" + why>
```

---

## Approved deviations from the spec (made during implementation; approving this contract approves them)
1. **Enter during an AI-panel snapshot hold** (T4): Enter is *held*, not consumed and re-sent — keeps the last Korean IME syllable before the Enter.
2. **Bridge token for Claude** (T6): `--mcp-config` carries `Bearer ${OBSIDIAN_BRIDGE_TOKEN}`; the token is only in the panel's environment (not visible in `ps`). Claude's own subprocesses can see it (same as agy, D28).
3. **Snapshot staging** (T9): `git ls-files | update-index` instead of `git add -f -A` (the latter aborts in vaults without `.canvas`/`.base` files); same result.
4. **Typing while a panel is still starting** is dropped (T3) — prevents a double Enter from answering Claude's trust prompt unseen.
5. **"Stop them and restore"** leaves the stopped panels open with "press Enter to restart" (T3/T10); Cancel in that dialog returns to the file list.
6. **Claude transcript that exists but has no `cwd`** → new conversation ID silently (Claude refuses to reuse an existing `--session-id`) (T5).
7. **A foreign `obsidian` entry in agy's config** (not created by this plugin) is left untouched with a Notice, instead of being overwritten (T8). Turning the agy bridge off in one vault removes the single global entry.
8. **Missing git** disables snapshots for the session without saving "off" (T9); the Claude snapshot hook is also passed when the snapshot setting is "not asked yet" (the endpoint answers "disabled").
9. **Process clean-up is broader than D8** (T2): the helper signals every process group in the program's session, plus descendants; it also strips inherited terminal/Claude session variables from Obsidian's environment.
10. **`open_note`** reuses a tab already showing the note, clamps out-of-range lines, and tries `.md` when no extension is given (T6).

11. **agy `disable`** (T8): after updating the `obsidian` entry, the plugin runs `agy mcp disable obsidian` if the user had disabled it (because `add` re-enables). Approved 2026-10-07 in iteration 1.
12. **Selection pushed on connect** (T7): the current selection is sent to Claude 250 ms and 1.5 s after the IDE handshake (Claude drops an immediate one).
13. **Spawn-time snapshot failure wording**: `[Snapshot failed: <reason> — starting without a restore point]`.
14. **"git missing" Notice timing**: shown when snapshots are in use (on, or at the first AI panel when "not asked yet"); never when snapshots are off.
15. **Startup waits are capped** (agy entry 10 s, whole ready gate 20 s) so panels never hang on "Starting…".
16. **Symlinked vault**: the IDE lock file lists the vault's real path as well.
17. **Claude snapshot hook skipped** when the user's own profile args already contain `--settings` (a one-line notice explains), or when snapshots are off.
18. **On program exit** the panel leaves the alternate screen and resets input modes so the exit prompt is visible.
19. **Bridge tools off ≠ snapshots off** (iteration-1 decision): when `bridgeEnabled` is off but snapshots are on, the local server keeps running (127.0.0.1 + token) serving only `/snapshot`; `/mcp` and the MCP contributors are off. Also hardening: the agy relay is registered as `python -I <shim>`, and a foreign agy entry's command/URL is never shown in Notices or logs.

## Autonomy Boundary

**✅ Auto-fix (stay in the loop):** type/format errors; missing in-scope tests; bugs where code fails a sub-requirement's Given/When/Then without changing a Decision; docs/README/comments; local renames; behaviour-preserving refactors that keep Gate 1 green.

**🛑 STOP — call the user (escalate):**
- Anything that conflicts with `spec.md` Decisions/Requirements beyond the approved deviations above, or would change a user-visible behaviour the user chose.
- Security-sensitive changes: token handling, server binding/auth, lock-file permissions, anything that writes Claude's or agy's config.
- Anything that would touch the user's real state (see Scope › Out), or require a real model call or the real Obsidian GUI.

## Exit criteria
The loop exits only when **every** gate above passes and the Evidence Report is emitted. GUI-only sub-requirements are reported as "in-app checklist" items — they are accounted for, not claimed as passed.

---

## Lessons  (self-learning — carried across runs of THIS contract)

<!-- Append entries below. A fresh contract has none. -->
