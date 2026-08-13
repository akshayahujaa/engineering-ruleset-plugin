#!/usr/bin/env node
/**
 * enforce-rules — sync branch rulesets into the current GitHub repository.
 *
 *   enforce-rules                       plan for the repo in the current directory
 *   enforce-rules --repo owner/name     plan for any repo, no clone needed
 *   enforce-rules --apply               apply instead of only planning
 *   enforce-rules --json                machine-readable plan
 *   enforce-rules --accept-invite       accept a pending invitation to the target repo
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile, referencedTeams } from "./compiler.js";
import { createClient, GitHubError } from "./github.js";
import { plan, apply } from "./sync.js";
import { planClickUp, applyClickUp } from "./clickup.js";
import {
  probeAccess,
  acceptAndReprobe,
  invitationGrantsAdmin,
  needsAdminMessage,
  AccessDenied,
} from "./access.js";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A repository may override the bundled policy by committing its own config,
 * which keeps the plugin generic while letting one repo diverge.
 */
function loadConfig(cwd) {
  const override = path.join(cwd, ".github", "ruleset-config.json");
  const source = existsSync(override) ? override : path.join(PLUGIN_ROOT, "ruleset-config.json");

  try {
    return { config: JSON.parse(readFileSync(source, "utf8")), source };
  } catch (error) {
    throw new Error(`Cannot read ruleset config at ${source}: ${error.message}`);
  }
}

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

  // --repo owner/name targets any repository without cloning or cd-ing into it.
  const repoFlag = args.find((a) => a.startsWith("--repo="))?.split("=")[1] ?? args[args.indexOf("--repo") + 1];
  const repo = args.includes("--repo") || args.some((a) => a.startsWith("--repo=")) ? repoFlag : undefined;

  const { config, source } = loadConfig(cwd);
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

  if (asJson) {
    console.log(JSON.stringify({ repo: `${client.owner}/${client.repo}`, steps, degradations, undeclared }, null, 2));
    return;
  }

  console.log(`\nRepository: ${client.owner}/${client.repo} (${context.visibility}, ${context.ownerType.toLowerCase()}-owned)`);
  console.log(`Policy:     ${path.relative(cwd, source) || source}`);
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

  const pending = writes.length + (clickup && clickup.action !== "unchanged" ? 1 : 0);

  if (!shouldApply) {
    console.log(
      pending === 0
        ? "\nAlready in sync. Nothing to apply.\n"
        : `\nPlan only — nothing written. Re-run with --apply to make these ${pending} change(s).\n`,
    );
    return;
  }

  const results = await apply(client, steps);
  const applied = results.filter((r) => r.status === "applied");
  const failed = results.filter((r) => r.status === "failed");

  console.log("");
  for (const result of applied) console.log(`  ✓ ${result.action === "create" ? "created" : "updated"} ${result.name}`);
  for (const result of failed) {
    console.log(`  ✗ ${result.name}: ${result.error}`);
    for (const detail of result.detail ?? []) {
      console.log(`      ${detail.message ?? JSON.stringify(detail)}`);
    }
  }

  let workflowNote = "";
  if (clickup && clickup.action !== "unchanged") {
    try {
      await applyClickUp(client, clickup);
      console.log(`  ✓ ${clickup.action === "create" ? "created" : "updated"} ${clickup.path}`);
    } catch (error) {
      // A token without the 'workflow' scope cannot write under .github/workflows.
      const scope = error.status === 403 ? " (the credential lacks the 'workflow' scope)" : "";
      console.log(`  ✗ ${clickup.path}: ${error.message}${scope}`);
      workflowNote = " 1 workflow failed";
      process.exitCode = 1;
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
