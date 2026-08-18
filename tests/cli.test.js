/**
 * End-to-end runs of the command against a fake `gh`.
 *
 * The reviewer team is the one part of this plugin that changes GitHub state
 * outside the repository — it creates a team and puts people in it — so the
 * decision of who goes in is worth testing through the CLI itself, not only
 * through the module that computes it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./helpers/fake-gh.js", import.meta.url));
const CLI = path.join(ROOT, "src", "cli.js");
const REPO = "tehvault/app";

const encode = (value) => Buffer.from(value, "utf8").toString("base64");
const file = (content) => ({ sha: "sha1", content: encode(content) });

/** The calls every run makes before it gets anywhere near a team. */
function baseFixture({ collaborators = ["alice", "bob", "runner"], rulesets = [] } = {}) {
  return {
    "GET user": { login: "runner" },
    [`GET repos/${REPO}`]: {
      owner: { type: "Organization", login: "tehvault" },
      default_branch: "main",
      visibility: "private",
      permissions: { admin: true },
    },
    [`GET repos/${REPO}/rulesets?per_page=100&includes_parents=false`]: rulesets,
    [`GET repos/${REPO}/collaborators?per_page=100&page=1`]: collaborators.map((login) => ({
      login,
      permissions: { push: true },
    })),
    [`GET repos/${REPO}/branches?per_page=100&page=1`]: [{ name: "main" }, { name: "dev" }],
    "GET orgs/tehvault/members?per_page=100&page=1": [
      { login: "alice" },
      { login: "bob" },
      { login: "runner" },
    ],
  };
}

/** Runs the CLI with `gh` shimmed to the fake, and returns stdout plus the call log. */
function run(fixture, args = ["--json"], envOverrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "enforce-rules-"));
  const fixturePath = path.join(dir, "fixture.json");
  const logPath = path.join(dir, "calls.jsonl");
  const shim = path.join(dir, "gh");

  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(shim, `#!/bin/sh\nexec node "${FAKE_GH}" "$@"\n`);
  chmodSync(shim, 0o755);

  // A run that reports a partial failure exits non-zero on purpose, and its
  // output is exactly what such a test is asserting on.
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, "--repo", REPO, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      // A run with no real terminal must never block waiting on a prompt —
      // if the CLI mistakenly tried to ask something here, this timeout is
      // what turns a hang into a failed test instead of a stuck test run.
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_FIXTURE: fixturePath,
        FAKE_GH_LOG: logPath,
        // The gh shim is the only route; a token in the environment would send
        // the client down the fetch path and out to the real API.
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        ...envOverrides,
      },
    });
  } catch (error) {
    // A refusal thrown before any plan is built (no repo access, no GitHub
    // credentials, ...) is reported via console.error, i.e. stderr — stdout
    // alone would be empty for exactly the runs this harness most wants to
    // assert messages against.
    stdout = (error.stdout ?? "") + (error.stderr ?? "");
    status = error.status;
    if (status === null) throw error;
  }

  const calls = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

  // A run that never reached the JSON output (an early refusal, a thrown
  // error) leaves `stdout` holding a plain-text message, not JSON — parsing
  // that isn't a bug in the CLI, so it resolves to `plan: null` rather than
  // throwing out of the test helper itself.
  let plan = null;
  if (args.includes("--json")) {
    try {
      plan = JSON.parse(stdout);
    } catch {
      plan = null;
    }
  }

  return { stdout, status, plan, calls };
}

/** A committed override, so a test can set policy the bundled config does not. */
const override = (config) => ({
  [`GET repos/${REPO}/contents/.github/ruleset-config.json`]: file(JSON.stringify(config)),
});

const MINIMAL = {
  baseline: { rulesetName: "Pull Request Compulsion", includeDefaultBranch: true, requirePullRequest: true },
  environments: { dev: {} },
  branchNaming: {
    rulesetName: "Enforce Branch Nomenclature",
    allowedPrefixes: ["feature"],
    requiredApprovals: 1,
    reviewerTeams: ["tehvault/reviewers"],
  },
  taskSync: { enabled: false },
};

// --- PR check workflows ---------------------------------------------------------------

const WITH_PR_CHECKS = {
  ...MINIMAL,
  environments: { dev: {}, prod: {} },
  taskSync: { enabled: true, provider: "clickup" },
  prChecks: { scopeCheck: { enabled: true }, prAgent: { enabled: true } },
};

test("all three PR-check files are planned, and the scope check targets every environment", () => {
  const { plan } = run({ ...baseFixture(), ...override(WITH_PR_CHECKS) });

  assert.deepEqual(plan.prChecks.files.map((f) => f.path), [
    ".github/workflows/pr-scope-check.yml",
    ".github/scripts/scope-check.mjs",
    ".github/workflows/pr-agent.yml",
  ]);
  assert.ok(plan.prChecks.files.every((f) => f.action === "create"));
  assert.deepEqual(plan.prChecks.blocked, []);
});

test("switching the tracker to Jira rewrites the scope check's credentials", () => {
  const { calls } = run(
    {
      ...baseFixture(),
      ...override({ ...WITH_PR_CHECKS, taskSync: { enabled: true, provider: "jira" } }),
      [`GET repos/${REPO}/branches?per_page=100&page=1`]: [
        { name: "main" },
        { name: "dev" },
        { name: "prod" },
      ],
      [`PUT repos/${REPO}/contents/.github/workflows/pr-scope-check.yml`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/scripts/scope-check.mjs`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/workflows/pr-agent.yml`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/workflows/jira-sync.yml`]: { content: {} },
      [`POST repos/${REPO}/rulesets`]: { id: 1 },
    },
    ["--apply"],
  );

  const write = calls.find((c) => c.path?.endsWith("pr-scope-check.yml") && c.method === "PUT");
  assert.ok(write, "the scope check is written");
  const yaml = Buffer.from(write.body.content, "base64").toString("utf8");
  assert.match(yaml, /ISSUE_PROVIDER: "jira"/);
  assert.match(yaml, /JIRA_API_TOKEN/);
  assert.doesNotMatch(yaml, /CLICKUP_TOKEN/, "a Jira repo never gets ClickUp credentials");
});

test("applying writes the workflow and its script together", () => {
  const { calls, stdout } = run(
    {
      ...baseFixture(),
      ...override(WITH_PR_CHECKS),
      [`GET repos/${REPO}/branches?per_page=100&page=1`]: [
        { name: "main" },
        { name: "dev" },
        { name: "prod" },
      ],
      [`PUT repos/${REPO}/contents/.github/workflows/pr-scope-check.yml`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/scripts/scope-check.mjs`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/workflows/pr-agent.yml`]: { content: {} },
      [`PUT repos/${REPO}/contents/.github/workflows/clickup-sync.yml`]: { content: {} },
      [`POST repos/${REPO}/rulesets`]: { id: 1 },
    },
    ["--apply"],
  );

  const written = calls.filter((c) => c.method === "PUT" && c.path?.includes("/contents/")).map((c) => c.path);
  assert.ok(written.some((p) => p.endsWith("pr-scope-check.yml")));
  assert.ok(written.some((p) => p.endsWith("scope-check.mjs")), "the script the workflow runs is written too");
  assert.ok(written.some((p) => p.endsWith("pr-agent.yml")));
  assert.match(stdout, /created \.github\/workflows\/pr-scope-check\.yml/);
});

test("with the tracker off, the scope check is blocked but PR-Agent still lands", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override({ ...WITH_PR_CHECKS, taskSync: { enabled: false } }),
  });

  assert.deepEqual(plan.prChecks.files.map((f) => f.path), [".github/workflows/pr-agent.yml"]);
  assert.equal(plan.prChecks.blocked.length, 1);
  assert.match(plan.prChecks.blocked[0].reason, /taskSync is off/);
});

test("turning the checks off removes the files the plugin generated", () => {
  const generated = (body) => file(`# Generated by engineering-ruleset-plugin\n${body}`);
  const { plan } = run({
    ...baseFixture(),
    ...override({ ...WITH_PR_CHECKS, prChecks: { scopeCheck: { enabled: false }, prAgent: { enabled: false } } }),
    [`GET repos/${REPO}/contents/.github/workflows/pr-agent.yml`]: generated("name: PR Agent Review\n"),
  });

  assert.deepEqual(plan.prChecks.removed, [".github/workflows/pr-agent.yml"]);
});

test("a hand-written workflow at a managed path is never removed", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override({ ...WITH_PR_CHECKS, prChecks: { scopeCheck: { enabled: false }, prAgent: { enabled: false } } }),
    [`GET repos/${REPO}/contents/.github/workflows/pr-agent.yml`]: file("name: mine\non: push\n"),
  });

  assert.deepEqual(plan.prChecks.removed, [], "the plugin never deletes what it did not write");
});

test("replacing a hand-written workflow is called out before it happens", () => {
  const { stdout } = run(
    {
      ...baseFixture(),
      ...override(WITH_PR_CHECKS),
      [`GET repos/${REPO}/contents/.github/workflows/pr-agent.yml`]: file("name: mine\non: push\n"),
    },
    [],
  );

  assert.match(stdout, /already exists and was NOT written by this plugin/);
  assert.match(stdout, /applying REPLACES it/);
});

// --- a status check needs a secret this plugin does not generate the workflow for ----

const WITH_SCOPE_CHECK_SECRET = {
  ...MINIMAL,
  environments: { dev: { statusChecks: ["scope-check"], statusCheckSecrets: ["OPENROUTER_API_KEY"] } },
};

test("a missing status-check secret is reported in --json, non-interactively", () => {
  const { plan } = run({ ...baseFixture(), ...override(WITH_SCOPE_CHECK_SECRET) });
  assert.deepEqual(plan.missingStatusCheckSecrets, ["OPENROUTER_API_KEY"]);
});

test("an already-set status-check secret is not reported as missing", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override(WITH_SCOPE_CHECK_SECRET),
    [`GET repos/${REPO}/actions/secrets/OPENROUTER_API_KEY`]: { name: "OPENROUTER_API_KEY" },
  });
  assert.deepEqual(plan.missingStatusCheckSecrets, []);
});

test("with no statusCheckSecrets configured, nothing is reported and no extra call is made", () => {
  const { plan, calls } = run({ ...baseFixture(), ...override(MINIMAL) });
  assert.deepEqual(plan.missingStatusCheckSecrets, []);
  assert.ok(!calls.some((c) => c.path?.includes("actions/secrets/")), "no secret lookup without a name to check");
});

test("the human-readable plan tells you exactly how to set it yourself", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_SCOPE_CHECK_SECRET) }, []);
  assert.match(stdout, /The 'OPENROUTER_API_KEY' secret is required for a configured status check/);
  assert.match(stdout, new RegExp(`gh secret set OPENROUTER_API_KEY --repo ${REPO}`));
  assert.match(stdout, /openrouter\.ai/);
});

// This harness never provides a real TTY, so the interactive offer (which
// only fires under isInteractive()) must never engage here — proving the
// non-interactive path stays inert is as important as proving the fallback
// message appears, since a hang on a piped stdin is the failure mode the
// whole isInteractive() guard exists to prevent.
test("no interactive attempt is made, and no secret is written, over a pipe", () => {
  const { calls } = run({ ...baseFixture(), ...override(WITH_SCOPE_CHECK_SECRET) }, ["--apply"]);
  assert.ok(!calls.some((c) => c.secretSet), "gh secret set is never invoked without a terminal");
});

// --- a live ruleset already covers more than the task-sync pipeline does -------------

const WITH_SYNC = { ...MINIMAL, taskSync: { enabled: true, provider: "clickup" } };

/**
 * Reproduces the pr-guardrails situation directly: `Pull Request Compulsion`
 * is already live on GitHub covering `dev` AND `test`, but the config this run
 * is using only declares `dev`. Nothing here writes the extra secret/variable
 * lookups task-sync also makes — they 404 by default, which hasSecret/getFile
 * already treat as "absent" rather than an error.
 */
const EXISTING_BASELINE = {
  id: 1,
  name: "Pull Request Compulsion",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/dev", "refs/heads/test"], exclude: [] },
  },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
};

function driftFixture(config) {
  return {
    ...baseFixture({ rulesets: [{ id: 1, name: "Pull Request Compulsion" }] }),
    ...override(config),
    [`GET repos/${REPO}/rulesets/1`]: EXISTING_BASELINE,
  };
}

test("a ruleset that already covers more than the config declares also warns about task sync", () => {
  const { stdout } = run(driftFixture(WITH_SYNC), []);

  assert.match(stdout, /no longer covers test — those refs lose this ruleset's protection;/);
  assert.match(stdout, /it also means ClickUp sync will not fire for test/);
  assert.match(stdout, /add it back to "environments" if that is not intended/);
});

test("the same drift with task sync disabled gets the scope warning but not the sync one", () => {
  const { stdout } = run(driftFixture(MINIMAL), []);

  assert.match(stdout, /no longer covers test — those refs lose this ruleset's protection\]/);
  assert.doesNotMatch(stdout, /it also means/, "task sync is off, so there is no sync line to lose");
});

test("no false positive: a scope this config already matches prints no drift warning", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_SYNC) }, []);
  assert.doesNotMatch(stdout, /no longer covers/);
  assert.doesNotMatch(stdout, /it also means/);
});

// --- no GitHub credentials at all ----------------------------------------------------

/**
 * The stdin this harness gives the CLI is a pipe, never a real terminal — the
 * same condition as running under the Claude Code slash command. With no gh
 * auth and no token, the CLI must refuse immediately with the exact command
 * to run, and must NEVER attempt the interactive `gh auth login` hand-off:
 * that flow asks questions a pipe cannot answer, so trying it here would hang
 * (caught by run()'s timeout) rather than exit cleanly.
 */
test("with no gh auth and no token, a non-interactive run refuses without hanging", () => {
  const { stdout, status } = run({ ...baseFixture(), ...override(MINIMAL) }, [], {
    FAKE_GH_UNAUTHENTICATED: "1",
  });

  assert.equal(status, 1);
  assert.match(stdout, /No GitHub credentials\. Run this yourself, in your own terminal:/);
  assert.match(stdout, /gh auth login/);
  assert.match(stdout, /GITHUB_TOKEN/);
});

test("the same refusal applies to --json, rather than emitting unparseable output", () => {
  const { stdout, status, plan } = run({ ...baseFixture(), ...override(MINIMAL) }, ["--json"], {
    FAKE_GH_UNAUTHENTICATED: "1",
  });

  assert.equal(status, 1);
  assert.equal(plan, null, "no JSON was printed to parse");
  assert.match(stdout, /No GitHub credentials/);
});

// A GITHUB_TOKEN alone (no gh auth) is a real-network path — requestViaToken
// hits api.github.com directly, which this offline suite deliberately never
// does (see the `GITHUB_TOKEN: ""` comment in run()'s default env above) — so
// that combination is exercised by the unit-level hasGitHubCredentials logic
// and the noCredentialsMessage/loginInteractive tests in tests/secrets.test.js
// instead of here.

// --- a missing team is created from CODEOWNERS -------------------------------------

test("a missing reviewer team is seeded from the repository's code owners", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override(MINIMAL),
    [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("*  @alice\n/api/  @tehvault/backend\n"),
    "GET orgs/tehvault/teams/backend/members?per_page=100&page=1": [{ login: "bob" }],
  });

  assert.deepEqual(plan.teamsToCreate, ["tehvault/reviewers"]);
  assert.deepEqual(plan.teamSeed.members, ["alice", "bob"]);
  assert.equal(plan.teamSeed.codeowners, ".github/CODEOWNERS");
  assert.equal(plan.teamSeed.runnerAdded, false);
});

/**
 * The degradation this whole feature exists to remove: a team that cannot be
 * found used to strip `required_reviewers` out of the rule.
 */
test("the reviewer requirement survives instead of degrading", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override(MINIMAL),
    [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice @bob\n"),
  });

  assert.deepEqual(
    plan.degradations.filter((d) => d.dropped === "required_reviewers"),
    [],
    "no team drop is reported",
  );
  const rule = plan.steps
    .find((s) => s.name === "Enforce Branch Nomenclature")
    .payload.rules.find((r) => r.type === "pull_request");
  assert.equal(rule.parameters.required_reviewers.length, 1, "the team is bound into the rule");
});

test("with no CODEOWNERS the runner is still the fallback, exactly as before", () => {
  const { plan } = run({ ...baseFixture(), ...override(MINIMAL) });

  assert.deepEqual(plan.teamsToCreate, ["tehvault/reviewers"]);
  assert.deepEqual(plan.teamSeed.members, ["runner"]);
  assert.equal(plan.teamSeed.runnerAdded, true);
});

// --- an existing but empty team ------------------------------------------------------

test("a team that exists with nobody in it is filled rather than left blocking", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override(MINIMAL),
    "GET orgs/tehvault/teams/reviewers": { id: 7, slug: "reviewers", members_count: 0 },
    [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice\n"),
  });

  assert.deepEqual(plan.teamsToCreate, [], "it already exists");
  assert.deepEqual(plan.teamsToFill, ["tehvault/reviewers"]);
  assert.deepEqual(plan.teamSeed.members, ["alice"]);
  assert.deepEqual(
    plan.degradations.filter((d) => d.dropped === "required_reviewers"),
    [],
    "'team has no members' no longer drops the rule",
  );
});

test("a team that already has members is left completely alone", () => {
  const { plan, calls } = run({
    ...baseFixture(),
    ...override(MINIMAL),
    "GET orgs/tehvault/teams/reviewers": { id: 7, slug: "reviewers", members_count: 3 },
  });

  assert.deepEqual(plan.teamsToCreate, []);
  assert.deepEqual(plan.teamsToFill, []);
  assert.ok(!calls.some((c) => c.path.includes("/memberships/")), "nobody is added to it");
});

// --- when nobody can be seeded --------------------------------------------------------

test("nobody eligible means the team is left alone, and the rule degrades loudly", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override({ ...MINIMAL, teamSeeding: { includeRunner: false } }),
    [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @carol\n"),
  });

  assert.deepEqual(plan.teamsToCreate, [], "an empty team would block every merge");
  assert.deepEqual(plan.teamSeed.unseedableTeams, ["tehvault/reviewers"]);
  assert.match(plan.teamSeed.skipped[0].reason, /no write access to tehvault\/app/);
  assert.ok(plan.degradations.some((d) => d.dropped === "required_reviewers"));
});

test("populateEmptyTeams: false leaves an empty team untouched", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override({ ...MINIMAL, teamSeeding: { populateEmptyTeams: false } }),
    "GET orgs/tehvault/teams/reviewers": { id: 7, slug: "reviewers", members_count: 0 },
    [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice\n"),
  });

  assert.deepEqual(plan.teamsToFill, []);
  assert.ok(
    plan.degradations.some((d) => /has no members/.test(d.reason)),
    "the old degradation is what you get back",
  );
});

// --- where no team can ever be bound -------------------------------------------------

/** A personal account has no teams at all, so the review used to vanish entirely. */
function personal(extra = {}) {
  return {
    ...baseFixture(),
    ...override(MINIMAL),
    [`GET repos/${REPO}`]: {
      owner: { type: "User", login: "tehvault" },
      default_branch: "main",
      visibility: "private",
      permissions: { admin: true },
    },
    ...extra,
  };
}

test("on a personal repo CODEOWNERS takes the review over from the team", () => {
  const { plan } = run(
    personal({ [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice @bob\n") }),
  );

  const rule = plan.steps
    .find((s) => s.name === "Enforce Branch Nomenclature")
    .payload.rules.find((r) => r.type === "pull_request");

  assert.equal(rule.parameters.require_code_owner_review, true);
  assert.equal(rule.parameters.required_approving_review_count, 1, "the count still stands too");
  assert.ok(plan.degradations.some((d) => d.substituted === "require_code_owner_review"));
  assert.equal(plan.codeownerReview.usable, true);
});

test("a personal repo whose CODEOWNERS cannot supply the review is told exactly why", () => {
  const { plan, stdout } = run(
    personal({ [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice\n") }),
    [],
  );

  assert.equal(plan, null);
  assert.match(stdout, /require_code_owner_review not substituted/);
  assert.match(stdout, /\* has a single owner who can push/);
  assert.match(stdout, /to enable it: give \* a second owner/);
});

test("no CODEOWNERS at all still degrades, and says which file would fix it", () => {
  const { stdout } = run(personal(), []);

  assert.match(stdout, /this repository has no CODEOWNERS file/);
  assert.match(stdout, /add \.github\/CODEOWNERS naming at least two owners/);
});

test("a bound team means CODEOWNERS is never even read", () => {
  const { calls, plan } = run({
    ...baseFixture(),
    ...override(MINIMAL),
    "GET orgs/tehvault/teams/reviewers": { id: 7, slug: "reviewers", members_count: 3 },
  });

  assert.ok(!calls.some((c) => c.path.includes("CODEOWNERS")));
  assert.equal(plan.codeownerReview, null);
});

// --- applying ---------------------------------------------------------------------------

test("applying creates the team and adds every seeded member", () => {
  const { stdout, calls } = run(
    {
      ...baseFixture(),
      ...override(MINIMAL),
      [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice @bob\n"),
      "POST orgs/tehvault/teams": { id: 42, slug: "reviewers" },
      "PUT orgs/tehvault/teams/reviewers/memberships/alice": { role: "member", state: "active" },
      "PUT orgs/tehvault/teams/reviewers/memberships/bob": { role: "member", state: "active" },
      [`POST repos/${REPO}/rulesets`]: { id: 1 },
    },
    ["--apply"],
  );

  const created = calls.find((c) => c.path === "orgs/tehvault/teams");
  assert.ok(created, "the team is created");
  assert.equal(created.body.name, "reviewers");

  assert.deepEqual(
    calls.filter((c) => c.path.includes("/memberships/")).map((c) => c.path),
    [
      "orgs/tehvault/teams/reviewers/memberships/alice",
      "orgs/tehvault/teams/reviewers/memberships/bob",
    ],
  );

  // The recompiled payload must carry the id the create just returned, or the
  // reviewer rule ships pointing at nothing.
  const nomenclature = calls.find(
    (c) => c.path === `repos/${REPO}/rulesets` && c.body?.name === "Enforce Branch Nomenclature",
  );
  assert.deepEqual(
    nomenclature.body.rules.find((r) => r.type === "pull_request").parameters.required_reviewers[0].reviewer,
    { id: 42, type: "Team" },
  );
  assert.match(stdout, /created team tehvault\/reviewers/);
  assert.match(stdout, /added @alice to tehvault\/reviewers/);
});

/** Filling an existing team must address it by the slug GitHub returned, not the config's. */
test("applying fills an existing empty team without recreating it", () => {
  const { stdout, calls } = run(
    {
      ...baseFixture(),
      ...override(MINIMAL),
      "GET orgs/tehvault/teams/reviewers": { id: 7, slug: "reviewers", members_count: 0 },
      [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice\n"),
      "PUT orgs/tehvault/teams/reviewers/memberships/alice": { role: "member", state: "active" },
      [`POST repos/${REPO}/rulesets`]: { id: 1 },
    },
    ["--apply"],
  );

  assert.ok(!calls.some((c) => c.method === "POST" && c.path === "orgs/tehvault/teams"), "not recreated");
  assert.ok(calls.some((c) => c.path === "orgs/tehvault/teams/reviewers/memberships/alice"));
  assert.match(stdout, /added @alice to tehvault\/reviewers/);

  const nomenclature = calls.find(
    (c) => c.path === `repos/${REPO}/rulesets` && c.body?.name === "Enforce Branch Nomenclature",
  );
  assert.deepEqual(
    nomenclature.body.rules.find((r) => r.type === "pull_request").parameters.required_reviewers[0].reviewer,
    { id: 7, type: "Team" },
  );
});

/**
 * Every membership bouncing leaves the team empty, which is the one state that
 * must never be bound into a rule — it blocks every merge forever.
 */
test("a team whose members all fail to join is not bound into the rule", () => {
  const { stdout, calls, status } = run(
    {
      ...baseFixture(),
      ...override(MINIMAL),
      [`GET repos/${REPO}/contents/.github/CODEOWNERS`]: file("* @alice\n"),
      "POST orgs/tehvault/teams": { id: 42, slug: "reviewers" },
      "PUT orgs/tehvault/teams/reviewers/memberships/alice": { __status: 403, __message: "Forbidden" },
      [`POST repos/${REPO}/rulesets`]: { id: 1 },
    },
    ["--apply"],
  );

  const nomenclature = calls.find(
    (c) => c.path === `repos/${REPO}/rulesets` && c.body?.name === "Enforce Branch Nomenclature",
  );
  assert.equal(
    nomenclature.body.rules.find((r) => r.type === "pull_request").parameters.required_reviewers,
    undefined,
    "the rule is written without a team it cannot use",
  );
  assert.match(stdout, /has no members, so it cannot supply the review it gates/);
  assert.equal(status, 1, "a membership that did not land is a partial failure, not a clean run");
});

// --- every credential the chosen provider needs, surfaced at once ----------------

/**
 * Picking a tracker turns on more than the tracker: the scope check reads the
 * ticket from it, and both PR checks call an AI provider. All of those secrets
 * are required from that moment, so all of them are reported together — the AI
 * key used to be reachable only via a `statusCheckSecrets` entry, which meant a
 * repo could adopt PR-Agent and never be told what it needs to run.
 */
test("choosing a provider reports the AI key as well as the tracker token", () => {
  const { plan } = run({ ...baseFixture(), ...override(WITH_PR_CHECKS) });

  assert.deepEqual(plan.missingStatusCheckSecrets, ["OPENROUTER_API_KEY"]);
  assert.equal(plan.taskSync.hasToken, false, "the tracker token has its own field");
});

test("the tracker's own credentials are not also listed as check secrets", () => {
  const { plan } = run({ ...baseFixture(), ...override(WITH_PR_CHECKS) });

  assert.ok(
    !plan.missingStatusCheckSecrets.includes("CLICKUP_TOKEN"),
    "reported once, via taskSync.hasToken — not twice",
  );
});

test("Jira's variables are reported as variables, and only by the tracker", () => {
  const jira = { ...WITH_PR_CHECKS, taskSync: { enabled: true, provider: "jira" } };
  const { plan } = run({ ...baseFixture(), ...override(jira) });

  assert.deepEqual(plan.taskSync.missingVariables, ["JIRA_BASE_URL", "JIRA_EMAIL"]);
  assert.deepEqual(plan.missingCheckVariables, [], "not repeated under the checks");
  assert.ok(!plan.missingStatusCheckSecrets.includes("JIRA_API_TOKEN"));
});

test("an AI key already set is not reported as missing", () => {
  const { plan } = run({
    ...baseFixture(),
    ...override(WITH_PR_CHECKS),
    [`GET repos/${REPO}/actions/secrets/OPENROUTER_API_KEY`]: { name: "OPENROUTER_API_KEY" },
  });
  assert.deepEqual(plan.missingStatusCheckSecrets, []);
});

test("the plan prints the command for a secret a generated check needs", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_PR_CHECKS) }, []);

  assert.match(stdout, /The 'OPENROUTER_API_KEY' secret is required by a pull-request check/);
  assert.match(stdout, new RegExp(`gh secret set OPENROUTER_API_KEY --repo ${REPO}`));
});

/**
 * A secret wanted by a required status check AND by a generated workflow takes
 * the status check's wording: that is the stronger claim, since a required check
 * that cannot run blocks merges rather than merely skipping a review.
 */
test("a status check's wording wins when two things need one secret", () => {
  const both = {
    ...WITH_PR_CHECKS,
    baseline: { ...WITH_PR_CHECKS.baseline, statusCheckSecrets: ["OPENROUTER_API_KEY"] },
  };
  const { stdout } = run({ ...baseFixture(), ...override(both) }, []);

  assert.match(stdout, /The 'OPENROUTER_API_KEY' secret is required for a configured status check/);
});

// --- the scope check follows the environments ------------------------------------

test("a baseline status check is required on every environment, added ones included", () => {
  const withBaselineCheck = {
    ...WITH_PR_CHECKS,
    baseline: { ...WITH_PR_CHECKS.baseline, statusChecks: ["scope-check"], statusCheckRuleset: "PR-SCOPE-CHECK" },
  };
  const { plan } = run({ ...baseFixture(), ...override(withBaselineCheck) });
  const scope = plan.steps.find((s) => s.name === "PR-SCOPE-CHECK");

  assert.deepEqual(scope.payload.conditions.ref_name.include, ["refs/heads/dev", "refs/heads/prod"]);
  // The workflow that reports it triggers on the same list, from the same source.
  const workflow = plan.prChecks.files.find((f) => f.path.endsWith("pr-scope-check.yml"));
  assert.equal(workflow.action, "create");
});

/**
 * With no tracker the scope-check workflow cannot be generated, so requiring
 * `scope-check` would block every merge into every environment on a check
 * nothing reports. The requirement is dropped and said out loud instead.
 */
test("a required scope check with no tracker to read is dropped, not left blocking", () => {
  const noTracker = {
    ...WITH_PR_CHECKS,
    taskSync: { enabled: false },
    baseline: { ...WITH_PR_CHECKS.baseline, statusChecks: ["scope-check"], statusCheckRuleset: "PR-SCOPE-CHECK" },
  };
  const { plan, stdout } = run({ ...baseFixture(), ...override(noTracker) });

  assert.equal(plan.steps.find((s) => s.name === "PR-SCOPE-CHECK"), undefined);
  assert.ok(
    plan.degradations.some((d) => d.dropped === "required_status_checks" && d.check === "scope-check"),
  );
  assert.match(plan.prChecks.blocked[0].reason, /taskSync is off/);

  const { stdout: human } = run({ ...baseFixture(), ...override(noTracker) }, []);
  assert.match(human, /SKIPPED\s+PR-SCOPE-CHECK/);
  assert.ok(stdout.length > 0);
});

// --- the push stage in the plan --------------------------------------------------

const WITH_PUSH_SYNC = {
  ...MINIMAL,
  taskSync: {
    enabled: true,
    provider: "clickup",
    branchPushStatus: "in progress",
    environmentStatuses: { dev: "dev" },
  },
};

test("the push stage is planned at rank 1, ahead of every environment", () => {
  const { plan } = run({ ...baseFixture(), ...override(WITH_PUSH_SYNC) });

  assert.deepEqual(plan.taskSync.push, {
    status: "in progress",
    rank: 1,
    prefixes: ["feature"],
  });
  assert.deepEqual(plan.taskSync.pipeline, [{ env: "dev", status: "dev", rank: 2 }]);
});

test("the plan prints the push stage before the merge stages", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_PUSH_SYNC) }, []);

  const push = stdout.indexOf("push feature/** → 'in progress'");
  const merge = stdout.indexOf("merge into dev → 'dev'");
  assert.ok(push > -1, "the push stage is shown");
  assert.ok(merge > push, "and it is shown first, being rank 1");
});

test("a push stage with nothing to match is reported in the plan", () => {
  const blocked = { ...WITH_PUSH_SYNC, branchNaming: { ...MINIMAL.branchNaming, allowedPrefixes: [] } };
  const { plan, stdout } = run({ ...baseFixture(), ...override(blocked) }, []);

  assert.equal(plan, null, "human output, not --json");
  assert.match(stdout, /no push stage: branchNaming\.allowedPrefixes is empty/);
});

// --- credentials: a link you can open, not a settings tree to navigate ----------

/**
 * The point of these assertions is the URL. A hint like "Settings → Apps → API
 * Token" makes the reader hunt; a link means whoever holds the account can open
 * one thing and generate the token there. Pinned so they cannot regress to prose.
 */
test("the plan links straight to ClickUp's token page", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_SYNC) }, []);
  assert.match(stdout, /https:\/\/app\.clickup\.com\/settings\/apps/);
  assert.match(stdout, /starts 'pk_'/, "and says what a real value looks like");
});

test("the plan links straight to Atlassian's API-token page", () => {
  const jira = { ...MINIMAL, taskSync: { enabled: true, provider: "jira" } };
  const { stdout } = run({ ...baseFixture(), ...override(jira) }, []);
  assert.match(stdout, /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
  assert.match(stdout, /starts 'ATATT'/);
});

test("the plan links straight to OpenRouter's key page", () => {
  const { stdout } = run({ ...baseFixture(), ...override(WITH_PR_CHECKS) }, []);
  assert.match(stdout, /https:\/\/openrouter\.ai\/keys/);
  assert.match(stdout, /starts 'sk-or-'/);
});

/**
 * Jira's two variables are not secrets, so there is no hidden prompt for them —
 * which makes "where do I find this value" the only useful thing the plan can
 * say. One command each, not a NAME placeholder shared between them.
 */
test("each missing Jira variable gets its own command and its own source", () => {
  const jira = { ...MINIMAL, taskSync: { enabled: true, provider: "jira" } };
  const { stdout } = run({ ...baseFixture(), ...override(jira) }, []);

  assert.match(stdout, new RegExp(`gh variable set JIRA_BASE_URL --repo ${REPO}`));
  assert.match(stdout, new RegExp(`gh variable set JIRA_EMAIL --repo ${REPO}`));
  assert.doesNotMatch(stdout, /gh variable set NAME/, "no placeholder to decode");
  assert.match(stdout, /copy it from the browser bar/, "where JIRA_BASE_URL comes from");
  assert.match(stdout, /profile-and-visibility/, "where JIRA_EMAIL comes from");
});

test("a token following --set-token is refused with the revoke links", () => {
  const { stdout, status } = run({ ...baseFixture() }, ["--set-token", "pk_12345678abcdef"]);
  assert.equal(status, 1);
  assert.match(stdout, /--set-token takes no value/);
  assert.match(stdout, /https:\/\/app\.clickup\.com\/settings\/apps/);
  assert.match(stdout, /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
  assert.doesNotMatch(stdout, /pk_12345678abcdef/, "the value itself is never echoed back in full");
});

test("a bare token anywhere in argv is refused with the same links", () => {
  const { stdout, status } = run({ ...baseFixture() }, ["ATATT3xFfGF0abcdef"]);
  assert.equal(status, 1);
  assert.match(stdout, /looks like an API token/);
  assert.match(stdout, /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/);
  assert.doesNotMatch(stdout, /ATATT3xFfGF0abcdef/, "never echoed back in full");
});
