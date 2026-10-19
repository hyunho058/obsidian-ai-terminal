# Loop Contract — solarized-terminal-colors

pre-approved-unattended-spec: yes

## Goal
Verify the implementation of specs/solarized-terminal-colors/spec.md (Solarized Dark / Light Terminal colors) against its ## Requirements. Implementation is already complete — verify first, do not redo the work.

## Out of Scope (parked)
(none)

## Constraints
- Do not modify any test file listed in specs/solarized-terminal-colors/gwt-tests.md.

## Gate 1 — Pass/Fail (100%)
- build: `npm run build`
- typecheck: `npm run typecheck`
- tests: `npm test` (vitest + Python)
- lint: no lint script exists in package.json — not run

## Gate 2 — Quantitative
| metric | threshold |
|--------|-----------|
| acceptance tests (the 7 files in gwt-tests.md) passing | 25 / 25 |
| minimum gray-text-slot contrast (white, brightBlack, brightWhite vs background, both variants) | ≥ 3.0 |
| lines changed in src/terminal/TerminalView.ts and styles.css (Constraints) | 0 |

## Gate 3 — Qualitative (checker-scored, each ≥ 7/10 with grounds + action)
- Spec alignment: palette values, labels, order and behaviour match D1–D8 and R0–R7.
- Code fit: the new code reads like the surrounding code in theme.ts / settings.ts (naming, comment density, idiom), with no needless abstraction.
- Docs clarity: the user-guide paragraph is plain, accurate and in the doc's style.

## Lessons
