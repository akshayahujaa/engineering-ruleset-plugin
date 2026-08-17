---
description: Sync this repository's GitHub branch rulesets from the plugin's ruleset config.
allowed-tools: Bash(node:*)
---

Sync the branch rulesets of the repository in the current working directory.

Run the plan first — it writes nothing:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js"
```

Show the user the full plan output verbatim. It lists every ruleset that would be created or
updated, any rule that had to be degraded for this repository, and any existing ruleset the
config does not manage.

**If the output starts with a `━━ FIRST SYNC ━━` banner, do not go straight to "apply?".** The
repository has no rulesets yet and the banner names two choices — task tracker and environments —
that would otherwise be defaulted silently. Ask them first; see *Environments* below.

Then stop and ask whether to apply. Applying changes branch protection on a live repository:
once the baseline ruleset is active with no bypass actors, **every** actor including the repo
owner needs a pull request to change the default branch. Call that out explicitly if the plan
reports it, and do not apply until the user answers.

If the user confirms, apply:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --apply
```

Report which rulesets were created, updated, or rejected. If any were rejected, quote the API
message — a 422 usually names the exact field GitHub refused.

## When the repository is not reachable

The CLI exits non-zero with `No repo access to owner/repo` when the target is private-and-unshared
or does not exist — GitHub returns the same 404 for both, so do not claim the repo exists. Show
the message as printed; it already names the URL where access is granted.

If instead it reports a **pending admin invitation**, the CLI stops rather than accepting it,
because accepting joins the user's account to that repository. Ask the user in chat whether to
accept. Only if they say yes:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --repo owner/name --accept-invite
```

Never pass `--accept-invite` on the user's behalf without that answer, and never combine it with
`--apply` in the same first run — accept access first, show the resulting plan, then apply.

If it reports `No admin access`, the repository is visible but not administrable. The message
already names the authenticated account, its effective role, and whether the gap can be closed.
Do not suggest workarounds it rules out — in particular, if the repo is owned by a personal
account, admin cannot be delegated to anyone, so being added as a collaborator will not help and
the owner has to run the command instead.

## Environments

A first sync sets every rule up for **`dev` only** — never test or prod unless the user asks. The
sync creates any declared environment that is missing, from the default branch, **before** writing
rulesets — a ruleset requiring a pull request for `dev` also refuses the push that creates `dev`,
so the order is not optional.

On a repo already synced, the blocking rulesets are disabled for the moment it takes
to create the branches (and to commit the workflow file), then restored to `active`. Say so before applying: it is a brief window
where the default branch is unprotected.

**If the plan output contains `━━ FIRST SYNC — … HAS NO RULESETS YET ━━`, you MUST stop and ask
the user before applying.** That banner is the trigger — do not infer it from `CREATE` lines, and
do not skip it because the plan looks complete. It appears only when the repository has no
rulesets and neither `--provider` nor `--env` was supplied, and it names the defaults that will
otherwise be chosen silently.

Ask both questions in a single AskUserQuestion call:

1. **Which task tracker to sync on merges.** Offer **ClickUp as the recommended default**, then
   **Jira**, then **None**. Pass the answer through as `--provider clickup|jira|none`.
2. **Which environments beyond `dev`.** The repo starts at `dev` alone; offer **just dev
   (recommended)**, and `test` / `prod` as additions. Pass any extras through as `--env`.
   `test` and `prod` are known profiles — `prod` arrives with its approval and reviewer-team
   policy already attached, so it never needs hand-editing afterwards.

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --provider jira --env staging
```

**Carry the same `--provider` and `--env` flags onto the apply run.** The plan does not persist
them — an apply without them silently drops the user's answers:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --provider jira --env staging --apply
```

Changing provider on an already-synced repo also plans a `DELETE` of the other provider's sync
workflow — without it both trackers would move tasks on every merge. Show that line; it is part
of the plan for a reason.

## Reviewers, teams, and degradations

Report **every** `[degraded: ...]` and `SKIPPED` line verbatim — they are the difference between a
rule that binds and one that silently does not.

- `CREATE team <org>/<slug>` means the plan will **create a GitHub team and put people in it** —
  the repository's code owners, or the user themselves when there are none. `MEMBERS team ...`
  means the team already exists but is empty and those people will be **added to it**. Both change
  organisation membership, so read the names out and call it out explicitly before applying; the
  `[not added: ...]` block under them says who was considered and rejected, and why.
- `NOTE team <org>/<slug> → does not exist` means nobody could be found to seed it, so it is left
  alone and the reviewer requirement degrades. Relay the `To fix it:` line — the answer is almost
  always adding owners to `.github/CODEOWNERS` who have write access and are in the org.
- On a personal repo the team requirement is always dropped — GitHub has no teams outside an
  organisation — but `[substituted: require_code_owner_review on ...]` means CODEOWNERS took the
  review over, so the rule still binds. Say that rather than reporting only the drop.
- `[require_code_owner_review not substituted — ...]` is the opposite: the team went and nothing
  replaced it, so that rule now enforces only an approval count. Relay the reason and the
  `to enable it:` line verbatim; it names the exact CODEOWNERS pattern to fix.
- On a **solo** repo the team requirement and the approval count are both dropped, and the
  reviewer ruleset is skipped. This is deliberate: GitHub forbids approving your own pull request,
  so N accounts with write access supply at most N−1 approvals, and a rule demanding more could
  never be satisfied — every merge would block forever. The line carries a `to restore it:`
  remedy — relay it.
- `⚠ THIS RULESET IS BLOCKING MERGES` marks an **existing** ruleset the config no longer manages
  that is already making a branch unmergeable. The sync will not touch it. Relay the warning and
  the settings URL; this is usually the answer to "why can't I merge into prod".
- `[no longer covers X, Y]` means an update removes those refs from that ruleset's scope, so they
  lose its protection. Always surface it before applying.

Then re-run the plan **with the chosen flags** and show that output before applying — the answers
change which rulesets and branches the plan contains, so the first plan is no longer the one being
approved.

When the banner is absent, ask nothing: the repo is already synced, or the flags were supplied.
(On a real terminal the CLI asks these questions itself; under this command stdin is a pipe, so it
prints the banner instead and the widget answer is the only route.)

An added environment is written into the plugin's own `ruleset-config.json` on `--apply`, so it
applies to **every** repo synced from then on. Tell the user that; if they only want it for one
repo, that is a per-repo `.github/ruleset-config.json` instead. If the CLI warns the install is a
marketplace clone, relay that warning: the persisted edit is lost on
`claude plugin marketplace update`, so it should also be committed to the plugin repo.

If the target repository commits its own `.github/ruleset-config.json`, `--env` and `--provider`
are refused alike — that policy can only change by a pull request to that repository. Relay the
instruction as printed, and do not carry the refused flag onto further runs against that repo.

## The task-sync pipeline

The plan prints the full pipeline under the workflow line — one row per environment, e.g.
`merge into test → 'QA'`. Show it: it is how the user checks the mapping and, importantly, the
**order**. Rank follows the order of `environments` in the config, so an environment added later
lands last; if that is wrong for their real pipeline (staging usually precedes prod), tell them to
reorder `environments` in the config rather than hand-editing the workflow, which is regenerated.

An environment with no entry in `taskSync.environmentStatuses` maps to a status of the same name.
That is the intended default for a newly added environment — do not invent a mapping for it, and
do not suggest editing the generated workflow directly.

## Task tracker credentials (ClickUp or Jira)

When the plan includes a sync workflow (`clickup-sync.yml` or `jira-sync.yml`), applying commits
that file to the repository — call that out, since every other change is a settings change.

If the plan reports missing credentials — or the user asks to integrate the token, set the
secret, or "connect ClickUp/Jira" — the CLI can drive it, but only from the user's own terminal.
Relay this command **with both placeholders substituted** — expand `${CLAUDE_PLUGIN_ROOT}` to the
actual absolute plugin path and `owner/name` to the real repository, since neither means anything
in the user's shell:

```
node "<absolute plugin path>/src/cli.js" --repo owner/name --set-token
```

For **ClickUp** that sets one secret (`CLICKUP_TOKEN`). For **Jira** it first asks for
`JIRA_BASE_URL` and `JIRA_EMAIL` — ordinary repository variables, not sensitive, answered in the
clear — then takes `JIRA_API_TOKEN` at gh's hidden prompt. (`--set-clickup-token` still works as
an alias of `--set-token`.)

(When the CLI has already refused with its "needs a real terminal" message, relay the command
from that message verbatim — it is already fully substituted.) `gh` prompts for the token with
hidden input, encrypts it locally, and uploads it; the value goes keyboard → gh → GitHub and
never enters the CLI process. Running it through this command's Bash tool will refuse by design —
stdin is a pipe, and there is no terminal to hand to gh.

**Never ask the user to paste the token into the chat. Never accept it if they paste it anyway —
tell them to revoke it (ClickUp: Settings → Apps → API Token; Jira: id.atlassian.com → Security →
API tokens) and generate a new one, since anything pasted into chat must be treated as exposed. Never put a token value into a
command, file, or environment variable on their behalf.** The hidden prompt is the only route.
The CLI enforces the same rule itself: anything token-shaped in its arguments is refused with
the same revoke guidance.

After the user says they have run it, re-run the plan; the token notice disappearing (or
`"hasToken": true` in `--json`) confirms **a** secret exists — it cannot tell a fresh token from
a revoked one. If a token was exposed and revoked after it had already been uploaded, the user
must run `--set-token` again with the replacement, even though `hasToken` reads true.

Notes:

- If `$ARGUMENTS` contains `--apply`, the user has pre-authorised the write; run the plan, show
  it, then apply without a second prompt.
- If `$ARGUMENTS` names a repository, pass it straight through as `--repo owner/name`, which
  targets any repository without cloning it. Everything else is unchanged.
- Policy lives in `ruleset-config.json` at the plugin root, unless the repository commits its
  own `.github/ruleset-config.json`, which takes precedence. With `--repo`, that override is
  fetched from the **target** repository via the API — the caller's working directory plays no
  part, so the same command gives the same plan from anywhere.
- Adding an environment is a one-line edit to that config; never hand-edit rulesets on GitHub,
  since the next sync reports them as drift and overwrites them.
