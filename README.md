# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mattthaphap-tech/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mattthaphap-tech/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

mend is one command-line tool that applies AI-written edits in four formats to a tree of text files:
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor
tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file (or standard input when absent or `-`). `--format` names one format
(`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it. `--check` does
everything but write. `--strict` matches lines exactly. See `SPEC.md` in the kit for the whole
contract; the practice set runs with `node check.ts <practice.json>`.

Built by [@matt](https://make.fun/r/w852s7sv) — try make.fun with my referral link.
