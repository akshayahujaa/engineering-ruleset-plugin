# Engineering Ruleset Plugin — Design

**Date:** 2026-08-13
**Status:** Approved, pending implementation plan

## Purpose

A Claude Code plugin that carries a bundled set of GitHub branch rulesets and enforces them
locally, in any repository it is loaded into. It answers two questions:

1. *Advisory* — "what constraints apply to the branch I am on?"
2. *Blocking* — "is this specific git command allowed?"

The plugin is the only enforcement layer. The rulesets are not pushed to GitHub, so nothing
server-side backstops it. That is a deliberate choice for this step and is revisited in
Out of Scope.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Plugin location | Separate repo at `~/Desktop/engineering-ruleset-plugin` | Keeps it generic and reusable; `shop-ui` stays a clean test target |
| Ruleset source | Bundled `rulesets.json` | Deterministic, offline, no `gh` dependency |
| Enforcement | Blocking `PreToolUse` hook + advisory MCP tool | Rules that only advise are rules Claude can talk itself out of |
| Test target | `akshayahujaa/shop-ui` | Already cloned at `~/Desktop/devOps-agent` |

## Architecture

```
engineering-ruleset-plugin/
├── .claude-plugin/plugin.json    manifest
├── .mcp.json                     registers the MCP server
├── hooks/hooks.json              registers the PreToolUse guard
├── rulesets.json                 the 4 bundled GitHub rulesets
├── skills/ingest-rules/SKILL.md  /ingest-rules slash command + auto-trigger
├── src/
│   ├── ruleset-evaluator.ts      pattern matching + aggregation
│   ├── git-intent.ts             parses a shell command into git intents
│   ├── index.ts                  MCP server
│   └── guard.ts                  PreToolUse hook entry point
└── tests/
```

### Module boundaries

**`ruleset-evaluator.ts`** — pure. Takes `(branchName, rulesets, context)` and returns a
constraint matrix. No filesystem, no network, no `git`. Every branch-matching edge case is
tested here.

**`git-intent.ts`** — pure. Takes a shell command string, returns zero or more structured
intents (`create-branch`, `push`, `force-push`, `delete-branch`). No evaluation logic.

**`index.ts`** — MCP server. Reads `rulesets.json`, resolves branch context, calls the
evaluator, returns JSON.

**`guard.ts`** — hook. Reads stdin, calls `git-intent`, calls the evaluator, emits an
allow/deny decision.

The two consumers share the two pure modules and know nothing about each other.

## Bundled rulesets

Four rulesets, verbatim from the source GitHub config, stored as a JSON array.

| Ruleset | Applies to | Effect |
|---|---|---|
| `team-only-reviewer` | `prod` | PR + 1 approval + team `18199891`; no delete, no force-push |
| `Pull Request Compulsion` | default branch, `dev`, `test`, `prod` | PR required (0 approvals); no delete, no force-push |
| `PR-SCOPE-CHECK` | `dev` | status check `pr-scope/check`; no delete, no force-push |
| `Enforce Branch Nomenclature` | `~ALL` except `dev`, `test`, `prod`, `main`, and `feature/**`, `bugfix/**`, `hotfix/**`, `docs/**`, `chore/**` | restricts creation; PR + 1 approval |

The `source` field on each ruleset names `tehvault/frontend-app`, but rules are applied to
whatever repository the plugin is loaded into. The `required_reviewers` team id is org-scoped
and is reported as informational when the current repo is outside that org — it cannot be
verified locally.

## Ref pattern matching

Patterns are GitHub ref patterns, not shell globs. Semantics:

| Pattern | Matches |
|---|---|
| `~ALL` | every ref |
| `~DEFAULT_BRANCH` | the repo's default branch only |
| `refs/heads/dev` | exactly `dev` |
| `refs/heads/feature/**/*` | `feature/x`, `feature/x/y`, and deeper |
| `refs/heads/feature/**` | same as above |
| `*` | one path segment; does not cross `/` |
| `**` | any number of segments; crosses `/` |

Two bugs in the reference implementation this design corrects:

**Chained-replace corruption.** Converting the pattern with successive `String.replace` calls
lets a later step rewrite an earlier step's output. `refs/heads/feature/**/*` becomes
`refs/heads/feature(?:/.*)?` after the `**` pass, and the subsequent `*` → `[^/]*` pass then
rewrites the `.*` inside it, yielding `refs/heads/feature(?:/.[^/]*)?`. Nested branches such as
`feature/CU-123/api` stop matching. Fix: scan the pattern once, emitting regex per token, and
escape regex metacharacters (notably `.`) as literals.

**Unnormalized default-branch check.** `~DEFAULT_BRANCH` is compared against the raw input, so
it misses when the input is already `refs/heads/main`. Fix: normalize to a full ref before any
comparison.

The default branch name is resolved by the caller and passed in as context, so the evaluator
stays pure. Resolution order: `git symbolic-ref --short refs/remotes/origin/HEAD` with the
`origin/` prefix stripped, then `main`, then `master`.

## Evaluation algorithm

1. Normalize `branchName` to `refs/heads/<name>`.
2. Discard rulesets whose `enforcement` is not `active`.
3. For each remaining ruleset: if any `exclude` pattern matches, skip it; otherwise keep it if
   any `include` pattern matches. Excludes are evaluated first and win.
4. Aggregate the `rules` of all surviving rulesets.

Aggregation is a union, taking the strictest value where rules overlap:

```ts
{
  targetBranch: string
  normalizedRef: string
  matchedRulesets: string[]
  requiresPullRequest: boolean      // any pull_request rule
  minApprovals: number              // max across matched rulesets
  requiredStatusChecks: string[]    // union, deduped
  requiredReviewerTeams: number[]   // union, deduped
  preventDeletion: boolean          // any deletion rule
  preventNonFastForward: boolean    // any non_fast_forward rule
  restrictsCreation: boolean        // any creation rule
  unrecognizedRules: string[]       // rule types present but not understood
}
```

`minApprovals` takes the maximum, so `prod` matching both `team-only-reviewer` (1) and
`Pull Request Compulsion` (0) yields 1.

### Nomenclature detection

A branch name is invalid when a matched ruleset carries a `creation` rule — that is precisely
what the `creation` rule type means, and `Enforce Branch Nomenclature` is the ruleset that
carries it. Detection keys off `restrictsCreation`, never off the ruleset's display name, so
renaming a ruleset cannot silently disable the check.

## Blocking behaviour

The hook fires on `PreToolUse` for `Bash`. If the command contains no `git` token it exits
immediately without loading rulesets.

| Intent | Condition | Decision |
|---|---|---|
| `create-branch` | `restrictsCreation` on the new name | deny; message names the allowed prefixes |
| `push --force` / `--force-with-lease` | `preventNonFastForward` on the target | deny |
| `push` (direct) | `requiresPullRequest` on the target | deny; message says open a PR |
| `delete-branch` | `preventDeletion` on the target | deny |
| anything else | — | allow |

Commands are split on `&&`, `||`, and `;` and each segment is evaluated independently, so
`git checkout -b bad && git push` is caught.

Push refspecs are resolved to a target branch across all their forms: bare `branch`,
`local:remote`, `HEAD:branch`, and `:branch` (delete). A `git push` with no refspec targets the
current branch.

**Parse failures fail open.** A command the parser cannot confidently classify is allowed, and
the reason is surfaced in the hook's output rather than swallowed. Blocking on ambiguity would
make the plugin unusable; the cost is that a sufficiently exotic git invocation slips through.

## Hook contract

Input on stdin:

```json
{ "tool_name": "Bash", "tool_input": { "command": "..." }, "cwd": "/path/to/repo" }
```

Output on stdout for a denial:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Branch 'my-branch' violates nomenclature..."
  }
}
```

Allowed commands exit 0 with no output. The hook resolves branch context by running `git` in
the `cwd` supplied by the harness, not in the plugin directory.

## Advisory path

`skills/ingest-rules/SKILL.md` exposes `/ingest-rules` and triggers when the user asks about
branch rules or is about to commit or open a PR. It resolves the current branch, calls the MCP
tool `evaluate_branch_rules`, and reports the constraint matrix.

The MCP tool accepts an optional `targetBranch`; without it, the current branch is used.

## Error handling

| Failure | Behaviour |
|---|---|
| `rulesets.json` missing or malformed | Hook fails open and allows; MCP tool returns `isError` with the parse message |
| Not a git repository | Hook allows; MCP tool reports "not a git repository" |
| Branch cannot be resolved (detached HEAD) | Hook evaluates only intents carrying an explicit branch name; others allowed |
| Unknown rule `type` in a ruleset | Ignored, and named in `unrecognizedRules` on the matrix |

## Testing

Test-driven, evaluator first.

**Evaluator** — a branch-to-expected-constraints table covering `dev`, `test`, `prod`, `main`,
`feature/CU-123`, `feature/CU-123/api` (the nested case the reference implementation fails),
`chore/deps`, and `random-branch`. Plus pattern-level tests for `~ALL`, `~DEFAULT_BRANCH`,
exclude-beats-include, and metacharacter escaping.

**Intent parser** — one test per git form in the blocking table, plus compound commands,
refspec variants, and a deliberately unparseable command asserting fail-open.

**Hook** — stdin-to-stdout tests asserting the exact decision JSON for one allow and one deny.

**End-to-end** — load the plugin against the cloned `shop-ui` and confirm a bad branch name is
blocked and `feature/CU-1` is not.

## Out of scope

Steps 2–4 of the roadmap: ClickUp task lifecycle, PR scope checks in CI, and Kubernetes/Argo
access. Also excluded: pushing these rulesets to GitHub so they are enforced server-side, and
any `gh` API dependency.
