# mend — one patch tool for every AI edit format

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xPicksu/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xPicksu/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in four
formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON text-editor tool calls. It finds the lines an edit names
at the first of three matching tiers (exact, trailing-whitespace-insensitive,
fully whitespace-insensitive, with re-indentation), and changes every file or
none. See `SPEC.md` for the whole contract.

## Run

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read from standard input.

Options:

- `--format=NAME` — `auto` (default), `unified`, `search-replace`, `v4a`, `json`
- `--check` — do everything but write: same output and exit code, no file changed
- `--strict` — match lines exactly (tier 0 only)

Exit codes: `0` with one line per changed file plus `ok: <n> files`;
`1` with one `error: <code> <path>` line per failed edit plus
`failed: <k> of <n> edits` (and nothing written); `2` with a single
`error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>` line.

Node 22 and its standard library alone; nothing is installed.

## Files

- `main.ts` — the CLI
- `runner.ts` — the trial runner (kept as the kit ships it)
- `check.ts` — runs the practice set: `node check.ts <practice.json>`
- `SPEC.md` — the specification

Practice score: 100/100 (1000). License: MIT.
