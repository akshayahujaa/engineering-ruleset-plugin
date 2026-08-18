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

## No GitHub credentials at all

Before anything repo-specific is even attempted, the CLI needs some way to reach GitHub — an
authenticated `gh` CLI, or `GITHUB_TOKEN`/`GH_TOKEN` with the `repo` scope. Without either, it does
not just print an error and stop: on a real terminal, with `gh` installed, it offers to log you in
right there:

```
No GitHub credentials found for the gh CLI.
Log in now with 'gh auth login'? [y/N]
```

Say yes and the terminal is handed to `gh auth login` — the same hand-off pattern used for setting
task-tracker secrets. It walks you through GitHub's own device-code or browser flow and stores the
result itself; nothing here ever sees a token. Once it succeeds, the run continues exactly as if
you had already been logged in.

Anywhere without a terminal — including under `/enforce-rules`, where stdin is a pipe — this is
never attempted: `gh auth login` asks interactive questions a pipe cannot answer, so trying it
there would hang rather than help. Instead the CLI refuses immediately with the exact command to
run yourself:

```
No GitHub credentials. Run this yourself, in your own terminal:

    gh auth login

or set GITHUB_TOKEN to a token with the 'repo' scope.
```

If `gh` itself is not installed, the message says that instead, with a link, since there is nothing
to hand the terminal to.

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

The plugin never sees it — but it can drive setting it, and on a real terminal it offers to, at
the moment it matters most: right after a tracker is picked. Choosing (or simply accepting the
default) **ClickUp** as the provider — whether at the first-sync question or via `--provider
clickup` — immediately asks:

```
Set up ClickUp credentials now, via gh's hidden prompt? [y/N]
```

Say yes and your terminal is handed to `gh secret set`, exactly like the `gh auth login` hand-off:
it prompts with **hidden input**, encrypts the value locally against the repository's public key,
and writes it straight into that repository's Actions secrets. The token goes keyboard → gh →
GitHub; it never enters the plugin process, your shell history, or the process table, and there is
deliberately no way to pass it as an argument. This happens even in **plan mode** — the same
deliberate exception `--set-token` already makes to "the plan never writes," so you are not asked
the identical question twice, once now and once again at `--apply`. Decline and nothing is
written; the plan falls back to printing the manual command instead.

For **Jira**, the same moment first asks for `JIRA_BASE_URL` and `JIRA_EMAIL` — ordinary repository
variables, not sensitive, answered in the clear — then takes `JIRA_API_TOKEN` at gh's hidden
prompt the same way.

You can also trigger this later, standalone:

```bash
node src/cli.js --repo owner/name --set-token
```

An interactive `--apply` offers the same hand-off again if the secret is still missing; anywhere
without a terminal (the slash command included) the CLI refuses and prints the command for you to
run yourself. Setting it directly works too:

```bash
gh secret set CLICKUP_TOKEN --repo owner/name
```

Get the token from ClickUp: **Settings → Apps → API Token**. If your workspace uses ClickUp
Custom Task IDs, also set `CLICKUP_TEAM_ID`; the workflow switches to the custom-id endpoint when
it is present.

Without the secret the workflow still runs, logs a warning, and changes nothing. The sync only
ever *checks whether* the secret exists — the API cannot return its value.

### Secrets other status checks need

`PR-SCOPE-CHECK` requires a status check named `scope-check` to pass before merging into `dev` —
but the sync only **requires** it; it does not generate the workflow that produces it (unlike
ClickUp/Jira sync, which it generates end to end). That check comes from a separate suite (the
pr-guardrails scope-check workflow), and it needs `OPENROUTER_API_KEY` to call its AI provider.

`environments.<env>.statusCheckSecrets` names any secrets a status check needs:

```jsonc
"environments": {
  "dev": {
    "statusChecks": ["scope-check"],
    "statusCheckSecrets": ["OPENROUTER_API_KEY"]
  }
}
```

Missing ones get the **exact same treatment** as the tracker token: on a real terminal, checked on
every interactive run (not just first sync, since this isn't a "you just picked something" moment
— it's a standing requirement of the config),

```
The 'OPENROUTER_API_KEY' secret is required for a configured status check and is not set.
Set it up now, via gh's hidden prompt? [y/N]
```

hands off to `gh secret set` on yes, in plan mode too. Anywhere without a terminal, the plan prints
the manual command instead:

```
The 'OPENROUTER_API_KEY' secret is required for a configured status check and is not set —
merges may block on it until it is. Set it yourself, in your own terminal:

    gh secret set OPENROUTER_API_KEY --repo owner/name
```

`--json` carries the same list as `missingStatusCheckSecrets`.

## PR checks: scope check and PR-Agent review

Two more workflows are generated the same way the task-sync one is, when
`prChecks` turns them on:

| File | What it does |
|---|---|
| `.github/workflows/pr-scope-check.yml` | asks an AI whether a PR's changes stay within its linked ticket's scope, and blocks the merge if not |
| `.github/scripts/scope-check.mjs` | the logic that workflow runs — written alongside it, so the two can never drift apart |
| `.github/workflows/pr-agent.yml` | runs [PR-Agent](https://github.com/qodo-ai/pr-agent) for an auto description, review and inline suggestions, plus a blocking security gate |

### The tracker is never configured twice

The scope check reads the ticket from whichever tracker `taskSync.provider`
already names. Pick ClickUp and the workflow gets `ISSUE_PROVIDER: "clickup"`
and `CLICKUP_TOKEN`; pick Jira and it gets `ISSUE_PROVIDER: "jira"` with
`JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Switch provider and the
workflow is rewritten to match — there is no second place to keep in sync.

With `provider: "none"` there is no ticket to read, so the scope check is
**not** written and the plan says why rather than leaving an absent check
looking like a passing one:

```
  SKIPPED  .github/workflows/pr-scope-check.yml → it reads the ticket from a task tracker,
           but taskSync is off (provider 'none') — enable ClickUp or Jira, or set
           prChecks.scopeCheck.enabled to false
```

### It follows your environments

The scope check triggers on pull requests targeting **every declared
environment**, from the same list that drives every ruleset — add `staging` and
it is checked there too, with no second edit. The job id is `scope-check`,
which is exactly the context `PR-SCOPE-CHECK` requires: they are generated from
the same source so a rename can never leave a required check waiting on a
workflow nobody reports.

### Configuration

```jsonc
"prChecks": {
  "scopeCheck": {
    "enabled": true,
    "aiProvider": "openrouter",        // openrouter | gemini | github-models
    "aiModel": "qwen/qwen3-coder",
    "aiKeySecret": "OPENROUTER_API_KEY",
    "requireTask": true,               // block a PR with no ticket linked
    "failOpenOnError": false,          // block if the check itself errors
    "maxDiffChars": 60000,
    "autoCloseOutOfScope": true        // close the PR on an out-of-scope verdict
  },
  "prAgent": {
    "enabled": true,
    "model": "openrouter/qwen/qwen3-coder",
    "fallbackModels": ["openrouter/qwen/qwen-2.5-72b-instruct"],
    "maxTokens": 32000,
    "numCodeSuggestions": 4,
    "keySecret": "OPENROUTER_API_KEY",
    "securityGate": true               // fail the check when PR-Agent flags a security concern
  }
}
```

Both need `OPENROUTER_API_KEY`, which the sync offers to set for you — see
*Secrets other status checks need* above.

### Adopting a file you already wrote

These paths commonly already exist, hand-maintained. The sync will overwrite
them — that is the point of adopting them — but never silently:

```
  UPDATE   .github/workflows/pr-agent.yml → PR Agent review
           [this file already exists and was NOT written by this plugin —
            applying REPLACES it, and regenerates over it on every run afterwards]
```

Turning a check back off removes the file again, but **only** if the plugin
wrote it: a hand-written workflow at a managed path is left exactly where it
is, the same ownership rule the sync workflows follow.

## Reviewers and teams

`required_reviewers` binds a GitHub **team**, and teams exist only inside organisations. What the
sync does depends on what the target repo can actually honour:

| Target | Reviewer rule |
|---|---|
| org repo, team exists with members | bound to the team, by its resolved id; its membership is never touched |
| org repo, team missing | the team is **created and seeded from the repository's CODEOWNERS**, then bound |
| org repo, team exists but empty | the same seed is **added to it** — an empty team can never approve, so filling it is what makes the rule bind instead of degrade |
| org repo, nobody eligible to seed | the team is left alone and the requirement is dropped, naming every candidate that was considered and why it was rejected |
| personal repo, ≥2 collaborators | team dropped (impossible outside an org) — **CODEOWNERS takes the review over** where it can supply it; the approval count survives either way |
| any repo, team dropped for any reason | same substitution: `require_code_owner_review` needs no team |
| solo repo (org or personal) | team **and** approval count dropped; the reviewer ruleset is not created |

Both team rows change organisation membership, so they are shown in the plan — with the names —
before anything happens.

### Where the reviewers come from: CODEOWNERS

A reviewer team that does not exist, or that exists with nobody in it, used to drop the rule:
`team-only-reviewer` degraded to no team at all. It no longer does. The people who already own
the code are the people who should review it, so the team is built from the repository's own
`CODEOWNERS` — looked for exactly where GitHub looks, in GitHub's order:

```
.github/CODEOWNERS   →   CODEOWNERS   →   docs/CODEOWNERS
```

`@user` owners are taken as they are, `@org/team` owners are expanded to that team's members, and
every candidate is screened before it is proposed:

| Candidate | Outcome |
|---|---|
| org member with write access | added |
| no write access to this repo | skipped — GitHub does not count their approval, so the seat would be decorative |
| not a member of the organisation | skipped — adding them to a team **invites them to the org**, and this sync does not send someone an invitation as a side effect |
| an email address, or another org's team | skipped — GitHub cannot resolve either to a member |

Whoever runs the sync is the fallback: they join only when CODEOWNERS produced nobody, so a team is
never created empty, and running the command does not quietly enrol you as a reviewer for a
repository you do not own.

```
  CREATE   team tehvault/reviewers        → does not exist in 'tehvault'; it will be
             created with 2 member(s) from .github/CODEOWNERS: @alice, @bob,
             so the reviews it gates can actually be satisfied
             [not added:
               dev@tehvault.com — is an email address, which GitHub cannot resolve to a login
               @carol — has no write access to tehvault/app, so their approval would not count]
```

If nothing survives the screening the team is **not** created — an empty reviewer team blocks every
merge, which is worse than no rule — and the plan says who it considered and what would fix it.

Behaviour is declared in the config, and all three settings default on:

```jsonc
"teamSeeding": {
  "fromCodeowners": true,        // false: fall back to the runner, as before
  "includeRunner": "fallback",   // true: always; false: never
  "populateEmptyTeams": true     // false: leave an existing empty team alone
}
```

Membership is applied one person at a time, so one refusal costs one person rather than the team,
and the size the rule is judged against is how many members **actually landed** — a team whose
memberships all bounced is reported and left unbound rather than blocking every merge.

### When no team can be bound at all

Teams exist only inside organisations, so on a personal repo there is nothing to bind — and the
same is true when a config names another org's team, or when nobody could be found to seed one.
The reviewer requirement used to simply vanish there, leaving a bare approval count that anybody
could satisfy.

`require_code_owner_review` needs no team, so where CODEOWNERS can supply the review it takes the
gate over instead:

```
  CREATE   Enforce Branch Nomenclature    → ~ALL (except 3 excluded refs)
           [degraded: required_reviewers dropped — 'tehvault' is a user account — GitHub has no
            teams outside an organisation]
           [substituted: require_code_owner_review on — no team could be bound, so
            .github/CODEOWNERS gates the review instead — 2 owner(s) with write access across
            1 pattern(s)]
```

**It is only substituted where it is satisfiable**, which is stricter than it first looks. The last
matching pattern decides who owns a file, so every owned pattern needs at least **two** owners with
write access:

- an owner without write access does not count — GitHub ignores them, so they could never clear the
  gate
- a pattern with exactly **one** eligible owner is refused: a pull request that person writes,
  touching their own files, could never be approved by anyone
- a pattern nobody eligible owns is fine — GitHub asks for no code-owner review on paths with no
  owner
- an owner given as an email address is not counted, because it cannot be resolved to a login from
  here

When it cannot be enabled, the plan says which pattern is the problem and what would fix it, rather
than going quiet:

```
           [require_code_owner_review not substituted — it would have replaced the dropped team,
            but /infra/ has a single owner who can push, so a pull request that owner writes could
            never be approved]
            to enable it: give /infra/ a second owner with write access in .github/CODEOWNERS,
            then re-run
```

A team that binds is left to do its job — the substitution is a fallback, never an addition. And on
a solo repo nothing is substituted at all: the approval count is already reduced to zero there
because nobody but the author could approve, and a code owner review would be just as impossible.
Setting `review.requireCodeOwnerReview` explicitly in the config always wins over any of this.

CODEOWNERS is read only when some team the policy names will not bind as things stand — a repo
whose reviewer team resolves with members costs no extra API calls.

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

When task sync is enabled, the same line also flags it if the dropped environment was a pipeline
stage — a repo's live branch protection and its `environments` config are meant to be driven from
the same source, so this only fires when they have actually drifted apart (a ruleset edited by
hand, or an environment removed from the config after its branch was already protected):

```
  UPDATE   Pull Request Compulsion  → ~DEFAULT_BRANCH, dev
           [no longer covers test — those refs lose this ruleset's protection;
            it also means ClickUp sync will not fire for test — add it back to "environments"
            if that is not intended]
```

This is the exact signal that would have caught, on the very first plan, a repo whose branch
protection already spans an environment its ClickUp workflow was never generated for — rather than
that going unnoticed while the workflow file gets deleted and silently regenerated dev-only, over
and over, run after run.

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
| `team-only-reviewer` | `prod` | 1 approval, from `tehvault/reviewers` where available, else from a code owner |
| `Enforce Branch Nomenclature` | everything else | restricts creation; PR + 1 approval |

## Behaviour worth knowing

**Idempotent.** Rulesets are matched by name, so re-running updates in place rather than
creating duplicates. Server-side defaults GitHub fills in are not mistaken for drift.

**Never deletes.** A ruleset the config does not declare is reported as `UNMANAGED` and left
alone.

**Degrades loudly — but only when it must.** `required_reviewers` binds a GitHub team, which only
resolves when the repo's owner is that team's organisation. A missing or empty team in the owning
org is seeded from CODEOWNERS rather than dropped; where no team can be bound at all, CODEOWNERS
gates the review instead. Only when neither is possible is the requirement dropped — and the plan
says which one was missing and what would restore it.

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
