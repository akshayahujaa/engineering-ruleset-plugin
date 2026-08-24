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
 *   enforce-rules --provider jira       choose the task tracker (clickup | jira | kaneo | none)
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
import {
  compile,
  referencedTeams,
  addEnvironments,
  knownEnvironments,
  approvalsAvailable,
  assertTeamSlugs,
  assertEnvironmentNames,
  requiredStatusCheckSecrets,
} from "./compiler.js";
import {
  createClient,
  GitHubError,
  ghInstalled,
  hasGitHubCredentials,
  loginInteractive,
  noCredentialsMessage,
} from "./github.js";
import { inspectCodeowners, planTeamSeed, describeSeed, assessCodeownerReview } from "./codeowners.js";
import { plan, apply, isBlockingMerges } from "./sync.js";
import {
  planTaskSync,
  applyTaskSync,
  planSyncOrphans,
  removeSyncOrphan,
  trackerCredentialsMissing,
  PROVIDERS,
} from "./tasksync.js";
import { planBranches, createMissingBranches, withRelaxedEnforcement } from "./branches.js";
import {
  planPrChecks,
  planPrCheckOrphans,
  applyPrCheckFile,
  removePrCheckOrphan,
  SCOPE_CHECK_CONTEXT,
  SCOPE_CHECK_WORKFLOW_PATH,
} from "./prchecks.js";
import {
  probeAccess,
  acceptAndReprobe,
  invitationGrantsAdmin,
  needsAdminMessage,
  AccessDenied,
} from "./access.js";

const ICON = { create: "CREATE ", update: "UPDATE ", unchanged: "UNCHANGED" };
const PROVIDER_CHOICES = ["clickup", "jira", "kaneo", "none"];

/**
 * Where to get, and what to call, a status-check secret this plugin does not
 * itself generate the workflow for. Keyed by secret name rather than by
 * status-check name, since that is what setupCredentials needs and what a
 * repeat check name would collide on.
 */
const STATUS_CHECK_SECRETS = {
  OPENROUTER_API_KEY: {
    label: "OpenRouter",
    tokenHint: "https://openrouter.ai/keys  (Create Key; the value starts 'sk-or-')",
  },
};

/**
 * Every credential the configured checks need, with why each one is needed.
 *
 * One list, gathered once, so choosing a task tracker surfaces ALL of the
 * repository's missing credentials at that moment — the AI key the scope check
 * and PR-Agent both read included — instead of the tracker token now and the
 * rest whenever someone next reads a plan closely. An absent secret makes a
 * required check fail, and a check that cannot run looks exactly like a check
 * that has not finished.
 *
 * The tracker's OWN secret and variables are excluded: they report through
 * `sync.hasToken` / `sync.missingVariables`, and naming them here as well would
 * say the same thing twice in one plan.
 *
 * @returns {{secrets: string[], variables: string[], reasons: Map<string, string>}}
 */
function requiredCredentials(config, sync, prChecks) {
  const reasons = new Map();
  // First writer wins, and status checks are written first on purpose: theirs
  // is the strongest claim — a required check that cannot run blocks every
  // merge — so it supplies the wording when two things want one secret.
  const note = (name, reason) => {
    if (!reasons.has(name)) reasons.set(name, reason);
  };

  for (const name of requiredStatusCheckSecrets(config)) {
    note(name, "required for a configured status check");
  }
  for (const name of prChecks.secrets) {
    note(name, "required by a pull-request check this sync generates");
  }

  const trackerOwned = new Set(
    [sync?.secretName, ...(PROVIDERS[sync?.provider]?.requiredVariables ?? [])].filter(Boolean),
  );
  const variables = prChecks.variables.filter((name) => !trackerOwned.has(name));
  for (const name of trackerOwned) reasons.delete(name);

  return { secrets: [...reasons.keys()], variables, reasons };
}

/**
 * Status checks the config requires that nothing here can report.
 *
 * Only a check this plugin was supposed to generate and could NOT is provably
 * unreportable. A scope check merely switched off in `prChecks` is a different
 * case: this plugin required that context for a long time before it generated
 * one, and the separate pr-guardrails suite may still be supplying it — so that
 * stays silent rather than quietly dropping a rule the repo does honour.
 */
function unavailableStatusChecks(prChecks) {
  return prChecks.blocked.some((note) => note.what === SCOPE_CHECK_WORKFLOW_PATH)
    ? [SCOPE_CHECK_CONTEXT]
    : [];
}

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
async function askExtraEnvironments(current, known) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `\nFirst sync of this repository. Every rule will be set up for: ${current.join(", ")}.` +
        (known.length > 0 ? `\nKnown extras you can add now: ${known.join(", ")}.` : ""),
    );
    const answer = await rl.question(
      "Add more environments? (comma-separated, empty for none) ",
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
      await rl.question("Task tracker to sync on merges — clickup (default), jira, kaneo, or none: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "clickup") return "clickup";
    if (["jira", "kaneo", "none"].includes(answer)) return answer;
    throw new Error(`Unknown tracker '${answer}' — expected clickup, jira, kaneo, or none.`);
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
        const hint = sync.variableHints?.[name] ?? "value";
        const value = (await rl.question(`  ${name}\n    ${hint}\n  > `)).trim();
        if (name === "JIRA_BASE_URL" && !/^https:\/\/.+/.test(value)) {
          throw new Error(`${name} must be an https:// URL.`);
        }
        if (name === "JIRA_EMAIL" && !value.includes("@")) {
          throw new Error(`${name} does not look like an email address.`);
        }
        if (name === "KANEO_API_URL" && !/^https?:\/\/.+/.test(value)) {
          throw new Error(`${name} must be an http:// or https:// URL.`);
        }
        if (name === "KANEO_PROJECT_ID" && !value) {
          throw new Error(`${name} cannot be empty.`);
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

/**
 * Puts the planned members into a team, one at a time so a single refusal
 * costs one person rather than the whole team.
 *
 * @returns {Promise<number>} how many members the team actually ended up with,
 *   which is what decides whether its review is satisfiable. Reporting the
 *   planned count instead would bind a reviewer rule to a team nobody is in.
 */
async function addTeamMembers(client, org, slug, team, members) {
  let added = 0;

  for (const login of members) {
    try {
      await client.addTeamMember(org, slug, login);
      console.log(`  ✓ added @${login} to ${team}`);
      added += 1;
    } catch (error) {
      console.log(
        `  ✗ @${login} → ${team}: ${error.message}` +
          (error.status === 403 ? "\n      (managing team membership needs org-admin rights)" : ""),
      );
      process.exitCode = 1;
    }
  }

  if (added === 0) {
    console.log(
      `      ${team} has no members, so it cannot supply the review it gates —` +
        `\n      the reviewer requirement is dropped rather than left blocking every merge`,
    );
    process.exitCode = 1;
  }
  return added;
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
  if (providerFlagGiven && !["clickup", "jira", "kaneo", "none"].includes(providerFlag)) {
    throw new Error(
      `--provider must be one of: clickup, jira, kaneo, none — got '${providerFlag ?? ""}'.`,
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

  // GitHub auth is a prerequisite for everything else. Rather than just
  // pointing at the door, offer to run `gh auth login` right here — the same
  // hand-off pattern as --set-token: gh owns the credential, this process
  // never sees it. Under the slash command (stdin is a pipe, no real
  // terminal) this is refused with the exact command to run instead, never
  // attempted through a pipe — gh's login flow asks interactive questions a
  // pipe cannot answer.
  if (!hasGitHubCredentials()) {
    const installed = ghInstalled();
    if (isInteractive() && !asJson && installed) {
      console.log("\nNo GitHub credentials found for the gh CLI.");
      if (await askYesNo("Log in now with 'gh auth login'? [y/N] ")) {
        try {
          loginInteractive();
        } catch {
          // gh exits non-zero on a cancelled or failed login; the recheck
          // below reports it either way, from a fresh auth-status check.
        }
      }
    }
    if (!hasGitHubCredentials()) {
      throw new AccessDenied(noCredentialsMessage(installed));
    }
  }

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
    const extras = await askExtraEnvironments(
      Object.keys(config.environments ?? {}),
      knownEnvironments(config),
    );
    const invalid = extras.filter((name) => !isValidEnvName(name));
    if (invalid.length > 0) throw new Error(`Not usable as branch names: ${invalid.join(", ")}`);
    requestedEnvs.push(...extras);
  }

  // A first sync with nothing chosen explicitly, on a stdin that cannot be
  // asked. Computed before addEnvironments so the defaults reported are the
  // ones actually in play.
  const firstSyncNeedsAnswers =
    preexisting.length === 0 && !providerFlagGiven && requestedEnvs.length === 0 && !isInteractive() && !setToken;

  const addedEnvs = addEnvironments(config, requestedEnvs);

  // Provider: --provider wins; a first sync on a real terminal is asked
  // (ClickUp default, then Jira, then none); otherwise the policy stands.
  const syncSection = config.taskSync ?? config.clickup;
  const configuredProvider = syncSection?.enabled ? (syncSection.provider ?? "clickup") : "none";
  let chosenProvider = providerFlag;
  // Distinct from providerChanged below: accepting the bundled default
  // (clickup) at this question is not a CHANGE from the config's own default,
  // but the user still just went through "pick a tracker" and expects the
  // very next thing to be "now give me its token" — the same way answering
  // "yes" to gh-auth-login is followed immediately by gh's own prompt.
  let providerJustAsked = false;
  if (
    chosenProvider === undefined &&
    preexisting.length === 0 &&
    isInteractive() &&
    !asJson &&
    !setToken
  ) {
    chosenProvider = await askProvider();
    providerJustAsked = true;
  }
  const defaultProvider = chosenProvider ?? configuredProvider;
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
      config.taskSync = { enabled: true, provider: chosenProvider };
    }
    // The documented shape is `taskSync`; a legacy `clickup` section being
    // rewritten anyway is renamed rather than persisted with, say, a Jira
    // provider inside a section named after ClickUp.
    if (config.taskSync === undefined && config.clickup !== undefined) {
      config.taskSync = config.clickup;
      delete config.clickup;
    }
  }

  // Declared here (rather than beside --set-token below) because this is the
  // FIRST place a credential write can happen — the plan-mode trailer needs
  // this true the moment either path writes something, or it would print
  // "nothing written" right under a "✓ ... is set" line, the exact lie an
  // earlier review caught for --set-token alone.
  let credentialWrites = false;

  // The moment a real tracker is chosen — accepting the default at the first-
  // sync question counts just as much as actually switching provider — offer
  // to wire up its credentials right there, exactly like the gh-auth-login
  // hand-off: ask once, then let gh's own hidden prompt take the token. This
  // fires in plan mode too, the same deliberate exception --set-token already
  // makes to "the plan never writes" — waiting for --apply would mean asking
  // the identical question twice for no reason. `sync` (below) isn't built
  // yet, so a small sync-shaped stub carries just what setupCredentials needs.
  //
  // Deliberately NOT gated on the provider having CHANGED. It used to be, and
  // that left the commonest case unasked: the bundled config already says
  // `clickup`, so `--provider clickup` — and any run on a repo that already has
  // rulesets — changed nothing and asked nothing, even on a real terminal.
  // Choosing what is already the default is still choosing it. The tracker's
  // token is a standing requirement of the config, exactly like the AI key
  // below, so it is offered whenever it is missing.
  const activeProvider = chosenProvider ?? configuredProvider;
  let trackerOfferMade = false;
  if (
    activeProvider !== "none" &&
    PROVIDERS[activeProvider] &&
    isInteractive() &&
    !asJson &&
    !setToken &&
    client.authMode === "gh cli"
  ) {
    const known = PROVIDERS[activeProvider];
    const credentialStub = {
      secretName: (activeProvider === configuredProvider ? syncSection?.secretName : undefined) ?? known.secretName,
      providerLabel: known.label,
      tokenHint: known.tokenHint,
      variableHints: known.variableHints ?? {},
      missingVariables: [],
    };
    for (const name of known.requiredVariables) {
      if (!(await client.hasVariable(name))) credentialStub.missingVariables.push(name);
    }
    credentialStub.hasToken = await client.hasSecret(credentialStub.secretName);

    if (trackerCredentialsMissing({ provider: activeProvider, ...credentialStub })) {
      if (
        await askYesNo(
          `\nSet up ${credentialStub.providerLabel} credentials now, via gh's hidden prompt? [y/N] `,
        )
      ) {
        credentialWrites = await setupCredentials(client, credentialStub);
        trackerOfferMade = true;
      } else {
        // Declining counts as having been asked: repeating the same question at
        // --apply is how a prompt turns into noise people click through.
        trackerOfferMade = true;
      }
    }
  }

  // The task-sync and PR-check plans are read-only, and they come first because
  // two later decisions need them: which credentials the chosen provider makes
  // mandatory (right below), and whether a required status check can be
  // reported at all (the compiler, further down).
  const sync = await planTaskSync(client, config);
  const orphans = await planSyncOrphans(client, sync?.provider ?? null);

  // PR-check workflows are generated the same way and land in the same place,
  // so they share the relax window below. Their issue provider comes from the
  // tracker already chosen, so ClickUp/Jira never has to be configured twice.
  const prChecks = await planPrChecks(client, config, { provider: sync?.provider ?? null });
  const prCheckOrphans = await planPrCheckOrphans(client, prChecks.files.map((f) => f.path));
  const prCheckWrites = prChecks.files.filter((f) => f.action !== "unchanged");

  // Every credential the configured checks need, in one list, so picking a
  // provider surfaces ALL of it at once rather than the tracker token now and
  // the AI key whenever someone next reads the plan closely.
  //
  // Excludes the tracker's own secret and variables: those have their own
  // reporting path (sync.hasToken / sync.missingVariables) and would otherwise
  // be named twice.
  const required = requiredCredentials(config, sync, prChecks);
  const missingStatusCheckSecrets = [];
  for (const name of required.secrets) {
    if (!(await client.hasSecret(name))) missingStatusCheckSecrets.push(name);
  }
  const missingCheckVariables = [];
  for (const name of required.variables) {
    if (!(await client.hasVariable(name))) missingCheckVariables.push(name);
  }

  // Same offer as the tracker's, above — but unlike that one, this is not
  // tied to a "just chosen" moment: it is a standing requirement of the
  // config, so it is checked on every interactive run, not only a first sync.
  if (isInteractive() && !asJson && !setToken && client.authMode === "gh cli") {
    for (const name of [...missingStatusCheckSecrets]) {
      const known = STATUS_CHECK_SECRETS[name];
      if (
        await askYesNo(
          `\nThe '${name}' secret is ${required.reasons.get(name)} and is not set. ` +
            `Set it up now, via gh's hidden prompt? [y/N] `,
        )
      ) {
        const stub = {
          secretName: name,
          providerLabel: known?.label ?? name,
          tokenHint: known?.tokenHint ?? "check the workflow that reports this status for where to get it",
          missingVariables: [],
        };
        const wrote = await setupCredentials(client, stub);
        credentialWrites = wrote || credentialWrites;
        if (wrote) missingStatusCheckSecrets.splice(missingStatusCheckSecrets.indexOf(name), 1);
      }
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

  // Whether a review requirement is satisfiable at all here. A failure to read
  // the collaborator list leaves this undefined, which the compiler reads as
  // "assume satisfiable" rather than silently stripping the policy.
  // viewer() returns null rather than throwing, so there is nothing to catch.
  const viewerLogin = await client.viewer();
  let pushCapable;
  try {
    pushCapable = await client.pushCapableCollaborators();
  } catch {
    /* undefined: unknown, not empty */
  }
  const reviewCapacity = pushCapable?.length;

  // Team ids are only resolvable when the repo's owner is the team's org. A
  // team that does not exist yet is planned for creation rather than silently
  // dropping the reviewer rule, and a team that exists with nobody in it is
  // planned for members — an empty team can never supply the review it gates,
  // so binding one blocks every merge just as hard as no team at all.
  const teamIds = {};
  const teamSlugs = {};
  const teamSizes = {};
  const missingTeams = [];
  const emptyTeams = [];
  assertEnvironmentNames(config);
  assertTeamSlugs(referencedTeams(config));
  if (context.ownerType === "Organization") {
    for (const team of referencedTeams(config)) {
      if (team.split("/")[0].toLowerCase() !== context.ownerLogin.toLowerCase()) continue;
      try {
        const info = await client.teamInfo(team);
        teamIds[team] = info.id;
        teamSlugs[team] = info.slug;
        teamSizes[team] = info.membersCount;
        if (info.membersCount === 0) emptyTeams.push(team);
      } catch (error) {
        // Only a 404 means "absent, so create it". Anything else (403 on a
        // secret team, a transient failure) must not trigger a create that
        // would then fail with "name already taken".
        if (error.status === 404) missingTeams.push(team);
      }
    }
  }

  // CODEOWNERS answers both team questions at once, off one read: who to put
  // in a team that has nobody, and — where no team can be bound at all, which
  // is every personal repo — whether it can gate the review by itself.
  //
  // Read only when the policy actually asks for a reviewer team; with none
  // named there is nothing to seed and nothing that could be dropped.
  const seeding = config.teamSeeding ?? {};
  const populateEmptyTeams = seeding.populateEmptyTeams ?? true;
  const teamsToPopulate = populateEmptyTeams ? emptyTeams : [];

  // Every team the policy names that will not bind as things stand: it is
  // missing, empty, another org's, or this repo has no organisation at all.
  // With none of those, CODEOWNERS has no question to answer and is not read.
  const unbindableTeams = referencedTeams(config).filter(
    (team) => teamIds[team] === undefined || teamSizes[team] === 0,
  );

  const codeowners =
    unbindableTeams.length > 0
      ? await inspectCodeowners(client, {
          org: context.ownerLogin,
          exclude: [...missingTeams, ...teamsToPopulate],
        })
      : null;

  // Substituted for a dropped team by the compiler, so it is worked out for
  // every repo — not only the org repos where a team was ever an option.
  const codeownerReview =
    unbindableTeams.length > 0 ? assessCodeownerReview(codeowners, { pushCapable }) : undefined;

  let seed = { path: null, members: [], skipped: [], runnerAdded: false, fromCodeowners: 0 };

  if (missingTeams.length > 0 || teamsToPopulate.length > 0) {
    seed = await planTeamSeed(client, {
      inspection: codeowners,
      org: context.ownerLogin,
      repoLabel: `${client.owner}/${client.repo}`,
      runner: viewerLogin,
      includeRunner: seeding.includeRunner ?? "fallback",
      fromCodeowners: seeding.fromCodeowners ?? true,
      pushCapable,
    });
  }

  // A team with nobody in it blocks every merge, so an empty seed means the
  // team is left alone and the reviewer requirement degrades — loudly — rather
  // than being bound to a team that cannot approve.
  const teamsToCreate = seed.members.length > 0 ? missingTeams : [];
  const teamsToFill = seed.members.length > 0 ? teamsToPopulate : [];
  const unseedable = seed.members.length > 0 ? [] : [...missingTeams, ...teamsToPopulate];

  const compileContext = {
    ...context,
    teamIds,
    teamSizes,
    viewerLogin,
    reviewCapacity,
    codeownerReview,
    pendingTeams: teamsToCreate,
    // Names already on the repo: a reviewer ruleset that cannot survive here
    // must still be emitted (neutered) if it already exists, or the live one
    // keeps blocking merges while the plan calls it merely "unmanaged".
    existingRulesetNames: preexisting.map((r) => r.name),
    // Checks the config requires that nothing here can report. The compiler
    // drops these rather than requiring them: a required check no workflow
    // reports never turns green, so it blocks every merge instead of guarding
    // it — and one baseline ruleset now carries the check across EVERY
    // environment, so getting this wrong would brick the whole pipeline, not
    // one branch.
    unavailableStatusChecks: unavailableStatusChecks(prChecks),
  };
  // A team this run creates or fills is as big as the seed it gets, which is
  // what makes its review satisfiable — a team review needs one approver who
  // is not the author, so the size matters, not merely the team's existence.
  for (const team of [...teamsToCreate, ...teamsToFill]) teamSizes[team] = seed.members.length;

  let { rulesets, degradations } = compile(config, compileContext);
  let { steps, undeclared } = await plan(client, rulesets);

  const syncPending =
    Boolean(sync && sync.action !== "unchanged") ||
    orphans.length > 0 ||
    prCheckWrites.length > 0 ||
    prCheckOrphans.length > 0;
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
  if (setToken) {
    if (!sync) {
      throw new Error("--set-token: task sync is not enabled in the policy (provider 'none').");
    }
    // OR, not assign: the early provider-select prompt above may already have
    // written something this same run, and that must not be forgotten just
    // because this second write attempt (or a no-op if already satisfied)
    // happens to report false.
    credentialWrites = (await setupCredentials(client, sync)) || credentialWrites;
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
          firstSync: firstSyncNeedsAnswers
            ? {
                needsAnswers: true,
                provider: { default: defaultProvider, choices: PROVIDER_CHOICES },
                environments: {
                  default: Object.keys(config.environments ?? {}),
                  canAdd: knownEnvironments(config),
                },
              }
            : { needsAnswers: false },
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
            // The pipeline is the whole subject of a task-sync change; a JSON
            // consumer approving an update must be able to see it.
            pipeline: sync.pipeline,
            // Rank 1, ahead of every environment: the stage a push reaches.
            push: sync.push,
            pushBlocked: sync.pushBlocked,
          },
          removedSyncWorkflows: orphans.map((o) => o.path),
          prChecks: {
            files: prChecks.files.map(({ path, action, label }) => ({ path, action, label })),
            blocked: prChecks.blocked,
            removed: prCheckOrphans.map((o) => o.path),
          },
          // Secrets the configured checks need (e.g. OPENROUTER_API_KEY, which
          // both the scope check and PR-Agent read) that are not set on the
          // repository. Excludes the tracker's own token — that is taskSync.hasToken.
          missingStatusCheckSecrets,
          // Non-sensitive repository variables those same checks need.
          missingCheckVariables,
          teamsToCreate,
          teamsToFill,
          teamSeed: {
            // Who joins an org team is a membership change, so a machine
            // consumer approving this plan must see the names, not a count.
            codeowners: seed.path,
            members: seed.members,
            runnerAdded: seed.runnerAdded,
            skipped: seed.skipped,
            unseedableTeams: unseedable,
          },
          // What carries the review where no team could be bound at all.
          codeownerReview: codeownerReview ?? null,
          reviewCapacity,
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

  // On a first sync the CLI cannot ask (stdin is a pipe under the slash
  // command), so it says so here instead. Leaving this implicit meant the
  // caller saw an ordinary plan, reported it, and the user was never asked —
  // the choices below were made silently by default.
  if (firstSyncNeedsAnswers) {
    console.log(
      `  ━━ FIRST SYNC — ${client.owner}/${client.repo} HAS NO RULESETS YET ━━\n` +
        `  Two choices are about to be made for it, both currently at their default.\n` +
        `  ASK THE USER before applying, then re-run with the flags:\n\n` +
        `    1. Task tracker   default: ${defaultProvider}` +
        `${" ".repeat(Math.max(1, 12 - defaultProvider.length))}alternatives: ${PROVIDER_CHOICES.filter((p) => p !== defaultProvider).join(", ")}\n` +
        `                      → --provider <choice>\n\n` +
        `    2. Environments   default: ${Object.keys(config.environments ?? {}).join(", ")}` +
        `${knownEnvironments(config).length > 0 ? `           can add: ${knownEnvironments(config).join(", ")}, or any name` : ""}\n` +
        `                      → --env <name>  (repeatable)\n\n` +
        `  Applying without those flags accepts the defaults shown above.\n`,
    );
  }

  // A degradation is not always a loss: where a dropped team is replaced by
  // code-owner review the rule still binds, and reading that out as "degraded"
  // would understate what the repository ends up with.
  const describeDrop = (note) => {
    const pad = " ".repeat(13);
    if (note.substituted) return `${pad}[substituted: ${note.substituted} on — ${note.reason}]`;
    if (note.unsubstituted) {
      return (
        `${pad}[${note.unsubstituted} not substituted — ${note.reason}]` +
        (note.remedy ? `\n${pad} to enable it: ${note.remedy}` : "")
      );
    }
    return (
      `${pad}[degraded: ${note.dropped}` +
      (note.reducedTo !== undefined ? ` reduced to ${note.reducedTo}` : " dropped") +
      ` — ${note.reason}]` +
      (note.remedy ? `\n${pad} to restore it: ${note.remedy}` : "")
    );
  };

  for (const step of steps) {
    console.log(`  ${ICON[step.action]}  ${step.name.padEnd(30)} → ${describeScope(step.payload)}`);
    // A full PUT replaces the conditions, so refs leaving the scope lose this
    // ruleset's protection entirely — never visible from the new scope alone.
    if (step.dropped?.length > 0) {
      const droppedEnvs = step.dropped.map((r) => r.replace("refs/heads/", ""));
      // The exact drift that made pr-guardrails' clickup-sync.yml look "stuck":
      // GitHub already protects a branch that this config no longer declares,
      // so it also has no task-sync stage — and nothing said so until this
      // check existed, which is why it went unnoticed for hours there.
      const unsynced = sync ? droppedEnvs.filter((e) => !sync.pipeline.some((st) => st.env === e)) : [];
      console.log(
        `${" ".repeat(13)}[no longer covers ${droppedEnvs.join(", ")}` +
          ` — those refs lose this ruleset's protection` +
          (unsynced.length > 0
            ? `;\n${" ".repeat(14)}it also means ${sync.providerLabel} sync will not fire for ` +
              `${unsynced.join(", ")} — add ${unsynced.length > 1 ? "them" : "it"} back to` +
              ` "environments" if that is not intended`
            : "") +
          "]",
      );
    }
    // Every drop, not just the first: a ruleset can lose its team AND its
    // approval count, and hiding the second one hides the bigger change.
    for (const note of degradations.filter((d) => d.ruleset === step.name)) {
      console.log(describeDrop(note));
    }
  }

  // Degradations whose ruleset is no longer generated have no step to hang
  // off, so they would otherwise vanish silently. One line per ruleset, with
  // its reasons underneath — not one line per reason.
  const skipped = [...new Set(degradations.filter((d) => !steps.some((s) => s.name === d.ruleset)).map((d) => d.ruleset))];
  for (const name of skipped) {
    console.log(`  SKIPPED  ${name.padEnd(30)} → not created; nothing it asked for can apply here`);
    for (const note of degradations.filter((d) => d.ruleset === name)) console.log(describeDrop(note));
  }

  const available = approvalsAvailable(compileContext);
  for (const { name, ruleset } of undeclared) {
    console.log(`  UNMANAGED  ${name.padEnd(30)} → not in config; left untouched`);
    // A leftover from an earlier policy can still be blocking every merge.
    // Saying only "left untouched" would present a live problem as a non-event.
    if (isBlockingMerges(ruleset, available)) {
      const refs = (ruleset.conditions?.ref_name?.include ?? [])
        .map((r) => r.replace("refs/heads/", ""))
        .join(", ");
      console.log(
        `${" ".repeat(13)}⚠ THIS RULESET IS BLOCKING MERGES into ${refs}: it demands a review` +
          `\n${" ".repeat(13)}  this repository cannot supply (at most ${available} approval(s) available).` +
          `\n${" ".repeat(13)}  The sync will not touch it — delete or edit it at` +
          `\n${" ".repeat(13)}  https://github.com/${client.owner}/${client.repo}/settings/rules`,
      );
    }
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
    // With no branches to create there is no CREATE line above this, so the
    // note needs its own heading or it reads as part of the previous ruleset.
    const lead = branches.missing.length > 0 ? `${" ".repeat(13)}[` : `\n  RELAX    ${"".padEnd(30)} → [`;
    console.log(
      `${lead}${branches.blocked.map((r) => r.name).join(", ")} would refuse this;` +
        `\n              each is disabled only while ${writes},` +
        `\n              then restored to 'active']`,
    );
  }

  for (const team of teamsToCreate) {
    console.log(
      `\n  CREATE   ${`team ${team}`.padEnd(30)} → does not exist in '${context.ownerLogin}'; it will be` +
        `\n             created with ${describeSeed(seed)},` +
        `\n             so the reviews it gates can actually be satisfied`,
    );
  }

  // An existing team with nobody in it fails exactly like a missing one: the
  // rule binds, and no merge can ever satisfy it. Filling it is what turns the
  // degradation into a working reviewer requirement.
  for (const team of teamsToFill) {
    console.log(
      `\n  MEMBERS  ${`team ${team}`.padEnd(30)} → exists in '${context.ownerLogin}' but is empty, so its` +
        `\n             review could never be supplied; it will be given ${describeSeed(seed)}`,
    );
  }

  // Joining someone to a team is an org membership change, so who was left out
  // is as much a part of the plan as who is in.
  if ((teamsToCreate.length > 0 || teamsToFill.length > 0) && seed.skipped.length > 0) {
    console.log(
      `${" ".repeat(13)}[not added:\n${" ".repeat(15)}` +
        seed.skipped.map((note) => `${note.who} — ${note.reason}`).join(`\n${" ".repeat(15)}`) +
        "]",
    );
  }

  for (const team of unseedable) {
    console.log(
      `\n  NOTE     ${`team ${team}`.padEnd(30)} → ${missingTeams.includes(team) ? "does not exist" : "is empty"},` +
        `\n             and nobody could be found to put in it — ${describeSeed(seed)}.` +
        `\n             It is left alone, because a reviewer team with no members blocks every` +
        `\n             merge; the reviewer requirement is degraded instead.` +
        (seed.skipped.length > 0
          ? `\n${" ".repeat(13)}[considered:\n${" ".repeat(15)}` +
            seed.skipped.map((note) => `${note.who} — ${note.reason}`).join(`\n${" ".repeat(15)}`) +
            "]"
          : "") +
        `\n             To fix it: name owners in ${seed.path ?? ".github/CODEOWNERS"} who have write` +
        `\n             access to this repository and are members of '${context.ownerLogin}', then re-run.`,
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
    // The push stage is printed first because it IS first: it is rank 1, ahead
    // of every environment, and reading the pipeline without it would suggest a
    // task only starts moving once something is merged.
    const pushLine = sync.push
      ? `\n${" ".repeat(13)} push ${sync.push.prefixes.map((p) => `${p}/**`).join(", ")} → '${sync.push.status}'`
      : "";
    console.log(
      `\n  ${ICON[sync.action]}  ${sync.path.padEnd(30)} → ${sync.providerLabel} pipeline:` +
        pushLine +
        `\n${sync.pipeline.map((st) => `${" ".repeat(13)} merge into ${st.env} → '${st.status}'`).join("\n")}` +
        `\n${" ".repeat(13)} (forwards only — a task at or past a stage is never pulled back)`,
    );
    // Asked for and not delivered: an unmentioned push stage is indistinguishable
    // from one nobody configured.
    if (sync.pushBlocked) {
      console.log(
        `${" ".repeat(13)}[no push stage: ${sync.pushBlocked} —` +
          `\n${" ".repeat(13)} tasks will only move on merges until then]`,
      );
    }
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

  for (const file of prChecks.files) {
    console.log(`\n  ${ICON[file.action]}  ${file.path.padEnd(30)} → ${file.label}`);
    if (file.adopting) {
      console.log(
        `${" ".repeat(13)}[this file already exists and was NOT written by this plugin —` +
          `\n${" ".repeat(13)} applying REPLACES it, and regenerates over it on every run afterwards]`,
      );
    }
  }
  // The Trivy gate's threshold and scope are policy, not implementation detail:
  // they decide which pull requests stop, so they belong in the plan the user
  // approves rather than only in the generated YAML.
  if (prChecks.trivy) {
    const t = prChecks.trivy;
    const scope =
      t.blockScope === "repository"
        ? "anywhere in the repository"
        : "in the files a pull request touches";
    console.log(
      `\n  GATE     ${t.rulesetName.padEnd(30)} → status check '${t.statusCheck}' on every environment:` +
        `\n${" ".repeat(13)} ${t.blockOn.join("/")} blocks the merge, ${scope}` +
        `\n${" ".repeat(13)} scanners: ${t.scanners.join(", ")}; ` +
        `${t.severities.filter((sv) => !t.blockOn.includes(sv)).join("/") || "nothing else"} reported only` +
        (t.ignoreUnfixed ? `\n${" ".repeat(13)} a vulnerability with no released fix is reported, never blocking` : ""),
    );
  }

  // A check the config asked for that cannot be generated here is named, not
  // silently skipped — an absent scope check looks identical to a passing one.
  for (const note of prChecks.blocked) {
    console.log(`\n  SKIPPED  ${note.what.padEnd(30)} → ${note.reason}`);
  }
  for (const orphan of prCheckOrphans) {
    console.log(
      `\n  DELETE   ${orphan.path.padEnd(30)} → no longer enabled in the policy;` +
        `\n             it would keep running on every pull request`,
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
  if (trackerCredentialsMissing(sync ?? {})) {
    if (shouldApply && isInteractive() && client.authMode === "gh cli" && !trackerOfferMade) {
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
          ? `\n  Also missing repository variable(s). These are not secrets, so set them directly:\n` +
            sync.missingVariables
              .map(
                (name) =>
                  `\n      gh variable set ${name} --repo ${client.owner}/${client.repo}` +
                  (sync.variableHints?.[name] ? `\n        ↳ ${sync.variableHints[name]}` : ""),
              )
              .join("") +
            "\n"
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

  // The interactive offer above already had its chance this run; anywhere
  // that offer could not fire (non-interactive, declined, no gh cli) gets the
  // manual command instead, exactly like the tracker's own fallback.
  for (const name of missingStatusCheckSecrets) {
    const known = STATUS_CHECK_SECRETS[name];
    console.log(
      `\n  The '${name}' secret is ${required.reasons.get(name)} and is not set —` +
        `\n  merges may block on it until it is. Set it yourself, in your own terminal:` +
        `\n\n      gh secret set ${name} --repo ${client.owner}/${client.repo}` +
        `\n\n  (or re-run this on a real terminal, which offers to set it up for you).` +
        (known ? ` Get one from ${known.tokenHint}.` : ""),
    );
  }

  // Not secrets, so there is no hidden-prompt hand-off for these — just the
  // command. Reported all the same: a check missing a variable fails exactly
  // like a check missing a token.
  for (const name of missingCheckVariables) {
    const hint = sync?.variableHints?.[name];
    console.log(
      `\n  The '${name}' repository variable is required by a configured check and is not set.` +
        `\n  It is not sensitive, so set it directly:` +
        `\n\n      gh variable set ${name} --repo ${client.owner}/${client.repo}` +
        (hint ? `\n\n  Where to find it: ${hint}` : ""),
    );
  }

  const pending =
    writes.length +
    prCheckWrites.length +
    prCheckOrphans.length +
    (sync && sync.action !== "unchanged" ? 1 : 0) +
    orphans.length +
    branches.missing.length +
    policyEdits.length +
    teamsToCreate.length +
    teamsToFill.length;

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

  // Teams first: the ruleset payload needs a real team id, so the rulesets are
  // recompiled once the team exists. Creating a team and adding members
  // changes org membership, which is why it is never done during a plan.
  if (teamsToCreate.length > 0 || teamsToFill.length > 0) {
    for (const team of teamsToCreate) {
      const [org, slug] = team.split("/");
      try {
        const made = await client.createTeam(org, slug);
        console.log(`  ✓ created team ${team}`);
        teamIds[team] = made.id;
        // The membership is not decoration: a team with no members can never
        // supply the review it gates, so the size recorded here is how many
        // members really landed — not how many were planned.
        teamSizes[team] = await addTeamMembers(client, org, made.slug ?? slug, team, seed.members);
      } catch (error) {
        console.log(
          `  ✗ team ${team}: ${error.message}` +
            (error.status === 403
              ? "\n      (creating a team and managing its membership need org-admin rights)"
              : "") +
            `\n      the reviewer requirement is dropped rather than bound to a team that cannot approve`,
        );
        teamSizes[team] = 0;
        process.exitCode = 1;
      }
    }

    // An existing team that is empty: same failure, same fix. Only its
    // membership changes — the team itself is left exactly as it was.
    for (const team of teamsToFill) {
      const [org] = team.split("/");
      teamSizes[team] = await addTeamMembers(client, org, teamSlugs[team], team, seed.members);
    }

    // Always recompile, not only on success. Every team here was sized by the
    // seed it was planned to get, so a failed creation would otherwise ship
    // `reviewer: {id: undefined}` and be rejected wholesale — and a team whose
    // members all bounced would be bound while nobody can approve through it.
    const before = degradations;
    ({ rulesets, degradations } = compile(config, { ...compileContext, teamIds, teamSizes, pendingTeams: [] }));
    ({ steps, undeclared } = await plan(client, rulesets));

    // Degradations the plan did not show, because they only became true when
    // a team creation failed. Silence here would make the apply quietly
    // weaker than the plan the user approved.
    for (const note of degradations.filter(
      (d) => !before.some((b) => b.ruleset === note.ruleset && b.dropped === note.dropped),
    )) {
      console.log(`  ! ${note.ruleset}: ${note.dropped} dropped — ${note.reason}`);
    }
  }

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
    const prCheckResults = [];
    const prCheckErrors = [];

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
      // Same window, same reason: these are writes to the default branch that
      // the pull_request rule would otherwise refuse.
      for (const file of prCheckWrites) {
        try {
          await applyPrCheckFile(client, file);
          prCheckResults.push({ path: file.path, action: file.action });
        } catch (error) {
          prCheckErrors.push({ path: file.path, error });
        }
      }
      for (const orphan of prCheckOrphans) {
        try {
          await removePrCheckOrphan(client, orphan);
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
    for (const result of prCheckResults) {
      console.log(`  ✓ ${result.action === "create" ? "created" : "updated"} ${result.path}`);
    }
    for (const failure of prCheckErrors) {
      const scope = failure.error.status === 403 ? " (the credential may lack the 'workflow' scope)" : "";
      console.log(`  ✗ ${failure.path}: ${failure.error.message}${scope}`);
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
