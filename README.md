# engineering-ruleset-plugin

A Claude Code plugin that pushes branch rulesets into whatever GitHub repository you run it in.
Connect a repo, type `/enforce-rules`, and its GitHub rulesets are brought in line with the
declared policy through the REST API.

Enforcement is server-side. GitHub rejects violating pushes for every actor, whether or not the
plugin is installed on their machine.

## Usage

```
/enforce-rules            print the plan, write nothing
/enforce-rules --apply    print the plan, then apply it
```

Or directly:

```bash
node /path/to/engineering-ruleset-plugin/src/cli.js
```

The plan is always safe to run. Nothing is written until `--apply`.

## Adding an environment

Everything is generated from `ruleset-config.json`. Adding an environment is one line:

```json
"environments": {
  "dev":     { "statusChecks": ["pr-scope/check"], "statusCheckRuleset": "PR-SCOPE-CHECK" },
  "test":    {},
  "staging": {},
  "prod":    { "requiredApprovals": 1, "reviewerTeams": ["tehvault/reviewers"] }
}
```

`staging` is now covered by the pull-request requirement *and* excluded from the branch-naming
rule, because both rulesets are generated from the same environment list. An environment that
declares its own `statusChecks` or `requiredApprovals` gets its own ruleset, named
`status-checks-<env>` or `reviewers-<env>` unless you name it explicitly.

A repository can override the bundled policy by committing `.github/ruleset-config.json`, which
takes precedence.

## Generated rulesets

| Ruleset | Scope | Effect |
|---|---|---|
| `Pull Request Compulsion` | default branch + every environment | PR required; no deletion, no force-push |
| `PR-SCOPE-CHECK` | `dev` | status check `pr-scope/check` |
| `team-only-reviewer` | `prod` | 1 approval, from `tehvault/reviewers` where available |
| `Enforce Branch Nomenclature` | everything else | restricts creation; PR + 1 approval |

## Behaviour worth knowing

**Idempotent.** Rulesets are matched by name, so re-running updates in place rather than
creating duplicates. Server-side defaults GitHub fills in are not mistaken for drift.

**Never deletes.** A ruleset the config does not declare is reported as `UNMANAGED` and left
alone.

**Degrades loudly.** `required_reviewers` binds a GitHub team, which only resolves when the
repo's owner is that team's organisation. On a personal repo the team requirement is dropped,
the approval count is kept, and the plan says so.

**No bypass actors.** The rules bind everyone, including the repo owner. Once
`Pull Request Compulsion` is active, changing the default branch requires a pull request.

**Partial applies make progress.** Each ruleset is applied independently; one 422 does not stop
the rest, and the summary names what failed.

## Requirements

Node 18+ and either the `gh` CLI authenticated, or `GITHUB_TOKEN` with the `repo` scope. Admin
on the target repository. No npm dependencies and no build step.

```bash
npm test
```

## Not included

ClickUp task lifecycle, PR scope checks in CI, and Kubernetes/Argo access — steps 2–4 of the
roadmap. Also: tag rulesets, org-level rulesets, and deleting undeclared rulesets.
