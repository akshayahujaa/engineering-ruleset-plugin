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
# the repo in the current directory
node /path/to/engineering-ruleset-plugin/src/cli.js

# any repo, without cloning or cd-ing into it
node /path/to/engineering-ruleset-plugin/src/cli.js --repo tehvault/website
node /path/to/engineering-ruleset-plugin/src/cli.js --repo tehvault/website --apply
```

The plan is always safe to run. Nothing is written until `--apply`. Always read the plan before
applying to a repo that already has rulesets — matching is by name, so an existing ruleset with a
managed name is overwritten.

## Repositories you don't have access to

Targeting a repo you cannot reach stops before anything is written:

```
No repo access to acme/widgets.

It is either private and not shared with your account, or it does not exist.
GitHub returns the same 404 for both, so this cannot be narrowed down from here.

To continue, ask an owner to grant you admin on the repository:
  https://github.com/acme/widgets/settings/access
```

If someone has already invited you, the pending invitation is detected and described — who sent
it and what it grants. Accepting joins your account to that repository, so it never happens
automatically:

```bash
node src/cli.js --repo acme/widgets --accept-invite
```

On a real terminal you are asked instead of needing the flag. An invitation that grants less than
admin is refused up front, since rulesets cannot be managed without it.

## Repositories you can see but cannot administer

A repo you have read or write access to fails differently — it names the account you are
authenticated as, your effective role, and whether the gap is fixable:

```
No admin access to acme/widgets.

You are authenticated as 'akshayahujaa', who has write access.
Managing rulesets requires admin.

Ask an owner of the 'acme' organisation to grant you the Admin role:
  https://github.com/acme/widgets/settings/access

If a different account of yours already has admin, switch to it and re-run:
  gh auth switch          (or: gh auth login)
```

**Personal-account repositories are a dead end.** GitHub reserves admin on them for the owner —
collaborators top out at write — so no invitation, role change, or access link will unblock a
sync. The command says so rather than sending you to a settings page that cannot help. The rules
have to be applied by the owner, or the repo moved into an organisation.

Because the plugin authenticates through `gh`, running `gh auth switch` to an account that does
have admin is all that is needed; nothing in the plugin has to be reconfigured.

## ClickUp task sync

When `clickup.enabled` is set, the sync also installs
`.github/workflows/clickup-sync.yml` in the target repo. On a merged PR into `dev` it reads the
task id from the branch name and moves the task to **in progress** — but only if it is still in a
to-do status. A task already in progress, in review, or done is left alone, so a later merge can
never drag it backwards.

This runs on GitHub rather than locally because a merge is a GitHub event: nothing on a
developer's machine can react to someone else merging a PR.

### The branch name is the link

`branchNaming.requireTaskId` narrows every prefix from `feature/**` to `feature/CU-<id>[/…]`, so
the ruleset itself guarantees each branch carries a task:

```
feature/CU-123/checkout-redirect     ✓ task 123
feature/CU-86c1abcde                 ✓ task 86c1abcde
feature/checkout-redirect            ✗ blocked at creation
```

**This tightens an existing rule.** Once applied, branches without an id are refused at creation.
Existing branches are untouched, but the next one your team makes must carry a task id.

### The token

The plugin never handles it. The sync only *checks whether* the secret exists and prints the
command to set it — the value is read straight into GitHub's encrypted store, never through this
tool, your shell history, or the process table:

```bash
gh secret set CLICKUP_TOKEN --repo owner/name
```

Get the token from ClickUp: **Settings → Apps → API Token**. If your workspace uses ClickUp
Custom Task IDs, also set `CLICKUP_TEAM_ID`; the workflow switches to the custom-id endpoint when
it is present.

Without the secret the workflow still runs, logs a warning, and changes nothing.

## Environment branches

Connecting a repo creates `dev`, `test`, and `prod` from the default branch if they are missing —
a ruleset naming `refs/heads/dev` protects nothing while that branch does not exist.

**The order is forced.** `Pull Request Compulsion` requires a pull request for `dev`, and creating
a branch counts as a direct push, so once that ruleset is active GitHub refuses the creation with
a 422. Branches are therefore created *before* rulesets are written.

On a repo that has already been synced, the rulesets that would refuse the creation are dropped to
`evaluate`, the branches are created, and enforcement is restored — reported in the plan before
anything happens:

```
  CREATE   dev, test, prod                → environment branch(es), from main
             [PR-SCOPE-CHECK, Pull Request Compulsion, team-only-reviewer would refuse this;
              each is dropped to 'evaluate' only while the branches are created,
              then restored to 'active']
```

The restore runs in a `finally` and handles each ruleset independently, so neither a branch that
fails to create nor one failed restore can leave the rest of the repository unprotected — and a
ruleset whose restore did fail is reported by name, loudly, with a non-zero exit. There are tests
for exactly those cases. It is still a brief window where the default branch is unguarded, which
is why the plan says so up front.

### First sync of a repository

On a repo with no rulesets yet, the CLI (on a real terminal) asks once whether you want any
environment beyond the defaults:

```
First sync of this repository. Default environments: dev, test, prod.
Extra environments beyond these? (comma-separated, empty for none)
```

Under the `/enforce-rules` slash command stdin is a pipe, so the CLI stays silent and Claude asks
the same question with a widget instead, passing the answer back as `--env`. A re-sync never asks.

### Which policy applies, and where `--env` lands

| How the target was named | Policy comes from | `--env` persists to |
|---|---|---|
| implicit (cwd) | `.github/ruleset-config.json` in the working tree, else the plugin default | that same file |
| `--repo owner/name` | `.github/ruleset-config.json` **committed in the target repo** (fetched via the API), else the plugin default | the plugin default; refused if the target commits its own override |

The caller's working directory never influences a `--repo` run — standing in one repo while
targeting another used to silently apply the wrong policy. A committed override that is not valid
JSON fails the run outright rather than silently falling back to a policy the repository
explicitly replaced.

If the plugin is installed as a marketplace clone, a persisted `--env` edit is lost on
`claude plugin marketplace update`; the CLI warns when this is the case. Durable policy changes
belong in the plugin repository itself.

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
