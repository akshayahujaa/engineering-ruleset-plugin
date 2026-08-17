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

The plan is always safe to run. Nothing is written until `--apply` — with one deliberate
exception: `--set-token` writes the tracker credentials the moment you confirm them at gh's
hidden prompt, in plan mode too, and the output says so. Always read the plan before
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

## Task sync — ClickUp or Jira

When `taskSync.enabled` is set (a legacy `clickup` section still works), the sync also installs a
tracker workflow in the target repo — `.github/workflows/clickup-sync.yml` or `jira-sync.yml`,
by `taskSync.provider`. It fires on a merged PR into **any** environment and moves the linked task
to that environment's status.

### The pipeline

**Only declared environments are stages**, and the **order of `environments` is the pipeline
order**. A stage's status comes from `taskSync.environmentStatuses`; where that is silent, `dev`,
`test` and `prod` fall back to their conventional meanings and any other name falls back to
itself:

```jsonc
"environments":  { "dev": {…}, "test": {…}, "prod": {…} },   // ← this order is the pipeline
"taskSync": {
  "environmentStatuses": { "dev": "in progress", "test": "QA", "prod": "done" }
}
```

An entry for an environment that is not declared does nothing — the shipped config names all
three, but a repo that has only `dev` gets a one-stage pipeline until it adds the others.

```
merge into dev   → in progress
merge into test  → QA
merge into prod  → done
merge into staging → staging      (no entry needed: an env defaults to its own name)
```

Add `staging` and it becomes a stage automatically, with a `staging` status — the workflow is
regenerated with the new trigger branch and the new mapping. Set an environment's status to
`null` to keep it out of task sync entirely; if that leaves no stages at all, no workflow is
installed and an existing one is removed.

**Forwards only.** Each stage has a rank; every to-do spelling is rank 0. A merge advances a task
only when its current status ranks *below* the arriving stage, so merging an old branch into `dev`
can never pull a finished task back to *in progress*:

```
to do       → merge to test  → moves to QA
in progress → merge to test  → moves to QA
QA          → merge to dev   → left alone (already past 'in progress')
done        → merge to prod  → left alone (already at 'done')
blocked     → merge to test  → left alone (not in the pipeline — never guessed at)
```

A status the config never declares is deliberately left alone rather than ranked, because it could
sit anywhere in the workflow — including past the end.

Because rank follows the order of `environments`, an environment added later lands **last**. If
your real pipeline puts it earlier (staging before prod, say), reorder `environments` in the
config; the plan prints the resulting pipeline every run so the order is visible before you apply.

On a repository's first sync you are asked which tracker to use — ClickUp (default), Jira, or
none — on a terminal by the CLI itself, under the slash command via a widget, and `--provider`
answers it non-interactively. Switching provider later plans a `DELETE` of the other provider's
workflow: leaving it behind would have both trackers moving tasks on every merge. Only the two
managed workflow paths are ever considered for that.

Jira credentials follow the same conventions as the pr-guardrails scope-check suite, so one
repository setup feeds both: `JIRA_BASE_URL` and `JIRA_EMAIL` as repository **variables** (not
sensitive), `JIRA_API_TOKEN` as a **secret**. The Jira workflow finds the transition to the
target status by name at run time — transition ids are per-project and cannot be baked in.

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

The plugin never sees it — but it can drive setting it. On a real terminal:

```bash
node src/cli.js --repo owner/name --set-token
```

hands your terminal to `gh secret set`, which prompts with **hidden input**, encrypts the value
locally against the repository's public key, and uploads it. The token goes keyboard → gh →
GitHub; it never enters the plugin process, your shell history, or the process table. There is
deliberately no way to pass it as an argument. An interactive `--apply` offers the same hand-off
when the secret is missing; anywhere without a terminal (the slash command included) the CLI
refuses and prints the command for you to run yourself. Setting it directly works too:

```bash
gh secret set CLICKUP_TOKEN --repo owner/name
```

Get the token from ClickUp: **Settings → Apps → API Token**. If your workspace uses ClickUp
Custom Task IDs, also set `CLICKUP_TEAM_ID`; the workflow switches to the custom-id endpoint when
it is present.

Without the secret the workflow still runs, logs a warning, and changes nothing. The sync only
ever *checks whether* the secret exists — the API cannot return its value.

## Reviewers and teams

`required_reviewers` binds a GitHub **team**, and teams exist only inside organisations. What the
sync does depends on what the target repo can actually honour:

| Target | Reviewer rule |
|---|---|
| org repo, team exists with members | bound to the team, by its resolved id |
| org repo, team missing | the team is **created** and whoever ran the sync is **added to it**, then bound — shown in the plan first, because it changes org membership |
| org repo, team exists but empty | team requirement dropped: an empty team can never approve |
| personal repo, ≥2 collaborators | team dropped (impossible outside an org); the approval count survives |
| solo repo (org or personal) | team **and** approval count dropped; the reviewer ruleset is not created |

**Everything is measured against what the repo can actually supply.** GitHub does not let you
approve your own pull request, so N accounts with write access yield at most **N−1** approvals. A
rule demanding more than that can never be satisfied — it would not harden the repo, it would
brick it, permanently blocking every merge. So the count is reduced to what is achievable and the
shortfall is named:

```
  [degraded: required_approving_review_count reduced to 0 — you are the only account with write
   access, and GitHub forbids approving your own pull request — at most 0 approval(s) can ever be
   supplied, but 1 is required]
    to restore it: add a second collaborator with write access, then re-run
```

If the collaborator list cannot be read, the requirement is **assumed satisfiable** and kept — a
permissions hiccup must never silently strip a policy the repo can honour.

Reviewer teams are named by **slug** (`tehvault/reviewers`, from the team's GitHub URL), not by
display name. A display name is refused up front, because GitHub would derive a different slug and
every later run would fail to find the team.

### Leftovers the sync will not touch

A ruleset the config no longer declares is reported as `UNMANAGED` and left alone. If it is
*actively blocking merges* — demanding a review this repo cannot supply — that is called out
rather than presented as a non-event, since it is usually the reason a branch has become
unmergeable:

```
  UNMANAGED  team-only-reviewer  → not in config; left untouched
             ⚠ THIS RULESET IS BLOCKING MERGES into prod: it demands a review
               this repository cannot supply (at most 0 approval(s) available).
```

A reviewer ruleset the sync *does* manage but which cannot survive here is **neutered rather than
abandoned** when it already exists — dropping it from the desired set would leave the live one
blocking merges forever. Its deletion and force-push protection stay.

An update also names any ref leaving a ruleset's scope, because a full replace silently removes
that ruleset's protection from it:

```
  UPDATE   Pull Request Compulsion  → ~DEFAULT_BRANCH, dev
           [no longer covers test, prod — those refs lose this ruleset's protection]
```

## Environment branches

A first sync sets every rule up for **`dev` only**. `test` and `prod` are *profiles*: known names
carrying their own policy, added when you ask for them, never before. This keeps a freshly
connected repo to one working environment instead of three, and means `prod` arrives with its
stricter policy intact rather than as a bare branch:

```jsonc
"environments":        { "dev": { "statusChecks": ["scope-check"] } },
"environmentProfiles": {
  "test": {},
  "prod": { "requiredApprovals": 1, "reviewerTeams": ["tehvault/reviewers"] }
}
```

Adding `prod` later — by answering the first-sync question, or `--env prod` — produces exactly the
same rulesets as declaring it up front. An unknown name (`staging`, `uat`) is added plain: it picks
up the baseline PR requirement and is excluded from the nomenclature ruleset, which is the whole
point of the environment list.

Connecting a repo creates the declared environments from the default branch if they are missing —
a ruleset naming `refs/heads/dev` protects nothing while that branch does not exist.

**The order is forced.** `Pull Request Compulsion` requires a pull request for `dev`, and creating
a branch counts as a direct push, so once that ruleset is active GitHub refuses the creation with
a 422. Branches are therefore created *before* rulesets are written.

On a repo that has already been synced, the rulesets that would refuse the creation are disabled,
the branches are created (and the workflow file committed), and enforcement is restored — reported
in the plan before anything happens. (`evaluate` would be gentler, but it is an Enterprise-plan
feature; on every other plan GitHub refuses it with a 422.)

```
  CREATE   dev, test, prod                → environment branch(es), from main
             [PR-SCOPE-CHECK, Pull Request Compulsion, team-only-reviewer would refuse this;
              each is disabled only while the branches are created,
              then restored to 'active']
```

The restore runs in a `finally` and handles each ruleset independently, so neither a branch that
fails to create nor one failed restore can leave the rest of the repository unprotected — and a
ruleset whose restore did fail is reported by name, loudly, with a non-zero exit. There are tests
for exactly those cases. It is still a brief window where the default branch is unguarded, which
is why the plan says so up front.

### First sync of a repository

On a repo with no rulesets yet, the CLI (on a real terminal) asks once whether you want any
environment beyond the defaults. Where it cannot ask — under `/enforce-rules`, stdin is a pipe —
it prints a `━━ FIRST SYNC ━━` banner naming both defaults instead, so the choice is never made
silently and the caller has something explicit to act on:

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
