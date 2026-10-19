# Loop Contract — paste-image

pre-approved-unattended-spec: yes

## Goal
Verify the implementation of specs/paste-image/spec.md (Cmd+V attaches a clipboard image in Claude Code / Antigravity panels) against its `## Requirements`. Implementation is complete; start by verifying.

## Gate 1 — Pass/Fail (100%)
- typecheck: `npm run typecheck`
- tests: `npm test` (vitest + Python suites)
- build: `npm run build`
- lint: none — the project defines no lint command

## Gate 2 — Quantitative
| metric | threshold |
|--------|-----------|
| failing tests in `npm test` | 0 |
| acceptance-test files whose sha256 differs from `gwt-tests.md` | 0 |

## Gate 3 — Qualitative (checker-scored)
- Spec alignment: the diff implements D1–D6 and no Non-goal; Constraints hold (text paste bytes unchanged, Ctrl+V unchanged, no new deps, no files written). Bar: 8/10.
- Code fit: the change matches `src/terminal/keyboard.ts` conventions (naming, comment density, error handling) and touches nothing outside the tasks' files. Bar: 8/10.
- Docs accuracy: the three doc changes describe the actual behaviour (agent profiles only, text wins, Shell unchanged). Bar: 8/10.

## Out of Scope (parked)
(none)

## Constraints
- Do not modify any test file listed in specs/paste-image/gwt-tests.md.

## Lessons
