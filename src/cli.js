#!/usr/bin/env node
/**
 * enforce-rules — sync branch rulesets into the current GitHub repository.
 *
 *   enforce-rules                       plan for the repo in the current directory
 *   enforce-rules --repo owner/name     plan for any repo, no clone needed
 *   enforce-rules --apply               apply instead of only planning
 *   enforce-rules --json                machine-readable plan
 *   enforce-rules --accept-invite       accept a pending invitation to the target repo
 *   enforce-rules --env staging         add an environment; persisted on --apply
 *   enforce-rules --provider jira       choose the task tracker (clickup | jira | none)
 *   enforce-rules --set-token           set the tracker's credentials (token via gh's hidden prompt)
 */

import { writeFileSync } from "node:fs";
import {
  resolveConfig,
  isMarketplaceClone,
  isValidEnvName,
  parseEnvList,
  detectTokenMisuse,
  OVERRIDE_PATH,
} from "./config.js";
import { compile, referencedTeams, addEnvironments } from "./compiler.js";
import { createClient, GitHubError } from "./github.js";
import { plan, apply } from "./sync.js";
import { planTaskSync, applyTaskSync, planSyncOrphans, removeSyncOrphan } from "./tasksync.js";
import { planBranches, createMissingBranches, withRelaxedEnforcement } from "./branches.js";
import {
  probeAccess,
  acceptAndReprobe,
  invitationGrantsAdmin,
  needsAdminMessage,
  AccessDenied,
} from "./access.js";

const ICON = { create: "CREATE ", update: "UPDATE ", unchanged: "UNCHANGED" };

/** True only on a real terminal; under the slash command stdin is a pipe. */
const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function askYesNo(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * On a repository's very first sync, offers to extend the default
 * environments. TTY-only by construction: under the slash command stdin is a
 * pipe, and the command's own instructions gather this answer with a widget
 * and pass it back as `--env`, so the CLI prompting there would either hang
 * or ask a question nobody can answer.
 */
async function askExtraEnvironments(defaults) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nFirst sync of this repository. Default environments: ${defaults.join(", ")}.`);
    const answer = await rl.question(
      "Extra environments beyond these? (comma-separated, empty for none) ",
    );
    return parseEnvList(answer);
  } finally {
    rl.close();
  }
}

/**
 * On a repository's very first sync, asks which task tracker the merge sync
 * should talk to. Same TTY-only rule as the environments question: under the
 * slash command the widget answers and `--provider` carries it in.
 */
async function askProvider() {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question("Task tracker to sync on merges — clickup (default), jira, or none: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "clickup") return "clickup";
    if (answer === "jira" || answer === "none") return answer;
    throw new Error(`Unknown tracker '${answer}' — expected clickup, jira, or none.`);
  } finally {
    rl.close();
  }
}

/**
 * Interactive, gh-only credential setup for the active provider. The token
 * goes through gh's hidden prompt and never enters this process. Jira's base
 * URL and account email are ordinary repository variables — not sensitive —
 * so they are prompted for in the clear and set directly.
 */
async function setupCredentials(client, sync) {
  let wroteAnything = false;
  if (sync.missingVariables.length > 0) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const name of [...sync.missingVariables]) {
        const hint =
          name === "JIRA_BASE_URL" ? "e.g. https://your-org.atlassian.net" : "your Atlassian account email";
        const value = (await rl.question(`  ${name} (${hint}): `)).trim();
        if (name === "JIRA_BASE_URL" && !/^https:\/\/.+/.test(value)) {
          throw new Error(`${name} must be an https:// URL.`);
        }
        if (name === "JIRA_EMAIL" && !value.includes("@")) {
          throw new Error(`${name} does not look like an email address.`);
        }
        await client.setVariable(name, value);
        wroteAnything = true;
        sync.missingVariables = sync.missingVariables.filter((v) => v !== name);
        console.log(`  ✓ ${name} set`);
      }
    } finally {
      rl.close();
    }
  }

  console.log(
    `\nHanding over to gh — paste your ${sync.providerLabel} token ONLY at its hidden prompt.` +
      `\n(${sync.tokenHint}. The value goes keyboard → gh → GitHub, nowhere else.)\n`,
  );
  try {
    client.setSecretInteractive(sync.secretName);
  } catch {
    // gh exits non-zero on blank input, Ctrl-D, or an API refusal; the
    // re-check below turns that into the honest ✗ rather than a stack trace.
  }
  sync.hasToken = await client.hasSecret(sync.secretName);
  console.log(
    sync.hasToken
      ? `  ✓ ${sync.secretName} is set on ${client.owner}/${client.repo}\n`
      : `  ✗ ${sync.secretName} still missing — gh did not confirm the write\n`,
  );
  return wroteAnything || sync.hasToken;
}

/**
 * Resolves the repository context, negotiating access when the repository is
 * not reachable.
 *
 * Accepting an invitation joins the user to a repository, so it never happens
 * implicitly: it needs `--accept-invite`, or a yes on a real terminal. When
 * neither is available the command stops and says what would unblock it.
 */
async function resolveContext(client, { acceptInvite }) {
  const probe = await probeAccess(client);
  if (probe.ok) return probe.context;

  const target = `${client.owner}/${client.repo}`;

  if (!probe.invitation) throw new AccessDenied(probe.message);

  console.log(`\n${probe.message}\n`);

  if (!invitationGrantsAdmin(probe.invitation)) {
    throw new AccessDenied(
      `The pending invitation to ${target} does not grant admin, and rulesets cannot be managed without it.\n` +
        "Ask the owner to re-invite you as an admin, then re-run.",
    );
  }

  if (acceptInvite) {
    console.log("Accepting the invitation (--accept-invite).\n");
    return acceptAndReprobe(client, probe.invitation);
  }

  if (!isInteractive()) {
    throw new AccessDenied(
      `No repo access to ${target} yet — but a pending admin invitation was found.\n\n` +
        "Accepting it adds your account to the repository, so it is not done automatically.\n" +
        "Re-run with --accept-invite to accept it and continue.",
    );
  }

  if (!(await askYesNo(`Accept this invitation and continue? [y/N] `))) {
    throw new AccessDenied(`Invitation left pending. No repo access to ${target}; nothing was changed.`);
  }
  return acceptAndReprobe(client, probe.invitation);
}

function describeScope(ruleset) {
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const shown = include.map((r) => r.replace("refs/heads/", "")).join(", ");
  return exclude.length ? `${shown} (except ${exclude.length} excluded refs)` : shown;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldApply = args.includes("--apply");
  const asJson = args.includes("--json");
  const acceptInvite = args.includes("--accept-invite");
  // --set-clickup-token is the pre-provider spelling, kept as an alias.
  const setToken = args.includes("--set-token") || args.includes("--set-clickup-token");
  const cwd = process.cwd();

  const providerFlagGiven = args.includes("--provider") || args.some((a) => a.startsWith("--provider="));
  const providerFlag =
    args.find((a) => a.startsWith("--provider="))?.split("=")[1] ??
    (args.includes("--provider") ? args[args.indexOf("--provider") + 1] : undefined);
  if (providerFlagGiven && !["clickup", "jira", "none"].includes(providerFlag)) {
    throw new Error(
      `--provider must be one of: clickup, jira, none — got '${providerFlag ?? ""}'.`,
    );
  }

  // A token that reaches argv is already exposed; refuse loudly, never silently.
  const misuse = detectTokenMisuse(args);
  if (misuse) throw new AccessDenied(misuse);

  // --env may repeat and may carry a comma-separated list.
  const requestedEnvs = args
    .flatMap((a, i) => (a === "--env" ? [args[i + 1]] : a.startsWith("--env=") ? [a.slice(6)] : []))
    .filter(Boolean)
    .flatMap(parseEnvList)
    .filter((v) => !v.startsWith("--"));

  const badEnvs = requestedEnvs.filter((name) => !isValidEnvName(name));
  if (badEnvs.length > 0) {
    throw new Error(`Not usable as branch names: ${badEnvs.join(", ")}`);
  }

  if (asJson && shouldApply) {
    // Refusing beats the old behaviour, which returned the JSON plan and
    // silently skipped the apply while exiting 0.
    throw new Error("--json is a plan format; run --apply without it.");
  }
  if (asJson && setToken) {
    throw new Error("--set-token is interactive; it cannot combine with --json.");
  }

  // --repo owner/name targets any repository without cloning or cd-ing into it.
  const repoFlag = args.find((a) => a.startsWith("--repo="))?.split("=")[1] ?? args[args.indexOf("--repo") + 1];
  const repo = args.includes("--repo") || args.some((a) => a.startsWith("--repo=")) ? repoFlag : undefined;

  const client = createClient({ cwd, repo });

  // The hand-off constraints are knowable now — fail before any network work.
  if (setToken) {
    if (!isInteractive()) {
      throw new AccessDenied(
        "--set-token needs a real terminal: gh prompts for the token with hidden\n" +
          "input, and it is never accepted as an argument or over a pipe. Run this yourself:\n\n" +
          `    node "${process.argv[1]}" --repo ${client.owner}/${client.repo} --set-token`,
      );
    }
    if (client.authMode !== "gh cli") {
      throw new AccessDenied(
        "--set-token hands the terminal to the gh CLI, which is not available here.\n" +
          "Run `gh auth login` first — token-only auth cannot prompt with hidden input.",
      );
    }
  }

  const context = await resolveContext(client, { acceptInvite });

  if (!context.isAdmin) {
    throw new AccessDenied(
      needsAdminMessage({
        owner: client.owner,
        repo: client.repo,
        ownerType: context.ownerType,
        ownerLogin: context.ownerLogin,
        permissions: context.permissions,
        viewer: await client.viewer(),
      }),
    );
  }

  // Config resolution needs the client (a --repo override is fetched from the
  // target repository), so it sits after access and admin are established:
  // fetching earlier would turn "no access yet" into a silent wrong answer,
  // since a 404 for the override is indistinguishable from the file being absent.
  const { config, origin, label: policyLabel, writablePath } = await resolveConfig({
    client,
    repoMode: Boolean(repo),
    cwd,
  });

  // First sync of a repository: offer to extend the default environments.
  // Only on a real terminal, only when --env did not already answer, and
  // never in --json mode, whose output must stay parseable.
  // Skipped under --set-token: someone here to set credentials has not
  // signed up for an interview.
  const preexisting = await client.listRulesets();
  if (preexisting.length === 0 && requestedEnvs.length === 0 && isInteractive() && !asJson && !setToken) {
    const extras = await askExtraEnvironments(Object.keys(config.environments ?? {}));
    const invalid = extras.filter((name) => !isValidEnvName(name));
    if (invalid.length > 0) throw new Error(`Not usable as branch names: ${invalid.join(", ")}`);
    requestedEnvs.push(...extras);
  }

  const addedEnvs = addEnvironments(config, requestedEnvs);

  // Provider: --provider wins; a first sync on a real terminal is asked
  // (ClickUp default, then Jira, then none); otherwise the policy stands.
  const syncSection = config.taskSync ?? config.clickup;
  const configuredProvider = syncSection?.enabled ? (syncSection.provider ?? "clickup") : "none";
  let chosenProvider = providerFlag;
  if (
    chosenProvider === undefined &&
    preexisting.length === 0 &&
    isInteractive() &&
    !asJson &&
    !setToken
  ) {
    chosenProvider = await askProvider();
  }
  const providerChanged = chosenProvider !== undefined && chosenProvider !== configuredProvider;
  if (providerChanged) {
    if (chosenProvider === "none") {
      if (syncSection) syncSection.enabled = false;
    } else if (syncSection) {
      // Provider-specific fields must not leak across providers: a Jira
      // workflow reading CLICKUP_TOKEN would be wrong twice. But merely
      // re-enabling the SAME provider keeps its customizations — deleting a
      // custom secretName on re-enable would silently kill a working sync.
      if (chosenProvider !== (syncSection.provider ?? "clickup")) {
        delete syncSection.taskIdPrefix;
        delete syncSection.secretName;
      }
      syncSection.enabled = true;
      syncSection.provider = chosenProvider;
    } else {
      config.taskSync = { enabled: true, provider: chosenProvider, targetBranch: "dev" };
    }
    // The documented shape is `taskSync`; a legacy `clickup` section being
    // rewritten anyway is renamed rather than persisted with, say, a Jira
    // provider inside a section named after ClickUp.
    if (config.taskSync === undefined && config.clickup !== undefined) {
      config.taskSync = config.clickup;
      delete config.clickup;
    }
  }

  // A committed override can only be changed by a pull request to that repo —
  // the plugin must not try to write it, and pretending the edit happened
  // while persisting nothing would plan a policy the next run forgets.
  const policyEdits = [
    ...addedEnvs.map((e) => `environment '${e}'`),
    ...(providerChanged ? [`task-sync provider '${chosenProvider}'`] : []),
  ];
  if (policyEdits.length > 0 && writablePath == null) {
    throw new AccessDenied(
      `This repository's policy comes from its committed ${OVERRIDE_PATH}, which cannot be ` +
        `edited from here.\nApply ${policyEdits.join(", ")} in that file via a pull request, then re-run.`,
    );
  }

  // Team ids are only resolvable when the repo's owner is the team's org.
  const teamIds = {};
  if (context.ownerType === "Organization") {
    for (const team of referencedTeams(config)) {
      if (team.split("/")[0].toLowerCase() !== context.ownerLogin.toLowerCase()) continue;
      try {
        teamIds[team] = await client.teamId(team);
      } catch {
        /* compiler degrades when the id is missing */
      }
    }
  }

  const { rulesets, degradations } = compile(config, { ...context, teamIds });
  const { steps, undeclared } = await plan(client, rulesets);
  const sync = await planTaskSync(client, config);
  const orphans = await planSyncOrphans(client, sync?.provider ?? null);
  const syncPending = Boolean(sync && sync.action !== "unchanged") || orphans.length > 0;
  // Pending workflow writes (and orphan removals) share the branch-creation
  // relax window: the same pull_request rule refuses all of them, so they
  // must not earn a second window.
  const branches = await planBranches(client, Object.keys(config.environments ?? {}), context.defaultBranch, {
    guardDefaultBranchWrite: syncPending,
  });

  // The token itself never enters this process (or any chat): gh prompts for
  // it with hidden input, encrypts it locally, and uploads it. This flag only
  // decides WHEN to hand the terminal over; the TTY and gh-CLI requirements
  // were enforced before any network work.
  let credentialWrites = false;
  if (setToken) {
    if (!sync) {
      throw new Error("--set-token: task sync is not enabled in the policy (provider 'none').");
    }
    credentialWrites = await setupCredentials(client, sync);
    if (!sync.hasToken) process.exitCode = 1;
  }

  if (asJson) {
    // Branches carry the relax window — the plan's most dangerous
    // step — so machine consumers must see it too, not only humans.
    console.log(
      JSON.stringify(
        {
          repo: `${client.owner}/${client.repo}`,
          policy: { origin, label: policyLabel },
          steps,
          degradations,
          undeclared,
          branches: {
            missing: branches.missing,
            relaxDuringCreation: branches.blocked.map((r) => r.name),
          },
          taskSync: sync && {
            provider: sync.provider,
            path: sync.path,
            action: sync.action,
            hasToken: sync.hasToken,
            missingVariables: sync.missingVariables,
          },
          removedSyncWorkflows: orphans.map((o) => o.path),
          addedEnvironments: addedEnvs,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nRepository: ${client.owner}/${client.repo} (${context.visibility}, ${context.ownerType.toLowerCase()}-owned)`);
  console.log(`Policy:     ${policyLabel}`);
  console.log(`Auth:       ${client.authMode}\n`);

  for (const step of steps) {
    const note = degradations.find((d) => d.ruleset === step.name);
    console.log(
      `  ${ICON[step.action]}  ${step.name.padEnd(30)} → ${describeScope(step.payload)}` +
        (note ? `\n${" ".repeat(13)}[degraded: ${note.dropped} dropped — ${note.reason}]` : ""),
    );
  }

  for (const name of undeclared) {
    console.log(`  UNMANAGED  ${name.padEnd(30)} → not in config; left untouched`);
  }

  if (addedEnvs.length > 0) {
    console.log(
      `\n  NEW ENV  ${addedEnvs.join(", ").padEnd(30)} → will be added to ${policyLabel}` +
        (origin === "bundled" ? ", affecting every repo synced with it" : ""),
    );
  }

  if (branches.missing.length > 0) {
    console.log(
      `\n  CREATE   ${branches.missing.join(", ").padEnd(30)} → environment branch(es), from ${context.defaultBranch}`,
    );
  }
  if (branches.blocked.length > 0) {
    const writes = [
      ...(branches.missing.length > 0 ? ["the branches are created"] : []),
      ...(syncPending ? ["the workflow file is committed"] : []),
    ].join(" and ");
    console.log(
      `             [${branches.blocked.map((r) => r.name).join(", ")} would refuse this;` +
        `\n              each is disabled only while ${writes},` +
        `\n              then restored to 'active']`,
    );
  }

  if (providerChanged) {
    console.log(
      `\n  PROVIDER ${String(chosenProvider).padEnd(30)} → will be recorded in ${policyLabel}` +
        (origin === "bundled" ? ", affecting every repo synced with it" : ""),
    );
  }

  if (policyEdits.length > 0 && isMarketplaceClone(writablePath)) {
    console.log(
      `             [this plugin install is a marketplace clone: the edit is lost on` +
        `\n              'claude plugin marketplace update' — also commit it to the plugin repo]`,
    );
  }

  if (sync) {
    console.log(
      `\n  ${ICON[sync.action]}  ${sync.path.padEnd(30)} → on merge into ` +
        `${sync.targetBranch}, move the ${sync.providerLabel} task to '${sync.targetStatus}'`,
    );
    if (sync.provider === "jira" && config.branchNaming && (config.branchNaming.taskIdPrefix ?? "CU-") === "CU-") {
      console.log(
        `             [branchNaming.taskIdPrefix is 'CU-' (ClickUp-flavoured); for Jira, set it to` +
          `\n              your project key prefix (e.g. 'PROJ-') or new branches will be refused]`,
      );
    }
  }

  for (const orphan of orphans) {
    console.log(
      `\n  DELETE   ${orphan.path.padEnd(30)} → ${orphan.providerLabel} sync left behind by a provider` +
        `\n             change; it would keep moving tasks on every merge`,
    );
  }

  const writes = steps.filter((s) => s.action !== "unchanged");
  const guardsDefault = rulesets.some((r) =>
    (r.conditions?.ref_name?.include ?? []).includes("~DEFAULT_BRANCH"),
  );

  if (guardsDefault && writes.length > 0) {
    console.log(
      `\n  No bypass actors are configured. Once applied, changes to '${context.defaultBranch}'` +
        `\n  require a pull request — for every actor, including you.`,
    );
  }

  // The token is requested, never captured: passing it through this process
  // would put it in shell history and the process table. On a terminal the
  // hand-off to gh's hidden prompt is offered right here; anywhere else the
  // command to run is printed instead.
  if (sync && (!sync.hasToken || sync.missingVariables.length > 0)) {
    if (shouldApply && isInteractive() && client.authMode === "gh cli") {
      if (
        await askYesNo(
          `\n  ${sync.providerLabel} credentials are incomplete. Set them now?` +
            `\n  (Answer y or n here — paste the token ONLY at gh's hidden prompt.) [y/N] `,
        )
      ) {
        // Credentials are an optional add-on: a failure here must not abort
        // the apply the user just confirmed.
        try {
          await setupCredentials(client, sync);
        } catch (error) {
          console.log(`  ✗ ${error.message}`);
        }
      }
    }
    if (!sync.hasToken || sync.missingVariables.length > 0) {
      const varsNote =
        sync.missingVariables.length > 0
          ? `\n  Also missing repository variable(s): ${sync.missingVariables.join(", ")} —` +
            `\n  these are not secrets; set them with: gh variable set NAME --repo ${client.owner}/${client.repo}\n`
          : "";
      console.log(
        `\n  The ${sync.secretName} secret is not set on this repository, so the workflow` +
          `\n  will skip every task until it is. Set it yourself, in your own terminal —` +
          `\n  it prompts with hidden input there, and the value is never typed here:` +
          `\n\n      gh secret set ${sync.secretName} --repo ${client.owner}/${client.repo}` +
          `\n\n  (or re-run with --set-token). Never pipe or paste the token into the` +
          `\n  command line. Get one from ${sync.tokenHint}.\n${varsNote}`,
      );
    }
  }

  const pending =
    writes.length +
    (sync && sync.action !== "unchanged" ? 1 : 0) +
    orphans.length +
    branches.missing.length +
    policyEdits.length;

  if (!shouldApply) {
    // The credential writes under --set-token are real even in plan mode;
    // claiming "nothing written" right after "✓ ... is set" would lie.
    const wroteSecret = credentialWrites ? " (the credential writes above did happen)" : "";
    console.log(
      pending === 0
        ? `\nAlready in sync. Nothing to apply${wroteSecret}.\n`
        : `\nPlan only — no rulesets, branches, or files written${wroteSecret}. ` +
            `Re-run with --apply to make these ${pending} change(s).\n`,
    );
    return;
  }

  console.log("");

  // Persisting the policy edits is what makes them survive the next run;
  // without it the next sync would plan them away again.
  if (policyEdits.length > 0) {
    writeFileSync(writablePath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  ✓ recorded ${policyEdits.join(", ")} in ${policyLabel}`);
  }

  // One relax window covers every write the active rulesets would refuse:
  // creating the environment branches AND committing the workflow file to the
  // default branch. Both precede the ruleset writes — the guards go up only
  // after everything they would block is already in place.
  let workflowNote = "";
  if (branches.missing.length > 0 || syncPending) {
    let branchResults = [];
    let syncError;
    let syncDone = false;
    const orphansRemoved = [];
    const orphanErrors = [];

    const { restoreFailures } = await withRelaxedEnforcement(client, branches.blocked, async () => {
      // Workflow file BEFORE branches: the branches are cut from the default
      // branch head, and a dev without the sync workflow never fires it —
      // pull_request workflows run from the PR's merge commit.
      if (sync && sync.action !== "unchanged") {
        try {
          await applyTaskSync(client, sync);
          syncDone = true;
        } catch (error) {
          syncError = error;
        }
      }
      for (const orphan of orphans) {
        try {
          await removeSyncOrphan(client, orphan);
          orphansRemoved.push(orphan.path);
        } catch (error) {
          orphanErrors.push({ path: orphan.path, error });
        }
      }
      branchResults = await createMissingBranches(client, branches.missing, context.defaultBranch);
    });

    for (const result of branchResults) {
      console.log(
        result.status === "created"
          ? `  ✓ created branch ${result.name}`
          : `  ✗ branch ${result.name}: ${result.error}`,
      );
      if (result.status === "failed") process.exitCode = 1;
    }
    for (const failure of restoreFailures) {
      console.log(
        `  ✗ RULESET '${failure.name}' IS STILL DISABLED — its restore failed: ${failure.error}` +
          `\n    The repository is unprotected by it until a re-run or a manual fix succeeds.`,
      );
      process.exitCode = 1;
    }
    for (const path of orphansRemoved) console.log(`  ✓ removed ${path}`);
    for (const failure of orphanErrors) {
      console.log(`  ✗ ${failure.path}: ${failure.error.message}`);
      process.exitCode = 1;
    }
    if (syncDone) {
      console.log(`  ✓ ${sync.action === "create" ? "created" : "updated"} ${sync.path}`);
    } else if (syncError) {
      // A token without the 'workflow' scope cannot write under .github/workflows.
      const scope = syncError.status === 403 ? " (the credential may lack the 'workflow' scope)" : "";
      console.log(`  ✗ ${sync.path}: ${syncError.message}${scope}`);
      workflowNote = " 1 workflow failed";
      process.exitCode = 1;
    }
  }

  const results = await apply(client, steps);
  const applied = results.filter((r) => r.status === "applied");
  const failed = results.filter((r) => r.status === "failed");

  for (const result of applied) console.log(`  ✓ ${result.action === "create" ? "created" : "updated"} ${result.name}`);
  for (const result of failed) {
    console.log(`  ✗ ${result.name}: ${result.error}`);
    for (const detail of result.detail ?? []) {
      console.log(`      ${detail.message ?? JSON.stringify(detail)}`);
    }
  }

  console.log(`\n${applied.length} applied, ${results.length - applied.length - failed.length} unchanged, ${failed.length} failed.${workflowNote}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

/** Turns the API's terser refusals into something actionable. */
function explain(error) {
  // A 422 without its errors array is undebuggable ("Validation Failed" and
  // nothing else); GitHub puts the real reason one level down.
  const detail = (error.body?.errors ?? [])
    .map((e) => `\n  ${typeof e === "string" ? e : e.message ?? JSON.stringify(e)}`)
    .join("");
  if (/Upgrade to GitHub Pro/i.test(error.message)) {
    return (
      "This repository is private and owned by a personal account, where rulesets are a paid " +
      "feature.\n  Make the repo public, move it to an organisation, or upgrade to GitHub Pro."
    );
  }
  if (error.status === 404) {
    return `${error.message}\n  Check the repository exists and your token can see it.`;
  }
  return `${error.message}${detail}`;
}

main().catch((error) => {
  // Restore failures riding on the error mean a guard is still down — that
  // outranks whatever else went wrong, so it prints first and loudest.
  for (const failure of error?.restoreFailures ?? []) {
    console.error(
      `\n  ✗ RULESET '${failure.name}' IS STILL DISABLED — its restore failed: ${failure.error}` +
        `\n    The repository is unprotected by it until a re-run or a manual fix succeeds.`,
    );
  }
  // An access refusal is already written for a human; printing it verbatim
  // keeps its layout and avoids dressing it up as an API failure.
  if (error instanceof AccessDenied) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  console.error(`\nenforce-rules: ${explain(error)}\n`);
  process.exitCode = 1;
});
