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
 */

import { writeFileSync } from "node:fs";
import {
  resolveConfig,
  isMarketplaceClone,
  isValidEnvName,
  parseEnvList,
  OVERRIDE_PATH,
} from "./config.js";
import { compile, referencedTeams, addEnvironments } from "./compiler.js";
import { createClient, GitHubError } from "./github.js";
import { plan, apply } from "./sync.js";
import { planClickUp, applyClickUp } from "./clickup.js";
import { planBranches, applyBranches } from "./branches.js";
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
  const cwd = process.cwd();

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

  // --repo owner/name targets any repository without cloning or cd-ing into it.
  const repoFlag = args.find((a) => a.startsWith("--repo="))?.split("=")[1] ?? args[args.indexOf("--repo") + 1];
  const repo = args.includes("--repo") || args.some((a) => a.startsWith("--repo=")) ? repoFlag : undefined;

  const client = createClient({ cwd, repo });
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
  const preexisting = await client.listRulesets();
  if (preexisting.length === 0 && requestedEnvs.length === 0 && isInteractive() && !asJson) {
    const extras = await askExtraEnvironments(Object.keys(config.environments ?? {}));
    const invalid = extras.filter((name) => !isValidEnvName(name));
    if (invalid.length > 0) throw new Error(`Not usable as branch names: ${invalid.join(", ")}`);
    requestedEnvs.push(...extras);
  }

  const addedEnvs = addEnvironments(config, requestedEnvs);

  // A committed override can only be changed by a pull request to that repo —
  // the plugin must not try to write it, and pretending the env was added
  // while persisting nothing would plan a policy the next run forgets.
  if (addedEnvs.length > 0 && writablePath == null) {
    throw new AccessDenied(
      `This repository's policy comes from its committed ${OVERRIDE_PATH}, which cannot be ` +
        `edited from here.\nAdd ${addedEnvs.map((e) => `'${e}'`).join(", ")} to "environments" in ` +
        `that file via a pull request, then re-run.`,
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
  const clickup = await planClickUp(client, config.clickup);
  const branches = await planBranches(client, Object.keys(config.environments ?? {}), context.defaultBranch);

  if (asJson) {
    // Branches carry the relax-to-evaluate window — the plan's most dangerous
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
          clickup: clickup && { path: clickup.path, action: clickup.action, hasToken: clickup.hasToken },
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
    if (isMarketplaceClone(writablePath)) {
      console.log(
        `             [this plugin install is a marketplace clone: the edit is lost on` +
          `\n              'claude plugin marketplace update' — also commit it to the plugin repo]`,
      );
    }
  }

  if (branches.missing.length > 0) {
    console.log(
      `\n  CREATE   ${branches.missing.join(", ").padEnd(30)} → environment branch(es), from ${context.defaultBranch}`,
    );
    if (branches.blocked.length > 0) {
      console.log(
        `             [${branches.blocked.map((r) => r.name).join(", ")} would refuse this;` +
          `\n              each is dropped to 'evaluate' only while the branches are created,` +
          `\n              then restored to 'active']`,
      );
    }
  }

  if (clickup) {
    console.log(
      `\n  ${ICON[clickup.action]}  ${clickup.path.padEnd(30)} → on merge into ` +
        `${config.clickup.targetBranch ?? "dev"}, move the task to '${config.clickup.targetStatus ?? "in progress"}'`,
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
  // would put it in shell history and the process table. `gh secret set` reads
  // it silently and encrypts it before it leaves the machine.
  if (clickup && !clickup.hasToken) {
    console.log(
      `\n  The ${clickup.secretName} secret is not set on this repository, so the workflow` +
        `\n  will skip every task until it is. Set it yourself — it is never typed here:` +
        `\n\n      gh secret set ${clickup.secretName} --repo ${client.owner}/${client.repo}` +
        `\n\n  Paste your ClickUp personal API token at the prompt. Get one from ClickUp:` +
        `\n  Settings → Apps → API Token.`,
    );
  }

  const pending =
    writes.length + (clickup && clickup.action !== "unchanged" ? 1 : 0) + branches.missing.length;

  if (!shouldApply) {
    console.log(
      pending === 0
        ? "\nAlready in sync. Nothing to apply.\n"
        : `\nPlan only — nothing written. Re-run with --apply to make these ${pending} change(s).\n`,
    );
    return;
  }

  console.log("");

  // Persisting the new environment is what makes it survive the next run;
  // without it the next sync would plan the environment away again.
  if (addedEnvs.length > 0) {
    writeFileSync(writablePath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  ✓ added ${addedEnvs.join(", ")} to ${policyLabel}`);
  }

  // Branches first: a ruleset requiring a PR for dev makes creating dev
  // impossible, so the guard has to go up after the branch exists.
  const { results: branchResults, restoreFailures } = await applyBranches(
    client,
    branches,
    context.defaultBranch,
  );
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
      `  ✗ RULESET '${failure.name}' IS STILL IN 'evaluate' — its restore failed: ${failure.error}` +
        `\n    The repository is unprotected by it until a re-run or a manual fix succeeds.`,
    );
    process.exitCode = 1;
  }

  // The ClickUp workflow file goes in BEFORE the rulesets: once Pull Request
  // Compulsion is active on the default branch (with no bypass actors), the
  // Contents-API write of this very file would be refused.
  let workflowNote = "";
  if (clickup && clickup.action !== "unchanged") {
    try {
      await applyClickUp(client, clickup);
      console.log(`  ✓ ${clickup.action === "create" ? "created" : "updated"} ${clickup.path}`);
    } catch (error) {
      // A token without the 'workflow' scope cannot write under .github/workflows;
      // on a repo whose rulesets are already active, the write needs a PR instead.
      const scope = error.status === 403 ? " (the credential lacks the 'workflow' scope)" : "";
      console.log(`  ✗ ${clickup.path}: ${error.message}${scope}`);
      if (steps.every((s) => s.action === "unchanged")) {
        console.log(
          `      The rulesets are already active, so this file now needs a pull request:` +
            `\n      commit it to a feature branch and merge it into ${context.defaultBranch}.`,
        );
      }
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
  if (/Upgrade to GitHub Pro/i.test(error.message)) {
    return (
      "This repository is private and owned by a personal account, where rulesets are a paid " +
      "feature.\n  Make the repo public, move it to an organisation, or upgrade to GitHub Pro."
    );
  }
  if (error.status === 404) {
    return `${error.message}\n  Check the repository exists and your token can see it.`;
  }
  return error.message;
}

main().catch((error) => {
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
