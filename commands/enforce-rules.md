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
  own `.github/ruleset-config.json`, which takes precedence.
- Adding an environment is a one-line edit to that config; never hand-edit rulesets on GitHub,
  since the next sync reports them as drift and overwrites them.
