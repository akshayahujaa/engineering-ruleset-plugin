import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compile,
  referencedTeams,
  addEnvironments,
  knownEnvironments,
  approvalsAvailable,
  assertTeamSlugs,
  assertEnvironmentNames,
  requiredStatusCheckSecrets,
} from "../src/compiler.js";

const CANONICAL = JSON.parse(
  readFileSync(fileURLToPath(new URL("../ruleset-config.json", import.meta.url)), "utf8"),
);

/**
 * A repo owned by a user account, so team rules cannot apply — but with enough
 * collaborators that a plain approval count is still satisfiable.
 */
const PERSONAL = {
  ownerType: "User",
  ownerLogin: "akshayahujaa",
  viewerLogin: "akshayahujaa",
  defaultBranch: "main",
  reviewCapacity: 3,
};

/** The same, but the owner is the only person who can push — the solo case. */
const SOLO = { ...PERSONAL, reviewCapacity: 1 };

/** A tehvault org repo, where the team resolves. */
const ORG = {
  ownerType: "Organization",
  ownerLogin: "tehvault",
  viewerLogin: "akshayahujaa",
  defaultBranch: "main",
  teamIds: { "tehvault/reviewers": 18199891 },
  reviewCapacity: 5,
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const byName = (rulesets, name) => rulesets.find((r) => r.name === name);

/** The canonical config once prod has been added, which is where teams apply. */
function withProd(context = PERSONAL) {
  const config = clone(CANONICAL);
  addEnvironments(config, ["prod"]);
  return { config, ...compile(config, context) };
}

// --- dev-first defaults --------------------------------------------------------

test("the canonical config starts at dev only", () => {
  assert.deepEqual(Object.keys(CANONICAL.environments), ["dev"]);
  assert.deepEqual(knownEnvironments(CANONICAL), ["test", "prod"]);
});

test("a first sync generates every rule scoped to dev, and no reviewer ruleset", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  assert.deepEqual(rulesets.map((r) => r.name), [
    "Pull Request Compulsion",
    "PR-SCOPE-CHECK",
    "Enforce Branch Nomenclature",
  ]);
});

test("baseline covers the default branch and every declared environment", () => {
  const { rulesets } = compile(CANONICAL, PERSONAL);
  const baseline = byName(rulesets, "Pull Request Compulsion");

  assert.deepEqual(baseline.conditions.ref_name.include, ["~DEFAULT_BRANCH", "refs/heads/dev"]);
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
  // "scope-check" is the check-run name the pr-guardrails workflow actually
  // reports (its job id). The original "pr-scope/check" matched nothing, so
  // merges into dev would have blocked forever waiting for it.
  assert.deepEqual(
    scope.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks,
    [{ context: "scope-check" }],
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

// --- environment profiles ------------------------------------------------------

test("adding a known environment brings its profile, not a bare object", () => {
  const config = clone(CANONICAL);
  assert.deepEqual(addEnvironments(config, ["prod"]), ["prod"]);
  assert.equal(config.environments.prod.requiredApprovals, 1);
  assert.deepEqual(config.environments.prod.reviewerTeams, ["tehvault/reviewers"]);
  assert.equal(config.environments.prod.reviewerRuleset, "team-only-reviewer");
});

test("a profile is copied, so one repo's edits cannot leak into the next", () => {
  const config = clone(CANONICAL);
  addEnvironments(config, ["prod"]);
  config.environments.prod.requiredApprovals = 99;
  assert.equal(config.environmentProfiles.prod.requiredApprovals, 1, "the profile is untouched");
});

test("an unknown environment name is still added, plain", () => {
  const config = clone(CANONICAL);
  assert.deepEqual(addEnvironments(config, ["staging", "dev"]), ["staging"]);
  assert.deepEqual(config.environments.staging, {}, "a bare env still inherits the baseline");
});

test("adding prod later produces the same reviewer ruleset as declaring it up front", () => {
  const { rulesets } = withProd(ORG);
  const prod = byName(rulesets, "team-only-reviewer");

  assert.ok(prod, "the profile's reviewerRuleset name is honoured");
  assert.deepEqual(prod.conditions.ref_name.include, ["refs/heads/prod"]);
  assert.equal(
    prod.rules.find((r) => r.type === "pull_request").parameters.required_approving_review_count,
    1,
  );
});

test("an added environment flows into the baseline and nomenclature rulesets", () => {
  const config = clone(CANONICAL);
  addEnvironments(config, ["staging"]);
  const { rulesets } = compile(config, PERSONAL);

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

  const derived = byName(compile(config, PERSONAL).rulesets, "status-checks-staging");
  assert.ok(derived, "derived name avoids colliding with PR-SCOPE-CHECK");
  assert.deepEqual(derived.conditions.ref_name.include, ["refs/heads/staging"]);
});

test("a new environment demanding approvals generates its own reviewer ruleset", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { requiredApprovals: 2 };

  const derived = byName(compile(config, PERSONAL).rulesets, "reviewers-staging");
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

// --- degradation ---------------------------------------------------------------

test("a user-owned repo drops the team requirement but keeps a satisfiable approval count", () => {
  const { rulesets, degradations } = withProd(PERSONAL);
  const prod = byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request");

  assert.equal(prod.parameters.required_approving_review_count, 1, "approval survives");
  assert.equal(prod.parameters.required_reviewers, undefined, "team requirement is dropped");
  assert.ok(
    degradations.some((d) => d.ruleset === "team-only-reviewer" && d.dropped === "required_reviewers"),
    "the drop is reported, not silent",
  );
});

/**
 * The property that keeps a solo repo usable: GitHub forbids approving your own
 * pull request, so requiring one approval where only one person can push means
 * no merge can ever complete. Dropping it is the only non-bricking answer.
 */
test("a solo repo drops the approval count instead of bricking every merge", () => {
  const { rulesets, degradations } = withProd(SOLO);

  assert.equal(byName(rulesets, "team-only-reviewer"), undefined, "no reviewer ruleset is created");
  const dropped = degradations.find((d) => d.dropped === "required_approving_review_count");
  assert.ok(dropped, "the drop is reported");
  assert.match(dropped.reason, /approving your own pull request/);
  assert.match(dropped.remedy, /second collaborator/);
});

test("a solo repo still gets the baseline, nomenclature and status-check rules", () => {
  const { rulesets } = compile(CANONICAL, SOLO);
  assert.deepEqual(rulesets.map((r) => r.name), [
    "Pull Request Compulsion",
    "PR-SCOPE-CHECK",
    "Enforce Branch Nomenclature",
  ]);
  // Nomenclature asks for 1 approval; on a solo repo that must not survive, or
  // every feature branch merge would be blocked.
  assert.equal(
    byName(rulesets, "Enforce Branch Nomenclature").rules.find((r) => r.type === "pull_request").parameters
      .required_approving_review_count,
    0,
  );
});

test("an unreadable collaborator list is assumed satisfiable, never silently stripped", () => {
  const unknown = { ...PERSONAL, reviewCapacity: undefined };
  const { rulesets } = withProd(unknown);
  assert.equal(
    byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request").parameters
      .required_approving_review_count,
    1,
  );
});

test("the owning org keeps the team requirement with a resolved id", () => {
  const { rulesets, degradations } = withProd(ORG);
  const prod = byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request");

  assert.deepEqual(prod.parameters.required_reviewers, [
    { minimum_approvals: 1, file_patterns: ["*"], reviewer: { id: 18199891, type: "Team" } },
  ]);
  assert.equal(degradations.length, 0);
});

test("an org repo naming another org's team degrades", () => {
  const { degradations } = withProd({ ...ORG, ownerLogin: "someone-else", teamIds: {} });
  assert.ok(degradations.some((d) => /belongs to 'tehvault'/.test(d.reason)));
});

/**
 * "another org's team" and "a team that is not there" have different fixes —
 * one is a config mistake, the other is something the sync can offer to create
 * — so they must not share a message.
 */
test("a team missing from the owning org says so, rather than blaming the org name", () => {
  const { degradations } = withProd({ ...ORG, teamIds: {} });
  const dropped = degradations.find((d) => d.dropped === "required_reviewers");

  assert.match(dropped.reason, /could not be resolved in 'tehvault'/);
  assert.doesNotMatch(dropped.reason, /belongs to/);
});

/**
 * A team that does not exist yet is created during apply, so the compiler must
 * treat it as usable — otherwise the plan would show a degradation that the
 * apply immediately contradicts.
 */
test("a team pending creation counts as usable", () => {
  const pending = { ...ORG, teamIds: {}, pendingTeams: ["tehvault/reviewers"] };
  const { rulesets, degradations } = withProd(pending);

  assert.ok(byName(rulesets, "team-only-reviewer"), "the ruleset is planned");
  assert.equal(degradations.length, 0, "no drop is reported for a team about to exist");
});

test("an org team that is neither resolved nor pending degrades", () => {
  const { degradations } = withProd({ ...ORG, teamIds: {} });
  assert.ok(degradations.some((d) => d.dropped === "required_reviewers"));
});

// --- CODEOWNERS carrying a review no team could -----------------------------------

/** What the CLI hands the compiler once CODEOWNERS has been assessed. */
const USABLE = { usable: true, path: ".github/CODEOWNERS", owners: ["alice", "bob"], patterns: 2 };
const UNUSABLE = {
  usable: false,
  path: ".github/CODEOWNERS",
  reason: "/api/ has a single owner who can push",
  remedy: "give /api/ a second owner with write access",
};

const prodRule = (rulesets) =>
  byName(rulesets, "team-only-reviewer")?.rules.find((r) => r.type === "pull_request");

/**
 * A personal repo can never bind a team, so before this the reviewer rule fell
 * back to a bare approval count — anybody's approval would do. CODEOWNERS
 * needs no team, so it takes the gate over.
 */
test("a dropped team is replaced by code-owner review where CODEOWNERS can supply it", () => {
  const { rulesets, degradations } = withProd({ ...PERSONAL, codeownerReview: USABLE });

  assert.equal(prodRule(rulesets).parameters.require_code_owner_review, true);
  const note = degradations.find((d) => d.substituted === "require_code_owner_review");
  assert.match(note.reason, /\.github\/CODEOWNERS gates the review instead/);
  assert.match(note.reason, /2 owner\(s\) with write access/);
});

test("a team that did bind is left to do its job, with no code-owner review added", () => {
  const { rulesets, degradations } = withProd({ ...ORG, codeownerReview: USABLE });

  assert.equal(prodRule(rulesets).parameters.require_code_owner_review, false);
  assert.equal(degradations.length, 0);
});

test("CODEOWNERS that cannot supply the review says what is missing, and enables nothing", () => {
  const { rulesets, degradations } = withProd({ ...PERSONAL, codeownerReview: UNUSABLE });

  assert.equal(prodRule(rulesets).parameters.require_code_owner_review, false);
  const note = degradations.find((d) => d.unsubstituted === "require_code_owner_review");
  assert.match(note.reason, /single owner who can push/);
  assert.match(note.remedy, /second owner/);
});

/**
 * On a solo repo the approval count is already reduced to zero because nobody
 * but the author could approve — and nobody but the author could supply a code
 * owner review either. Substituting there would brick every merge.
 */
test("a solo repo gets no code-owner review, however good its CODEOWNERS is", () => {
  const { rulesets, degradations } = withProd({ ...SOLO, codeownerReview: USABLE });

  assert.equal(byName(rulesets, "team-only-reviewer"), undefined, "the ruleset is still not created");
  assert.equal(
    degradations.filter((d) => d.substituted || d.unsubstituted).length,
    0,
    "the count degradation already explains it; a second note would just be noise",
  );
});

test("a rule naming no team is never given code-owner review", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { requiredApprovals: 2 };
  const { rulesets } = compile(config, { ...PERSONAL, reviewCapacity: 5, codeownerReview: USABLE });

  assert.equal(
    byName(rulesets, "reviewers-staging").rules.find((r) => r.type === "pull_request").parameters
      .require_code_owner_review,
    false,
  );
});

test("an explicitly configured code-owner review is left alone, not re-reported", () => {
  const config = clone(CANONICAL);
  addEnvironments(config, ["prod"]);
  config.environments.prod.review = { requireCodeOwnerReview: true };
  const { rulesets, degradations } = compile(config, { ...PERSONAL, codeownerReview: UNUSABLE });

  assert.equal(prodRule(rulesets).parameters.require_code_owner_review, true, "the config wins");
  assert.equal(
    degradations.filter((d) => d.ruleset === "team-only-reviewer" && d.unsubstituted).length,
    0,
  );
});

/**
 * With no approvals and no team, code-owner review is the only thing left
 * holding the ruleset up — so it has to count as survival, or the ruleset it
 * belongs to would not be created at all.
 */
test("code-owner review alone keeps a reviewer ruleset alive", () => {
  const config = clone(CANONICAL);
  addEnvironments(config, ["prod"]);
  config.environments.prod.requiredApprovals = 0;
  config.environments.prod.review = { requireCodeOwnerReview: true };

  const { rulesets } = compile(config, PERSONAL);
  assert.ok(byName(rulesets, "team-only-reviewer"), "the ruleset still has a reason to exist");
});

// --- payload hygiene -----------------------------------------------------------

test("payloads carry no response-only fields", () => {
  const { rulesets } = withProd(ORG);
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

test("referencedTeams collects every team the ACTIVE config mentions, deduped", () => {
  assert.deepEqual(referencedTeams(CANONICAL), ["tehvault/reviewers"]);
});

/**
 * A profile is inert until its environment is added. Counting its team here
 * would make an org repo plan to create a reviewer team for an environment
 * nobody asked for — addEnvironments runs first, so an env added this run is
 * already in `environments` by the time teams are resolved.
 */
test("a team named only by an unused profile is not referenced", () => {
  const config = clone(CANONICAL);
  delete config.branchNaming.reviewerTeams;
  assert.deepEqual(referencedTeams(config), [], "prod's profile team is not pulled in");

  addEnvironments(config, ["prod"]);
  assert.deepEqual(referencedTeams(config), ["tehvault/reviewers"], "adding prod does reference it");
});

/**
 * Regression: GitHub rejects a pull_request rule carrying only the approval
 * count with "Invalid property /rules/N: data matches no possible input".
 * Verified against the live API — the count alone and count plus merge methods
 * both 422; the count plus all four booleans is accepted.
 */
test("every pull_request rule carries all four review booleans", () => {
  const { rulesets } = withProd(ORG);
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

  const params = byName(compile(config, PERSONAL).rulesets, "Enforce Branch Nomenclature").rules.find(
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

// --- satisfiability covers the TEAM requirement, not just the count ------------

/**
 * The blocker this whole check exists to prevent: zeroing the approval count
 * while leaving a team gate bound still blocks every merge, and `survived`
 * would even keep the ruleset alive because of it.
 */
test("a solo ORG repo drops the team requirement too, not just the count", () => {
  const soloOrg = { ...ORG, reviewCapacity: 1, teamSizes: { "tehvault/reviewers": 5 } };
  const { rulesets, degradations } = withProd(soloOrg);

  assert.equal(byName(rulesets, "team-only-reviewer"), undefined, "the ruleset is not created");
  assert.ok(
    degradations.some((d) => d.dropped === "required_reviewers"),
    "the team gate is dropped, not merely the count",
  );
});

test("an empty team can never approve, so its requirement is dropped", () => {
  const emptyTeam = { ...ORG, teamSizes: { "tehvault/reviewers": 0 } };
  const { rulesets, degradations } = withProd(emptyTeam);

  const dropped = degradations.find((d) => d.dropped === "required_reviewers");
  assert.match(dropped.reason, /has no members/);
  assert.match(dropped.remedy, /add a member/);
  // requiredApprovals 1 with capacity 5 still stands on its own.
  assert.equal(
    byName(rulesets, "team-only-reviewer").rules.find((r) => r.type === "pull_request").parameters
      .required_reviewers,
    undefined,
  );
});

test("approvals available is capacity minus the author, and unknown means unlimited", () => {
  assert.equal(approvalsAvailable({ reviewCapacity: 3 }), 2);
  assert.equal(approvalsAvailable({ reviewCapacity: 1 }), 0);
  assert.equal(approvalsAvailable({ reviewCapacity: 0 }), 0);
  assert.equal(approvalsAvailable({}), Infinity);
});

/** A count is measured against what the repo can supply, not a fixed 2. */
test("an approval count above what the repo can supply is reduced to what it can", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { requiredApprovals: 3 };
  const { rulesets, degradations } = compile(config, { ...PERSONAL, reviewCapacity: 3 });

  assert.equal(
    byName(rulesets, "reviewers-staging").rules.find((r) => r.type === "pull_request").parameters
      .required_approving_review_count,
    2,
    "3 pushers can supply at most 2 approvals",
  );
  assert.equal(degradations.find((d) => d.dropped === "required_approving_review_count").reducedTo, 2);
});

test("a satisfiable count is left exactly as configured", () => {
  const config = clone(CANONICAL);
  config.environments.staging = { requiredApprovals: 2 };
  const { rulesets, degradations } = compile(config, { ...PERSONAL, reviewCapacity: 5 });

  assert.equal(
    byName(rulesets, "reviewers-staging").rules.find((r) => r.type === "pull_request").parameters
      .required_approving_review_count,
    2,
  );
  assert.equal(
    degradations.filter((d) => d.dropped === "required_approving_review_count").length,
    0,
    "a count the repo can supply is never touched",
  );
});

/**
 * A reviewer ruleset that cannot survive here but ALREADY exists must still be
 * emitted, neutered — dropping it from the desired set would leave the live
 * one demanding a review this repo cannot supply, blocking every merge.
 */
test("an existing reviewer ruleset that cannot survive is neutered, not abandoned", () => {
  const config = clone(CANONICAL);
  addEnvironments(config, ["prod"]);
  const { rulesets } = compile(config, {
    ...SOLO,
    existingRulesetNames: ["team-only-reviewer"],
  });

  const prod = byName(rulesets, "team-only-reviewer");
  assert.ok(prod, "it is still emitted so the live ruleset gets updated");
  const pr = prod.rules.find((r) => r.type === "pull_request");
  assert.equal(pr.parameters.required_approving_review_count, 0, "the block is removed");
  assert.equal(pr.parameters.required_reviewers, undefined);
  assert.ok(prod.rules.some((r) => r.type === "deletion"), "real protection remains");
});

test("the same ruleset is simply not created when it does not already exist", () => {
  const { rulesets } = withProd(SOLO);
  assert.equal(byName(rulesets, "team-only-reviewer"), undefined);
});

test("a reviewer team must be named by its slug, not its display name", () => {
  assert.throws(() => assertTeamSlugs(["tehvault/My Team"]), /org\/team-slug/);
  assert.throws(() => assertTeamSlugs(["tehvault/Reviewers"]), /lowercase/);
  assert.doesNotThrow(() => assertTeamSlugs(["tehvault/reviewers", "acme/prod-approvers"]));
  assert.doesNotThrow(() => assertTeamSlugs([]));
});

test("a numeric environment name is refused, since it would reorder the pipeline", () => {
  assert.throws(() => assertEnvironmentNames({ environments: { dev: {}, 2: {} } }), /must not be numbers/);
  assert.doesNotThrow(() => assertEnvironmentNames({ environments: { dev: {}, "qa2": {} } }));
  assert.doesNotThrow(() => assertEnvironmentNames({}));
});

// --- secrets a status check needs, but this plugin does not generate the workflow for ---------

test("the canonical config names OPENROUTER_API_KEY for dev's scope-check", () => {
  assert.deepEqual(requiredStatusCheckSecrets(CANONICAL), ["OPENROUTER_API_KEY"]);
});

test("an environment with no statusCheckSecrets contributes nothing", () => {
  assert.deepEqual(requiredStatusCheckSecrets({ environments: { dev: { statusChecks: ["x"] } } }), []);
});

test("secrets from multiple environments are collected and deduped", () => {
  const config = {
    environments: {
      dev: { statusCheckSecrets: ["OPENROUTER_API_KEY"] },
      staging: { statusCheckSecrets: ["OPENROUTER_API_KEY", "SNYK_TOKEN"] },
    },
  };
  assert.deepEqual(requiredStatusCheckSecrets(config), ["OPENROUTER_API_KEY", "SNYK_TOKEN"]);
});

test("no environments at all is not an error", () => {
  assert.deepEqual(requiredStatusCheckSecrets({}), []);
  assert.deepEqual(requiredStatusCheckSecrets(undefined), []);
});
