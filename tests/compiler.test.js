import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, referencedTeams } from "../src/compiler.js";

const CANONICAL = JSON.parse(
  readFileSync(fileURLToPath(new URL("../ruleset-config.json", import.meta.url)), "utf8"),
);

/** shop-ui: a repo owned by a user account, so team rules cannot apply. */
const PERSONAL = { ownerType: "User", ownerLogin: "akshayahujaa", defaultBranch: "main" };

/** The same policy on a tehvault org repo, where the team does resolve. */
const ORG = {
  ownerType: "Organization",
  ownerLogin: "tehvault",
  defaultBranch: "main",
  teamIds: { "tehvault/reviewers": 18199891 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const byName = (rulesets, name) => rulesets.find((r) => r.name === name);

test("canonical config generates exactly the four original rulesets", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  assert.deepEqual(rulesets.map((r) => r.name), [
    "Pull Request Compulsion",
    "PR-SCOPE-CHECK",
    "team-only-reviewer",
    "Enforce Branch Nomenclature",
  ]);
});

test("baseline covers the default branch and every environment", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const baseline = byName(rulesets, "Pull Request Compulsion");

  assert.deepEqual(baseline.conditions.ref_name.include, [
    "~DEFAULT_BRANCH",
    "refs/heads/dev",
    "refs/heads/test",
    "refs/heads/prod",
  ]);
  assert.ok(baseline.rules.some((r) => r.type === "deletion"));
  assert.ok(baseline.rules.some((r) => r.type === "non_fast_forward"));
  assert.equal(
    baseline.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count,
    0,
  );
});

test("dev's status check becomes its own ruleset scoped to dev", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const scope = byName(rulesets, "PR-SCOPE-CHECK");

  assert.deepEqual(scope.conditions.ref_name.include, ["refs/heads/dev"]);
  assert.deepEqual(
    scope.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks,
    [{ context: "pr-scope/check" }],
  );
});

test("requiring a task id narrows each prefix to id-bearing branches", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const naming = byName(rulesets, "Enforce Branch Nomenclature");

  assert.deepEqual(naming.conditions.ref_name.include, ["~ALL"]);
  // Excluded refs are the permitted ones; a bare `feature/**/*` would let a
  // branch through with no task to advance on merge.
  assert.deepEqual(naming.conditions.ref_name.exclude, [
    "refs/heads/dev",
    "refs/heads/test",
    "refs/heads/prod",
    "refs/heads/main",
    "refs/heads/feature/CU-*",
    "refs/heads/feature/CU-*/**",
    "refs/heads/bugfix/CU-*",
    "refs/heads/bugfix/CU-*/**",
    "refs/heads/hotfix/CU-*",
    "refs/heads/hotfix/CU-*/**",
    "refs/heads/docs/CU-*",
    "refs/heads/docs/CU-*/**",
    "refs/heads/chore/CU-*",
    "refs/heads/chore/CU-*/**",
  ]);
  assert.ok(naming.rules.some((r) => r.type === "creation"), "creation rule is what blocks bad names");
});

// --- environment flexibility -------------------------------------------------

test("a bare new environment extends the existing rulesets and creates none", () => {
  const config = clone(CANONICAL);
  config.environments.staging = {};

  const { rulesets } = compile(config, PERSONAL);

  assert.deepEqual(
    rulesets.map((r) => r.name),
    ["Pull Request Compulsion", "PR-SCOPE-CHECK", "team-only-reviewer", "Enforce Branch Nomenclature"],
    "no new ruleset appears",
  );
  assert.ok(
    byName(rulesets, "Pull Request Compulsion").conditions.ref_name.include.includes("refs/heads/staging"),
    "staging requires a PR",
  );
  assert.ok(
    byName(rulesets, "Enforce Branch Nomenclature").conditions.ref_name.exclude.includes("refs/heads/staging"),
    "staging is not treated as a badly-named branch",
  );
});

test("a new environment with its own status check generates a derived ruleset", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { statusChecks: ["e2e/smoke"] };

  const { rulesets } = compile(config, PERSONAL);
  const derived = byName(rulesets, "status-checks-staging");

  assert.ok(derived, "derived name avoids colliding with PR-SCOPE-CHECK");
  assert.deepEqual(derived.conditions.ref_name.include, ["refs/heads/staging"]);
});

test("a new environment demanding approvals generates its own reviewer ruleset", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { requiredApprovals: 2 };

  const { rulesets } = compile(config, PERSONAL);
  const derived = byName(rulesets, "reviewers-staging");

  assert.equal(
    derived.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count,
    2,
  );
});

test("two environments given the same ruleset name fail loudly", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { statusChecks: ["e2e/smoke"], statusCheckRuleset: "PR-SCOPE-CHECK" };

  assert.throws(() => compile(config, PERSONAL), /two rulesets named 'PR-SCOPE-CHECK'/);
});

// --- degradation -------------------------------------------------------------

test("a user-owned repo drops the team requirement but keeps the approval count", () => {
  const { rulesets, degradations } = compile(CANONICAL, PERSONAL);
  const prod = byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request");

  assert.equal(prod.parameters.required_approving_review_count, 1, "approval survives");
  assert.equal(prod.parameters.required_reviewers, undefined, "team requirement is dropped");
  assert.ok(
    degradations.some((d) => d.ruleset === "team-only-reviewer" && d.dropped === "required_reviewers"),
    "the drop is reported, not silent",
  );
});

test("the owning org keeps the team requirement with a resolved id", () => {
  const { rulesets, degradations } = compile(CANONICAL, ORG);
  const prod = byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request");

  assert.deepEqual(prod.parameters.required_reviewers, [
    { minimum_approvals: 1, file_patterns: ["*"], reviewer: { id: 18199891, type: "Team" } },
  ]);
  assert.equal(degradations.length, 0);
});

test("an org repo naming another org's team degrades", () => {
  const { degradations } = compile(CANONICAL, { ...ORG, ownerLogin: "someone-else" });
  assert.ok(degradations.every((d) => /does not belong to org/.test(d.reason)));
});

// --- payload hygiene ---------------------------------------------------------

test("payloads carry no response-only fields", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const forbidden = ["id", "source", "source_type", "created_at", "updated_at", "node_id", "_links"];

  for (const ruleset of rulesets) {
    for (const field of forbidden) {
      assert.equal(ruleset[field], undefined, `${ruleset.name} must not send '${field}'`);
    }
    assert.deepEqual(ruleset.bypass_actors, [], "no bypass actors: rules bind everyone");
    assert.equal(ruleset.enforcement, "active");
    assert.equal(ruleset.target, "branch");
  }
});

test("referencedTeams collects every team the config mentions, deduped", () => {
  assert.deepEqual(referencedTeams(CANONICAL), ["tehvault/reviewers"]);
});

/**
 * Regression: GitHub rejects a pull_request rule carrying only the approval
 * count with "Invalid property /rules/N: data matches no possible input".
 * Verified against the live API — the count alone and count plus merge methods
 * both 422; the count plus all four booleans is accepted.
 */
test("every pull_request rule carries all four review booleans", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const required = [
    "required_approving_review_count",
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_review_thread_resolution",
  ];

  const pullRequestRules = rulesets.flatMap((r) =>
    r.rules.filter((rule) => rule.type === "pull_request").map((rule) => [r.name, rule]),
  );
  assert.ok(pullRequestRules.length >= 3, "the canonical config has several pull_request rules");

  for (const [rulesetName, rule] of pullRequestRules) {
    for (const field of required) {
      assert.notEqual(rule.parameters[field], undefined, `${rulesetName} is missing '${field}'`);
    }
  }
});

test("review booleans are configurable per scope", () => {
  const config = clone(CANONICAL);
  config.branchNaming.review = { requireCodeOwnerReview: true, requireLastPushApproval: true };

  const { rulesets } = compile(config, PERSONAL);
  const params = byName(rulesets, "Enforce Branch Nomenclature").rules.find(
    (r) => r.type === "pull_request",
  ).parameters;

  assert.equal(params.require_code_owner_review, true);
  assert.equal(params.require_last_push_approval, true);
  assert.equal(params.dismiss_stale_reviews_on_push, false, "unset options stay off");
});

test("without requireTaskId a prefix still permits any branch below it", () => {
  const relaxed = {
    ...CANONICAL,
    branchNaming: { ...CANONICAL.branchNaming, requireTaskId: false },
  };
  const naming = byName(compile(relaxed, PERSONAL).rulesets, "Enforce Branch Nomenclature");

  assert.ok(naming.conditions.ref_name.exclude.includes("refs/heads/feature/**/*"));
  assert.ok(!naming.conditions.ref_name.exclude.some((p) => p.includes("CU-")));
});

test("the task id prefix used by nomenclature is configurable", () => {
  const custom = {
    ...CANONICAL,
    branchNaming: { ...CANONICAL.branchNaming, taskIdPrefix: "TASK-" },
  };
  const naming = byName(compile(custom, PERSONAL).rulesets, "Enforce Branch Nomenclature");

  assert.ok(naming.conditions.ref_name.exclude.includes("refs/heads/feature/TASK-*"));
});
