import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTaskId,
  decideTransition,
  renderWorkflow,
  renderClickUpWorkflow,
  renderJiraWorkflow,
  normalizeTaskSync,
  statusPipeline,
  planTaskSync,
  planSyncOrphans,
  removeSyncOrphan,
  pushStage,
  pushStageBlocked,
  rankedStages,
  GENERATED_MARKER,
  DEFAULT_TODO_STATUSES,
} from "../src/tasksync.js";

const OPTS = { prefixes: ["feature", "bugfix", "hotfix", "docs", "chore"], taskIdPrefix: "CU-" };

// --- extracting the task id --------------------------------------------------

test("an id is pulled from a branch with a description", () => {
  assert.equal(extractTaskId("feature/CU-123/checkout-redirect", OPTS), "123");
});

test("an id is pulled from a branch that is only prefix and id", () => {
  assert.equal(extractTaskId("feature/CU-123", OPTS), "123");
});

test("a fully qualified ref is accepted", () => {
  assert.equal(extractTaskId("refs/heads/feature/CU-123/api", OPTS), "123");
});

test("a deeply nested description does not break extraction", () => {
  assert.equal(extractTaskId("feature/CU-123/api/v2/retry", OPTS), "123");
});

test("alphanumeric ClickUp ids survive intact", () => {
  assert.equal(extractTaskId("feature/CU-86c1abcde/thing", OPTS), "86c1abcde");
});

test("a branch with no task id yields null rather than a guess", () => {
  assert.equal(extractTaskId("feature/checkout-redirect", OPTS), null);
});

test("an unrecognised prefix is rejected", () => {
  assert.equal(extractTaskId("wip/CU-123/thing", OPTS), null);
});

test("a bare branch name has nothing to extract", () => {
  assert.equal(extractTaskId("main", OPTS), null);
  assert.equal(extractTaskId("dev", OPTS), null);
});

test("an empty id after the prefix is not a task id", () => {
  assert.equal(extractTaskId("feature/CU-/thing", OPTS), null);
});

test("missing or empty input is handled", () => {
  assert.equal(extractTaskId(null, OPTS), null);
  assert.equal(extractTaskId("", OPTS), null);
});

test("a different id prefix can be configured", () => {
  assert.equal(extractTaskId("feature/TASK-9/x", { prefixes: ["feature"], taskIdPrefix: "TASK-" }), "9");
});

test("with no prefix list configured any prefix is accepted", () => {
  assert.equal(extractTaskId("anything/CU-5/x", { taskIdPrefix: "CU-" }), "5");
});

// --- deciding the transition -------------------------------------------------

test("every default to-do spelling advances", () => {
  for (const status of DEFAULT_TODO_STATUSES) {
    assert.equal(decideTransition(status).move, true, `expected '${status}' to advance`);
  }
});

test("status matching ignores case and surrounding space", () => {
  assert.equal(decideTransition("  TO DO  ").move, true);
});

test("a task already in progress is left alone", () => {
  const result = decideTransition("in progress");
  assert.equal(result.move, false);
  assert.match(result.reason, /already/);
});

test("a task past to-do is never dragged backwards", () => {
  for (const status of ["in review", "done", "closed", "blocked"]) {
    const result = decideTransition(status);
    assert.equal(result.move, false, `expected '${status}' to stay put`);
    assert.match(result.reason, /not in the configured pipeline|already at or past/);
  }
});

test("an unreadable status moves nothing", () => {
  assert.equal(decideTransition(null).move, false);
  assert.equal(decideTransition("").move, false);
});

test("the to-do set and target are configurable", () => {
  const opts = { todoStatuses: ["icebox"], target: "doing" };
  assert.deepEqual(
    { move: true, target: "doing" },
    (({ move, target }) => ({ move, target }))(decideTransition("icebox", opts)),
  );
  assert.equal(decideTransition("to do", opts).move, false);
});

// --- the generated workflow --------------------------------------------------

/** Most render tests care about one aspect, not the pipeline; this is the stand-in. */
const ONE = [{ env: "dev", status: "in progress", rank: 1 }];

test("the workflow never embeds the token, only the secret reference", () => {
  const yaml = renderWorkflow({}, ONE);
  assert.match(yaml, /CLICKUP_TOKEN: \$\{\{ secrets\.CLICKUP_TOKEN \}\}/);
  assert.doesNotMatch(yaml, /pk_[A-Za-z0-9]/);
});

test("the workflow only fires on a merged PR into a pipeline branch", () => {
  const yaml = renderWorkflow({}, [{ env: "dev", status: "in progress", rank: 1 }]);
  assert.match(yaml, /branches:\n      - 'dev'/);
  assert.match(yaml, /types: \[closed\]/);
  assert.match(yaml, /github\.event\.pull_request\.merged == true/);
});

// --- the multi-environment pipeline ---------------------------------------------

const PIPELINE = [
  { env: "dev", status: "in progress", rank: 1 },
  { env: "test", status: "QA", rank: 2 },
  { env: "prod", status: "done", rank: 3 },
];

test("every pipeline environment becomes a trigger branch and a case arm", () => {
  const yaml = renderWorkflow({}, PIPELINE);
  for (const st of PIPELINE) {
    assert.ok(yaml.includes(`      - '${st.env}'`), `${st.env} triggers the workflow`);
    assert.match(yaml, new RegExp(`'${st.env}'\\) want='${st.status}'; want_rank=${st.rank}`));
  }
});

test("the pipeline is documented at the top of the generated file", () => {
  const yaml = renderWorkflow({}, PIPELINE);
  assert.match(yaml, /#   merge into dev → in progress\n#   merge into test → QA\n#   merge into prod → done/);
});

test("each pipeline status is rankable, so a later merge cannot pull a task back", () => {
  const yaml = renderWorkflow({}, PIPELINE);
  assert.match(yaml, /'in progress'\) rank=1/);
  assert.match(yaml, /'qa'\) rank=2/);
  assert.match(yaml, /'done'\) rank=3/);
  assert.match(yaml, /\*\) rank=-1/, "an unlisted status stays unranked");
  assert.match(yaml, /\[ "\$rank" -ge "\$want_rank" \]/, "the forward-only comparison");
});

test("the base branch decides the target, and an unknown base is a no-op", () => {
  const yaml = renderWorkflow({}, PIPELINE);
  assert.match(yaml, /BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \|\| inputs\.base_ref \}\}/);
  assert.match(yaml, /is not a pipeline environment; nothing to sync/);
});

test("a status appearing at two stages is ranked once, at its first stage", () => {
  const yaml = renderWorkflow({}, [
    { env: "dev", status: "in progress", rank: 1 },
    { env: "staging", status: "in progress", rank: 2 },
  ]);
  assert.equal((yaml.match(/'in progress'\) rank=/g) ?? []).length, 1, "no duplicate case arm");
  assert.match(yaml, /'in progress'\) rank=1/, "the earliest rank wins");
});

test("the status is passed through jq, so a quote in it cannot break the payload", () => {
  const yaml = renderWorkflow({}, [{ env: "dev", status: `it's "done"`, rank: 1 }]);
  assert.match(yaml, /jq -nc --arg s "\$want"/);
  assert.doesNotMatch(yaml, /-d '\{"status"/, "never a hand-built JSON literal");
});

test("configured to-do statuses become the shell case arms", () => {
  const yaml = renderWorkflow({ todoStatuses: ["to do", "icebox"] }, ONE);
  assert.match(yaml, /'to do'\|'icebox'/);
});

test("a status containing a quote cannot break out of the shell literal", () => {
  const yaml = renderWorkflow({ todoStatuses: ["it's ready"] }, ONE);
  assert.match(yaml, /'it'\\''s ready'/);
});

test("the task id prefix is carried into the extraction step", () => {
  assert.match(renderWorkflow({ taskIdPrefix: "TASK-" }, ONE), /-v p='TASK-'/);
});

test("a custom secret name is what the workflow reads, matching what the CLI sets", () => {
  const yaml = renderWorkflow({ secretName: "CU_API_TOKEN" }, ONE);
  assert.match(yaml, /CLICKUP_TOKEN: \$\{\{ secrets\.CU_API_TOKEN \}\}/);
  assert.doesNotMatch(yaml, /secrets\.CLICKUP_TOKEN/);
});

test("the dispatch test path simulates a merge but a closed-unmerged PR still cannot", () => {
  const yaml = renderWorkflow({}, ONE);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.merged == true/);
  assert.match(yaml, /github\.event\.pull_request\.head\.ref \|\| inputs\.head_ref/);
});

// --- provider normalization ------------------------------------------------------

test("a legacy 'clickup' config section is honoured as provider clickup", () => {
  const sync = normalizeTaskSync({ clickup: { enabled: true, targetBranch: "dev" } });
  assert.equal(sync.provider, "clickup");
  assert.equal(sync.secretName, "CLICKUP_TOKEN");
  assert.equal(sync.taskIdPrefix, "CU-");
});

test("taskSync with provider jira gets Jira defaults", () => {
  const sync = normalizeTaskSync({ taskSync: { enabled: true, provider: "jira" } });
  assert.equal(sync.secretName, "JIRA_API_TOKEN");
  assert.equal(sync.taskIdPrefix, "");
});

test("taskSync wins over a legacy clickup section when both exist", () => {
  const sync = normalizeTaskSync({
    taskSync: { enabled: true, provider: "jira" },
    clickup: { enabled: true },
  });
  assert.equal(sync.provider, "jira");
});

test("disabled or absent task sync normalizes to null", () => {
  assert.equal(normalizeTaskSync({}), null);
  assert.equal(normalizeTaskSync({ taskSync: { enabled: false } }), null);
});

test("an unknown provider is refused by name", () => {
  assert.throws(
    () => normalizeTaskSync({ taskSync: { enabled: true, provider: "linear" } }),
    /Unknown task-sync provider 'linear'/,
  );
});

// --- the Jira workflow -------------------------------------------------------------

test("the Jira workflow follows the scope-check credential conventions", () => {
  const yaml = renderJiraWorkflow({}, ONE);
  assert.match(yaml, /JIRA_BASE_URL: \$\{\{ vars\.JIRA_BASE_URL \}\}/);
  assert.match(yaml, /JIRA_EMAIL: \$\{\{ vars\.JIRA_EMAIL \}\}/);
  assert.match(yaml, /JIRA_API_TOKEN: \$\{\{ secrets\.JIRA_API_TOKEN \}\}/);
});

test("the Jira workflow guards the merge event exactly like the ClickUp one", () => {
  const yaml = renderJiraWorkflow({}, ONE);
  assert.match(yaml, /github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.merged == true/);
  assert.match(yaml, /workflow_dispatch:/);
});

test("the Jira workflow looks the transition up by name rather than baking in an id", () => {
  const yaml = renderJiraWorkflow({ targetStatus: "In Progress" }, ONE);
  assert.match(yaml, /\/transitions/);
  assert.match(yaml, /'in progress'/);
  assert.ok(!yaml.includes('"id":"2'), "no hard-coded transition id");
});

test("the Jira workflow never interpolates a credential into the YAML", () => {
  const yaml = renderJiraWorkflow({ secretName: "JIRA_API_TOKEN" }, ONE);
  assert.ok(!/ATATT/.test(yaml));
  assert.match(yaml, /-u "\$JIRA_EMAIL:\$JIRA_API_TOKEN"/);
});

test("renderWorkflow dispatches on provider", () => {
  assert.match(renderWorkflow({ provider: "jira" }, ONE), /Jira issue sync/);
  assert.match(renderWorkflow({ provider: "clickup" }, ONE), /ClickUp task sync/);
  assert.match(renderWorkflow({}, ONE), /ClickUp task sync/);
});

/**
 * The provider split must not change what a given pipeline renders: dispatching
 * through renderWorkflow and calling the ClickUp renderer directly have to
 * agree, or a provider-aware plan would differ from a direct one.
 *
 * (Byte-stability against the PRE-pipeline workflow is deliberately not
 * claimed: multi-environment support changed the file on purpose, so already
 * synced repos correctly plan an UPDATE.)
 */
test("renderWorkflow and the direct ClickUp renderer agree for the same pipeline", () => {
  const bundled = { provider: "clickup", taskIdPrefix: "CU-", secretName: "CLICKUP_TOKEN" };
  const pipeline = [
    { env: "dev", status: "in progress", rank: 1 },
    { env: "prod", status: "done", rank: 2 },
  ];
  assert.equal(renderWorkflow(bundled, pipeline), renderClickUpWorkflow(bundled, pipeline));
  assert.match(renderWorkflow(bundled, pipeline), /name: ClickUp task sync/);
});

// --- orphaned workflows after a provider switch --------------------------------

function orphanClient(files = {}) {
  return {
    getFile: async (p) => (p in files ? { sha: `sha-${p}`, content: files[p] } : null),
    deleted: [],
    deleteFile(path, message, sha) {
      this.deleted.push({ path, message, sha });
    },
  };
}

const OURS = `${GENERATED_MARKER}. Re-run the sync to update it;\n...`;

test("switching to jira plans the generated clickup workflow for deletion", async () => {
  const client = orphanClient({ ".github/workflows/clickup-sync.yml": OURS });
  const orphans = await planSyncOrphans(client, "jira");
  assert.deepEqual(orphans.map((o) => o.path), [".github/workflows/clickup-sync.yml"]);
});

/** The plugin never deletes what it did not create — ownership is the marker. */
test("a hand-written workflow at a managed path is never an orphan", async () => {
  const client = orphanClient({
    ".github/workflows/jira-sync.yml": "name: my own jira automation\non: push\n",
  });
  assert.deepEqual(await planSyncOrphans(client, "clickup"), []);
  assert.deepEqual(await planSyncOrphans(client, null), []);
});

test("provider none orphans every generated sync workflow, and only those", async () => {
  const client = orphanClient({
    ".github/workflows/clickup-sync.yml": OURS,
    ".github/workflows/jira-sync.yml": OURS,
  });
  const orphans = await planSyncOrphans(client, null);
  assert.deepEqual(
    orphans.map((o) => o.path).sort(),
    [".github/workflows/clickup-sync.yml", ".github/workflows/jira-sync.yml"],
  );
});

test("the active provider's own workflow is never an orphan", async () => {
  const client = orphanClient({ ".github/workflows/clickup-sync.yml": OURS });
  assert.deepEqual(await planSyncOrphans(client, "clickup"), []);
});

test("both rendered workflows actually carry the ownership marker", () => {
  assert.ok(renderClickUpWorkflow({}, ONE).startsWith(GENERATED_MARKER));
  assert.ok(renderJiraWorkflow({}, ONE).startsWith(GENERATED_MARKER));
});

test("removing an orphan passes the sha the delete API requires", async () => {
  const client = orphanClient({ ".github/workflows/jira-sync.yml": OURS });
  const [orphan] = await planSyncOrphans(client, "clickup");
  await removeSyncOrphan(client, orphan);
  assert.equal(client.deleted[0].sha, "sha-.github/workflows/jira-sync.yml");
  assert.match(client.deleted[0].message, /provider changed/);
});

test("a lowercase branch key is uppercased before it reaches the Jira API", () => {
  assert.match(renderJiraWorkflow({}, ONE), /tr '\[:lower:\]' '\[:upper:\]'/);
});

// --- statusPipeline: order comes from the environment order ----------------------

const CFG = (envs, taskSync = {}) => ({
  environments: Object.fromEntries(envs.map((e) => [e, {}])),
  taskSync: { enabled: true, ...taskSync },
});

test("environments map to their configured statuses, in declaration order", () => {
  const cfg = CFG(["dev", "test", "prod"], {
    environmentStatuses: { dev: "in progress", test: "QA", prod: "done" },
  });
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "dev", status: "in progress", rank: 1 },
    { env: "test", status: "QA", rank: 2 },
    { env: "prod", status: "done", rank: 3 },
  ]);
});

/** The point of the feature: a new environment needs no extra configuration. */
test("an environment with no configured status maps to its own name", () => {
  const cfg = CFG(["dev", "staging"], { environmentStatuses: { dev: "in progress" } });
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "dev", status: "in progress", rank: 1 },
    { env: "staging", status: "staging", rank: 2 },
  ]);
});

test("an environment can opt out of task sync with null", () => {
  const cfg = CFG(["dev", "test", "prod"], { environmentStatuses: { test: null } });
  assert.deepEqual(
    statusPipeline(cfg, normalizeTaskSync(cfg)).map((s) => s.env),
    ["dev", "prod"],
  );
});

test("the legacy single-branch config becomes a one-stage pipeline", () => {
  const cfg = { environments: { dev: {} }, clickup: { enabled: true, targetBranch: "dev", targetStatus: "doing" } };
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "dev", status: "doing", rank: 1 },
  ]);
});

test("a legacy target branch that is not a declared environment still gets a stage", () => {
  const cfg = { environments: {}, clickup: { enabled: true, targetBranch: "develop" } };
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "develop", status: "in progress", rank: 1 },
  ]);
});

// --- forwards-only across the whole pipeline ------------------------------------

const STAGE = (target, rank) => ({ pipeline: PIPELINE, target, targetRank: rank });

test("a to-do task advances to whichever stage it arrives at", () => {
  assert.equal(decideTransition("to do", STAGE("in progress", 1)).move, true);
  assert.equal(decideTransition("backlog", STAGE("QA", 2)).move, true);
  assert.equal(decideTransition("to do", STAGE("done", 3)).move, true);
});

test("a task mid-pipeline advances only forwards", () => {
  // in progress (1) → QA (2) is forward
  assert.equal(decideTransition("in progress", STAGE("QA", 2)).move, true);
  // QA (2) → in progress (1) would be backwards
  const back = decideTransition("QA", STAGE("in progress", 1));
  assert.equal(back.move, false);
  assert.match(back.reason, /already at or past/);
});

/** Merging an old branch into dev must never resurrect a finished task. */
test("a done task is never pulled back by a later merge into an earlier stage", () => {
  for (const [target, rank] of [["in progress", 1], ["QA", 2], ["done", 3]]) {
    assert.equal(decideTransition("done", STAGE(target, rank)).move, false, `done → ${target}`);
  }
});

test("a status outside the pipeline is left alone rather than guessed at", () => {
  const result = decideTransition("blocked", STAGE("QA", 2));
  assert.equal(result.move, false);
  assert.match(result.reason, /not in the configured pipeline/);
});

test("status matching ignores case", () => {
  assert.equal(decideTransition("IN PROGRESS", STAGE("QA", 2)).move, true);
  assert.equal(decideTransition("Done", STAGE("QA", 2)).move, false);
});

/**
 * environmentStatuses is a lookup table, not a stage list: a status declared
 * for an environment the repository does not have must not create a stage, or
 * the workflow would trigger on branches nobody manages.
 */
test("a status declared for an undeclared environment creates no stage", () => {
  const cfg = CFG(["dev"], { environmentStatuses: { dev: "in progress", test: "QA", prod: "done" } });
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "dev", status: "in progress", rank: 1 },
  ]);
});

test("adding that environment is what brings its stage in", () => {
  const cfg = CFG(["dev", "test"], { environmentStatuses: { dev: "in progress", test: "QA", prod: "done" } });
  assert.deepEqual(
    statusPipeline(cfg, normalizeTaskSync(cfg)).map((s) => `${s.env}→${s.status}`),
    ["dev→in progress", "test→QA"],
  );
});

// --- regressions from the pipeline review ---------------------------------------

/**
 * The shape the CLI writes on a first sync carries no environmentStatuses at
 * all. Falling through to "status named after the environment" gave dev→'dev',
 * a status no workspace has, so every merge failed the job.
 */
test("conventional environments keep their meaning with no statuses configured", () => {
  const cfg = CFG(["dev", "test", "prod", "staging"], {});
  assert.deepEqual(
    statusPipeline(cfg, normalizeTaskSync(cfg)).map((s) => `${s.env}→${s.status}`),
    ["dev→in progress", "test→QA", "prod→done", "staging→staging"],
  );
});

test("an explicit status still overrides the conventional default", () => {
  const cfg = CFG(["dev"], { environmentStatuses: { dev: "doing" } });
  assert.equal(statusPipeline(cfg, normalizeTaskSync(cfg))[0].status, "doing");
});

/** Upgrading a legacy config must not start syncing environments it never did. */
test("a legacy single-branch config stays a single stage even with other environments", () => {
  const cfg = {
    environments: { dev: {}, test: {}, prod: {} },
    clickup: { enabled: true, targetBranch: "dev", targetStatus: "in progress" },
  };
  assert.deepEqual(statusPipeline(cfg, normalizeTaskSync(cfg)), [
    { env: "dev", status: "in progress", rank: 1 },
  ]);
});

test("a pipeline with no stages renders nothing rather than inventing dev", () => {
  assert.throws(() => renderWorkflow({}, []), /no pipeline stages/);
  assert.throws(() => renderJiraWorkflow({}, []), /no pipeline stages/);
});

test("opting every environment out plans no workflow at all", async () => {
  const cfg = CFG(["dev"], { environmentStatuses: { dev: null } });
  const client = { getFile: async () => null, hasSecret: async () => true, hasVariable: async () => true };
  assert.equal(await planTaskSync(client, cfg), null);
});

test("an empty status is an opt-out, not a stage matching an unreadable status", () => {
  const cfg = CFG(["dev", "prod"], { environmentStatuses: { dev: "", prod: "done" } });
  assert.deepEqual(
    statusPipeline(cfg, normalizeTaskSync(cfg)).map((s) => s.env),
    ["prod"],
  );
});

test("an empty todo list emits no case arm rather than invalid bash", () => {
  const yaml = renderWorkflow({ todoStatuses: [] }, ONE);
  assert.doesNotMatch(yaml, /^\s*\) rank=0/m, "a patternless arm is a bash syntax error");
});

test("arriving at a status the task already holds is a no-op, not a write", () => {
  const shared = [
    { env: "dev", status: "in progress", rank: 1 },
    { env: "test", status: "in progress", rank: 2 },
  ];
  // JS model
  const result = decideTransition("in progress", { pipeline: shared, target: "in progress", targetRank: 2 });
  assert.equal(result.move, false);
  assert.match(result.reason, /already/);
  // and the generated shell short-circuits the same way
  assert.match(renderWorkflow({}, shared), /\[ "\$lower" = "\$want_lower" \]/);
});

test("a target outside the pipeline is refused rather than treated as stage one", () => {
  const result = decideTransition("to do", { pipeline: PIPELINE, target: "released" });
  assert.equal(result.move, false);
  assert.match(result.reason, /not a stage in the configured pipeline/);
});

test("environment names and statuses are YAML-quoted so they cannot change type", () => {
  const yaml = renderWorkflow({}, [{ env: "no", status: "QA", rank: 1 }]);
  assert.match(yaml, /      - 'no'/, "unquoted, YAML reads 'no' as false");
});

test("the generated shell trims the status, matching the JS model", () => {
  assert.match(renderWorkflow({}, ONE), /sed 's\/\^\[\[:space:\]\]\*\/\/;s\/\[\[:space:\]\]\*\$\/\//);
});

test("the dispatch base_ref defaults to the first stage, so old invocations still work", () => {
  const yaml = renderWorkflow({}, PIPELINE);
  assert.match(yaml, /required: false\n        default: 'dev'/);
});

// --- the push stage: work starting, before anything is merged --------------------

/**
 * A config shaped like the shipped one: a push moves a to-do task to
 * "in progress", and the environments follow behind it.
 */
const WITH_PUSH = {
  environments: { dev: {}, test: {}, prod: {} },
  branchNaming: { allowedPrefixes: ["feature", "bugfix"] },
  taskSync: {
    enabled: true,
    provider: "clickup",
    branchPushStatus: "in progress",
    environmentStatuses: { dev: "dev", test: "QA", prod: "done" },
  },
};

const pushSync = (config = WITH_PUSH) => normalizeTaskSync(config);

test("a push stage takes rank 1 and shifts every environment behind it", () => {
  const sync = pushSync();
  assert.deepEqual(pushStage(WITH_PUSH, sync), {
    status: "in progress",
    rank: 1,
    prefixes: ["feature", "bugfix"],
  });
  assert.deepEqual(statusPipeline(WITH_PUSH, sync), [
    { env: "dev", status: "dev", rank: 2 },
    { env: "test", status: "QA", rank: 3 },
    { env: "prod", status: "done", rank: 4 },
  ]);
});

test("without branchPushStatus the environments keep the ranks they always had", () => {
  const config = { ...WITH_PUSH, taskSync: { ...WITH_PUSH.taskSync, branchPushStatus: null } };
  assert.equal(pushStage(config, normalizeTaskSync(config)), null);
  assert.deepEqual(
    statusPipeline(config, normalizeTaskSync(config)).map((st) => st.rank),
    [1, 2, 3],
    "no push stage, no offset",
  );
});

test("branchPushStatus is off unless configured, so no repo starts syncing pushes on upgrade", () => {
  const config = { environments: { dev: {} }, taskSync: { enabled: true, provider: "clickup" } };
  assert.equal(normalizeTaskSync(config).branchPushStatus, null);
  assert.equal(pushStage(config, normalizeTaskSync(config)), null);
});

/**
 * The trap this guards: a task left at the push status must still rank, or the
 * first merge would read "in progress" as a status outside the pipeline and
 * leave it there for good — turning a head start into a dead end.
 */
test("the push status is rankable, so the first merge can still move the task on", () => {
  const sync = pushSync();
  const stages = rankedStages(pushStage(WITH_PUSH, sync), statusPipeline(WITH_PUSH, sync));

  assert.deepEqual(
    stages.map((st) => [st.status, st.rank]),
    [
      ["in progress", 1],
      ["dev", 2],
      ["QA", 3],
      ["done", 4],
    ],
  );
  assert.deepEqual(
    decideTransition("in progress", { pipeline: stages, target: "dev", targetRank: 2 }),
    { move: true, target: "dev", reason: "'in progress' comes before 'dev'" },
  );
});

test("a to-do task moves on a push, and a second push changes nothing", () => {
  const sync = pushSync();
  const push = pushStage(WITH_PUSH, sync);
  const stages = rankedStages(push, statusPipeline(WITH_PUSH, sync));
  const onPush = (current) =>
    decideTransition(current, {
      pipeline: stages,
      target: push.status,
      targetRank: push.rank,
      todoStatuses: sync.todoStatuses,
    });

  assert.equal(onPush("to do").move, true, "work has started");
  assert.equal(onPush("backlog").move, true, "any to-do spelling counts");
  assert.equal(onPush("in progress").move, false, "already there");
  assert.equal(onPush("done").move, false, "a push must never pull a finished task back");
  assert.match(onPush("done").reason, /already at or past/);
});

test("the push stage becomes a push trigger, one pattern per allowed prefix", () => {
  const sync = pushSync();
  const yaml = renderWorkflow(sync, statusPipeline(WITH_PUSH, sync), pushStage(WITH_PUSH, sync));

  assert.match(yaml, /\n  push:\n    branches:\n      - 'feature\/\*\*'\n      - 'bugfix\/\*\*'\n/);
  assert.match(yaml, /if: github\.event_name == 'push' \|\|/, "a push must not be gated on a merge");
  assert.match(yaml, /#   push feature\/\*\*, bugfix\/\*\* → in progress/, "documented first, being rank 1");
});

test("the generated shell picks the stage from the event, not only the base branch", () => {
  const sync = pushSync();
  const yaml = renderWorkflow(sync, statusPipeline(WITH_PUSH, sync), pushStage(WITH_PUSH, sync));

  assert.match(yaml, /if \[ "\$\{EVENT_NAME:-\}" = "push" \]; then\n\s+want='in progress'; want_rank=1/);
  assert.match(yaml, /'dev'\) want='dev'; want_rank=2/, "the merge arms keep their shifted ranks");
  assert.match(yaml, /'in progress'\) rank=1/, "and the push status is rankable in the shell too");
});

/**
 * On a manual dispatch `github.ref_name` is whatever branch the run was started
 * from, so it must lose to the branch the operator actually typed — otherwise
 * the test entry silently syncs the wrong branch.
 */
test("HEAD_REF prefers a dispatch input over the pushed ref", () => {
  const sync = pushSync();
  const yaml = renderWorkflow(sync, statusPipeline(WITH_PUSH, sync), pushStage(WITH_PUSH, sync));

  assert.match(
    yaml,
    /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \|\| inputs\.head_ref \|\| github\.ref_name \}\}/,
  );
});

test("a push stage with no branch prefixes to match is reported, not dropped in silence", () => {
  const config = { ...WITH_PUSH, branchNaming: { allowedPrefixes: [] } };
  const sync = normalizeTaskSync(config);

  assert.equal(pushStage(config, sync), null);
  assert.match(pushStageBlocked(config, sync), /allowedPrefixes is empty/);
  assert.equal(pushStageBlocked(WITH_PUSH, pushSync()), null, "nothing to report when it works");
});

test("both providers render the push trigger", () => {
  const jira = { ...WITH_PUSH, taskSync: { ...WITH_PUSH.taskSync, provider: "jira" } };
  const sync = normalizeTaskSync(jira);
  const yaml = renderJiraWorkflow(sync, statusPipeline(jira, sync), pushStage(jira, sync));

  assert.match(yaml, /\n  push:\n    branches:\n      - 'feature\/\*\*'/);
  assert.match(yaml, /if: github\.event_name == 'push' \|\|/);
  assert.match(yaml, /'in progress'\) rank=1/);
});

test("a bare task id needs no prefix in the extraction step", () => {
  const yaml = renderClickUpWorkflow({ taskIdPrefix: "" }, PIPELINE);
  assert.match(yaml, /-v p='' /, "an empty prefix takes the whole second segment");
  assert.match(yaml, /No task id in/, "and the message does not read as a typo");
});
