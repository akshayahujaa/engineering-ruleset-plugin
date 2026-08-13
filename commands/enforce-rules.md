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

Notes:

- If `$ARGUMENTS` contains `--apply`, the user has pre-authorised the write; run the plan, show
  it, then apply without a second prompt.
- Policy lives in `ruleset-config.json` at the plugin root, unless the repository commits its
  own `.github/ruleset-config.json`, which takes precedence.
- Adding an environment is a one-line edit to that config; never hand-edit rulesets on GitHub,
  since the next sync reports them as drift and overwrites them.
