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
