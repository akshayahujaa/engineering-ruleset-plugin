# Engineering Ruleset Plugin — Design

**Date:** 2026-08-13
**Status:** Approved (revised — supersedes the local-enforcement design)

## Purpose

A Claude Code plugin that pushes a maintained set of branch rulesets into whatever GitHub
repository it is run in. You connect a repo, type `/enforce-rules`, and the repo's GitHub
rulesets are brought in line with the declared policy through the REST API.

Enforcement is therefore **server-side**: GitHub rejects violating pushes for every actor, with
no dependency on Claude behaving. An earlier revision of this design enforced rules locally via
a blocking `PreToolUse` hook; that is dropped, because server-side rules are strictly stronger
and the hook would only duplicate them.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Enforcement point | GitHub Rulesets REST API | Binds every actor, survives a machine without the plugin |
| Trigger | `/enforce-rules` slash command | Explicit and on-demand, not a background surprise |
| Policy source | `ruleset-config.json`, compiled to rulesets | New environment = one line, no code change |
| Sync strategy | Match by name, create or update | Idempotent; re-running never duplicates |
| Safety | Plan printed, confirmation required | Writes to a live repo; `--apply` skips the prompt |
| Team reviewer rule | Degrade automatically | Personal repos can't require another org's team |
| Bypass actors | None | Rules bind everyone, repo admin included |

## Environment flexibility

The four source rulesets hardcode `dev`, `test`, and `prod` across three separate places, and
the branch-nomenclature exclude list has to repeat them. Adding `staging` means four correct
edits with no feedback if one is missed.

The plugin inverts this. A single config declares environments, and a compiler generates the
ruleset payloads:

```json
{
  "environments": {
    "dev":  { "statusChecks": ["pr-scope/check"] },
    "test": {},
    "prod": { "requiredApprovals": 1, "reviewerTeams": ["tehvault/reviewers"] }
  },
  "baseline": {
    "requirePullRequest": true,
    "requiredApprovals": 0,
    "preventDeletion": true,
    "preventForcePush": true,
    "includeDefaultBranch": true
  },
  "branchNaming": {
    "allowedPrefixes": ["feature", "bugfix", "hotfix", "docs", "chore"],
    "requiredApprovals": 1,
    "reviewerTeams": ["tehvault/reviewers"]
  }
}
```

Adding `"staging": {}` puts `staging` into the PR-required ruleset's includes and into the
nomenclature ruleset's excludes, in one edit. Nothing else changes.

### Generated ruleset names

For the config above the compiler emits exactly the four original rulesets, under their
original names, so an existing repo is updated rather than duplicated:

| Generated ruleset | Source |
|---|---|
| `Pull Request Compulsion` | `baseline`, applied to the default branch and every environment |
| `PR-SCOPE-CHECK` | the `dev` environment's `statusChecks` |
| `team-only-reviewer` | the `prod` environment's `requiredApprovals` / `reviewerTeams` |
| `Enforce Branch Nomenclature` | `branchNaming`, excluding every environment and prefix |

A new environment that declares its own `statusChecks` or `reviewerTeams` gets a derived name —
`PR-SCOPE-CHECK-staging`, `team-only-reviewer-staging` — so the canonical four keep their
identity while the set extends predictably. Environments that declare nothing extra add
themselves to the baseline ruleset only and generate no new ruleset.

## Architecture

```
engineering-ruleset-plugin/
├── .claude-plugin/plugin.json     manifest
├── commands/enforce-rules.md      the /enforce-rules slash command
├── ruleset-config.json            policy source of truth
├── src/
│   ├── compiler.ts                config → GitHub ruleset payloads
│   ├── github.ts                  REST client + repo/auth resolution
│   ├── sync.ts                    diff, plan, apply
│   └── cli.ts                     entry point, output formatting
└── tests/
```

**`compiler.ts`** is pure: config in, payload array out. No network, no filesystem. Every
generation rule is tested here without touching GitHub.

**`github.ts`** owns all I/O: resolving `owner/repo`, listing, creating, and updating rulesets.

**`sync.ts`** compares desired against actual and produces a plan; applying is a separate call,
so planning is always safe to run.

No MCP server. The slash command runs the CLI and reads its output — one process, one code
path, straightforward to debug.

## REST contract

| Operation | Call |
|---|---|
| List | `GET /repos/{owner}/{repo}/rulesets` |
| Create | `POST /repos/{owner}/{repo}/rulesets` |
| Update | `PUT /repos/{owner}/{repo}/rulesets/{id}` |

The stored ruleset JSON carries `id`, `source`, `source_type`, and timestamps, which are
response-only. Sending them back produces a 422, so the compiler emits only `name`, `target`,
`enforcement`, `conditions`, `rules`, and `bypass_actors`.

`GET` returns rulesets without their `rules` array; fetching a single ruleset by id is required
to diff rule contents. The plan step therefore fetches each existing ruleset individually.

**Auth** prefers the `gh` CLI, which is already authenticated with the `repo` scope, and falls
back to `GITHUB_TOKEN` or `GH_TOKEN` with `fetch`. Creating rulesets requires admin on the repo.

**Repo resolution** parses `git remote get-url origin`, accepting both
`https://github.com/owner/repo.git` and `git@github.com:owner/repo.git`.

## Degradation

`required_reviewers` binds a GitHub team and is only meaningful when the repo's owner shares the
team's organization. On a repo owned by a user account, or an org that does not contain the
named team, the compiler drops `required_reviewers` and keeps `required_approving_review_count`.
Each degradation is named in the plan output rather than applied silently.

For the current target, `akshayahujaa/shop-ui` is owned by a user account while
`tehvault/reviewers` belongs to the `tehvault` org, so `team-only-reviewer` will be created with
its approval count intact and its team requirement dropped.

## Plan and apply

`/enforce-rules` prints a plan and stops:

```
Repository: akshayahujaa/shop-ui (public, user-owned)

  CREATE  Pull Request Compulsion       → main, dev, test, prod
  CREATE  PR-SCOPE-CHECK                → dev
  CREATE  team-only-reviewer            → prod   [degraded: team requirement dropped]
  CREATE  Enforce Branch Nomenclature   → all except main, dev, test, prod, feature/**, …

  No bypass actors. After apply, direct pushes to main require a pull request.
```

Applying happens only after confirmation, or immediately with `/enforce-rules --apply`. Existing
rulesets whose contents already match are reported as unchanged and are not written.

## Consequences of no bypass actors

With `bypass_actors` empty, `Pull Request Compulsion` covers the default branch, so on
`shop-ui` every change to `main` — including the repo owner's — must go through a pull request,
and force-pushing or deleting `main`, `dev`, `test`, or `prod` is refused. This is intended, and
is restated in the plan output before any write.

## Error handling

| Failure | Behaviour |
|---|---|
| Not a git repository, or no `origin` | Abort with the reason; nothing is written |
| No `gh` auth and no token | Abort naming both remediation paths |
| Caller lacks admin on the repo | Abort on the 403, naming the required permission |
| API rejects a ruleset (422) | Report the ruleset, the field, and the message; continue with the rest, then exit non-zero |
| Config malformed | Abort with the failing key before any network call |
| Partial apply | Each ruleset is applied independently; the summary lists applied, skipped, and failed |

## Testing

Test-driven, compiler first.

**Compiler** — the four canonical rulesets are generated from the canonical config, asserted
field by field. Then: adding a bare environment extends the baseline includes and the
nomenclature excludes and creates no new ruleset; adding an environment with status checks
creates a derived ruleset; response-only fields never appear; degradation drops
`required_reviewers` and preserves approvals.

**Sync** — against a stubbed client: empty repo plans all creates; identical state plans no
writes; drifted state plans an update carrying the existing id; a 422 on one ruleset does not
prevent the others.

**Repo and auth resolution** — https and ssh remote forms, missing remote, missing auth.

**End-to-end** — plan against the real `akshayahujaa/shop-ui`, confirming it reports four
creates and flags the team degradation, without applying.

## Out of scope

Roadmap steps 2–4: ClickUp task lifecycle, PR scope checks in CI, Kubernetes and Argo access.
Also excluded: deleting rulesets the config no longer declares (reported as drift, never
removed automatically), tag and push rulesets, and org-level rulesets.
