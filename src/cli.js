#!/usr/bin/env node
/**
 * enforce-rules — sync branch rulesets into the current GitHub repository.
 *
 *   enforce-rules                       plan for the repo in the current directory
 *   enforce-rules --repo owner/name     plan for any repo, no clone needed
 *   enforce-rules --apply               apply instead of only planning
 *   enforce-rules --json                machine-readable plan
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile, referencedTeams } from "./compiler.js";
import { createClient, GitHubError } from "./github.js";
import { plan, apply } from "./sync.js";

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

function describeScope(ruleset) {
  const { include = [], exclude = [] } = ruleset.conditions?.ref_name ?? {};
  const shown = include.map((r) => r.replace("refs/heads/", "")).join(", ");
  return exclude.length ? `${shown} (except ${exclude.length} excluded refs)` : shown;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldApply = args.includes("--apply");
  const asJson = args.includes("--json");
  const cwd = process.cwd();

  // --repo owner/name targets any repository without cloning or cd-ing into it.
  const repoFlag = args.find((a) => a.startsWith("--repo="))?.split("=")[1] ?? args[args.indexOf("--repo") + 1];
  const repo = args.includes("--repo") || args.some((a) => a.startsWith("--repo=")) ? repoFlag : undefined;

  const { config, source } = loadConfig(cwd);
  const client = createClient({ cwd, repo });
  const context = await client.context();

  if (!context.isAdmin) {
    throw new GitHubError(
      `You need admin on ${client.owner}/${client.repo} to manage rulesets; your token does not have it.`,
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

  if (!shouldApply) {
    console.log(
      writes.length === 0
        ? "\nAlready in sync. Nothing to apply.\n"
        : `\nPlan only — nothing written. Re-run with --apply to make these ${writes.length} change(s).\n`,
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

  console.log(`\n${applied.length} applied, ${results.length - applied.length - failed.length} unchanged, ${failed.length} failed\n`);
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
  console.error(`\nenforce-rules: ${explain(error)}\n`);
  process.exitCode = 1;
});
