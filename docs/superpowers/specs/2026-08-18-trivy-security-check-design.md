# Trivy security check — Design

**Date:** 2026-08-18
**Status:** Approved

## Purpose

Every repository governed by this plugin gets a Trivy scan on its pull requests, and that scan
gates the merge server-side like any other required check. One config block turns it on; the
workflow, the script it runs, and the ruleset that requires it are all generated from it.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| What blocks | severity threshold, not finding category | The threshold is the one knob a team actually tunes |
| Default threshold | `CRITICAL` blocks, `HIGH` and below report | Trivy rates secrets CRITICAL, so those block; HIGH CVEs in transitive deps do not wedge every PR |
| Blocking scope | files the pull request touches | A repo adopting this is not blocked on day one by a pre-existing finding nobody on the PR wrote |
| Reporting scope | the whole repository | Pre-existing findings stay visible without gating |
| Ruleset | its own `TRIVY-SECURITY` | A gate should name itself; `PR-SCOPE-CHECK` requiring Trivy would mislead, and renaming a live ruleset orphans it |
| Logic location | a generated script, not inline YAML | The same reason `assets/scope-check.mjs` exists — 300 lines of logic in a template literal is unmaintainable |
| SARIF upload | not used | `upload-sarif` needs GitHub Advanced Security on private repos, and code-scanning gates cannot be required through rulesets |

## Configuration

```jsonc
"prChecks": {
  "trivy": {
    "enabled": true,
    "severities": ["CRITICAL", "HIGH", "MEDIUM"],   // what Trivy looks for
    "blockOn": ["CRITICAL"],                        // what fails the check
    "blockScope": "changed-files",                  // "changed-files" | "repository"
    "scanners": ["vuln", "secret", "misconfig"],
    "ignoreUnfixed": true,                          // a CVE with no fix is not actionable
    "statusCheck": "trivy-security",
    "rulesetName": "TRIVY-SECURITY",
    "skipDirs": ["node_modules", "dist", "build", "vendor"],
    "timeout": "10m"
  }
}
```

Every field has a default, so `{ "enabled": true }` is a complete configuration.

## Generated files

Both carry the existing ownership marker and follow the same adopt-and-orphan rules as the other
generated files: a hand-written file at either path is reported before being replaced, and is never
deleted.

| Path | Role |
|---|---|
| `.github/workflows/trivy-security.yml` | job id is `trivy-security`, which **is** the required status-check context. Triggers on pull requests targeting every declared environment |
| `.github/scripts/trivy-report.mjs` | copied verbatim from `assets/trivy-report.mjs`; reads Trivy's JSON, applies scope and threshold, posts one sticky comment, exits 1 or 0 |

The workflow checks out with `fetch-depth: 0` so the changed-file list can be derived, runs
`aquasecurity/trivy-action` with `format: json`, then runs the script.

## The ruleset

`TRIVY-SECURITY` is a status-check ruleset covering **every declared environment**, so an
environment added later is gated with no second edit — the same property the scope check gained in
1.13.0.

This requires generalising the baseline's status-check compilation from one ruleset to named groups:

```jsonc
"baseline": {
  "statusCheckGroups": [
    { "ruleset": "PR-SCOPE-CHECK", "checks": ["scope-check"], "secrets": ["OPENROUTER_API_KEY"] }
  ]
}
```

`statusChecks` / `statusCheckRuleset` / `statusCheckSecrets` remain as the single-group shorthand,
so existing configs and committed per-repo overrides keep working byte-for-byte.

### One deliberate asymmetry

The Trivy group is **derived** from `prChecks.trivy.enabled`, not hand-declared in `baseline`.
Disabling Trivy therefore removes the workflow and its ruleset together, so a required check nobody
reports cannot happen. The scope check stays hand-declared because an external suite may supply
that context — which is exactly why it needs the drop-loudly guard that Trivy does not.

## Decision logic

Findings are classified from Trivy's JSON, then filtered:

1. **Scope.** With `blockScope: "changed-files"`, a finding is blocking only when its file is in the
   pull request's changed-file list. Findings outside it are reported.
2. **Threshold.** A finding blocks only when its severity is in `blockOn`.
3. **Fixability.** With `ignoreUnfixed`, a vulnerability with no fixed version is reported, never
   blocking — nothing the author can do would clear the gate.

A finding that blocks is named in the comment with its severity, class, file, line, identifier and
fix. Everything else is summarised by severity in a collapsed block.

Exit code is 1 when any blocking finding survives all three filters, 0 otherwise. An error in the
scan itself exits 1 — a check that could not run must not look like a check that passed, matching
the scope check's `failOpenOnError: false` default.

## Architecture

`assets/trivy-report.mjs` exports pure functions and guards its `main()`, so the logic is unit
tested directly rather than only through a rendered workflow:

| Export | Contract |
|---|---|
| `classify(trivyJson)` | Trivy's nested report → a flat array of `{severity, class, file, line, id, title, fix}` |
| `withinScope(finding, changedFiles, blockScope)` | whether the finding is in blocking scope |
| `isBlocking(finding, opts)` | scope ∧ threshold ∧ fixability |
| `partition(findings, opts)` | `{blocking, reported}` |
| `renderComment(parts, opts)` | the sticky comment body |

`src/prchecks.js` gains `normalizeTrivy`, `renderTrivyWorkflow`, `renderTrivyScript`, and the two
new paths in `planPrChecks` / `planPrCheckOrphans`. `src/compiler.js` gains group-aware status-check
compilation. No other module changes.

## Testing

| Suite | Covers |
|---|---|
| `tests/trivy.test.js` | classification, the three filters, comment content, exit decision |
| `tests/prchecks.test.js` | defaults, rendering, job id equals the context, environment triggers, adopting, orphaning |
| `tests/compiler.test.js` | the group generalisation, `TRIVY-SECURITY` covering every environment, absent when disabled, shorthand still works |
| `tests/cli.test.js` | the plan names the ruleset, the files, and the threshold |

## Out of scope

Container-image and SBOM scanning, SARIF upload, scheduled scans of the default branch, and
per-environment thresholds. The last is a plausible next step — `prod` blocking on `HIGH` while
`dev` blocks on `CRITICAL` — and the group mechanism this introduces is what would carry it.
