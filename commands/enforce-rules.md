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

The config carries `dev`, `test`, and `prod`. The sync creates any that are missing, from the
default branch, **before** writing rulesets — a ruleset requiring a pull request for `dev` also
refuses the push that creates `dev`, so the order is not optional.

On a repo already synced, the blocking rulesets are dropped to `evaluate` for the moment it takes
to create the branches, then restored to `active`. Say so before applying: it is a brief window
where the default branch is unprotected.

**On a repo's first sync only** — recognisable because every ruleset shows `CREATE` and the repo
has no rulesets yet — ask the user, using AskUserQuestion, whether they want any environment
beyond `dev`, `test`, and `prod`. Offer the three defaults as the recommended answer. If they name
others, pass them through:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --env staging --env uat
```

**Carry the same `--env` flags onto the apply run.** The plan does not persist them — an apply
without them silently drops the user's answer:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --env staging --env uat --apply
```

Do not ask on a repo that already has rulesets — a re-sync should be quiet. (On a real terminal
the CLI asks this question itself; under this command stdin is a pipe, so it stays silent by
design and the widget answer is the only route.)

An added environment is written into the plugin's own `ruleset-config.json` on `--apply`, so it
applies to **every** repo synced from then on. Tell the user that; if they only want it for one
repo, that is a per-repo `.github/ruleset-config.json` instead. If the CLI warns the install is a
marketplace clone, relay that warning: the persisted edit is lost on
`claude plugin marketplace update`, so it should also be committed to the plugin repo.

If the target repository commits its own `.github/ruleset-config.json`, `--env` is refused — that
policy can only change by a pull request to that repository. Relay the instruction as printed.

## ClickUp

When the plan includes `.github/workflows/clickup-sync.yml`, applying commits that file to the
repository — call that out, since every other change is a settings change.

If it reports that `CLICKUP_TOKEN` is not set, relay the `gh secret set` command for the user to
run themselves. **Never ask the user to paste the token into the chat, and never put a token
value into a command, file, or environment variable on their behalf.** `gh secret set` reads it
without echoing and encrypts it before it leaves the machine; that is the only route.

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
