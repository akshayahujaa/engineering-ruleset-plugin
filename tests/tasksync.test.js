import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTaskId,
  decideTransition,
  renderWorkflow,
  renderClickUpWorkflow,
  renderJiraWorkflow,
  normalizeTaskSync,
  planSyncOrphans,
  removeSyncOrphan,
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
    assert.match(result.reason, /past to-do/);
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

test("the workflow never embeds the token, only the secret reference", () => {
  const yaml = renderWorkflow({});
  assert.match(yaml, /CLICKUP_TOKEN: \$\{\{ secrets\.CLICKUP_TOKEN \}\}/);
  assert.doesNotMatch(yaml, /pk_[A-Za-z0-9]/);
});

test("the workflow only fires on a merged PR into the target branch", () => {
  const yaml = renderWorkflow({ targetBranch: "dev" });
  assert.match(yaml, /branches: \[dev\]/);
  assert.match(yaml, /types: \[closed\]/);
  assert.match(yaml, /github\.event\.pull_request\.merged == true/);
});

test("the target branch and status come from config", () => {
  const yaml = renderWorkflow({ targetBranch: "develop", targetStatus: "doing" });
  assert.match(yaml, /branches: \[develop\]/);
  assert.match(yaml, /\{"status":"doing"\}/);
});

test("configured to-do statuses become the shell case arms", () => {
  const yaml = renderWorkflow({ todoStatuses: ["to do", "icebox"] });
  assert.match(yaml, /'to do'\|'icebox'/);
});

test("a status containing a quote cannot break out of the shell literal", () => {
  const yaml = renderWorkflow({ todoStatuses: ["it's ready"] });
  assert.match(yaml, /'it'\\''s ready'/);
});

test("the task id prefix is carried into the extraction step", () => {
  assert.match(renderWorkflow({ taskIdPrefix: "TASK-" }), /-v p='TASK-'/);
});

test("a custom secret name is what the workflow reads, matching what the CLI sets", () => {
  const yaml = renderWorkflow({ secretName: "CU_API_TOKEN" });
  assert.match(yaml, /CLICKUP_TOKEN: \$\{\{ secrets\.CU_API_TOKEN \}\}/);
  assert.doesNotMatch(yaml, /secrets\.CLICKUP_TOKEN/);
});

test("the dispatch test path simulates a merge but a closed-unmerged PR still cannot", () => {
  const yaml = renderWorkflow({});
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
  const yaml = renderJiraWorkflow({});
  assert.match(yaml, /JIRA_BASE_URL: \$\{\{ vars\.JIRA_BASE_URL \}\}/);
  assert.match(yaml, /JIRA_EMAIL: \$\{\{ vars\.JIRA_EMAIL \}\}/);
  assert.match(yaml, /JIRA_API_TOKEN: \$\{\{ secrets\.JIRA_API_TOKEN \}\}/);
});

test("the Jira workflow guards the merge event exactly like the ClickUp one", () => {
  const yaml = renderJiraWorkflow({});
  assert.match(yaml, /github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.merged == true/);
  assert.match(yaml, /workflow_dispatch:/);
});

test("the Jira workflow looks the transition up by name rather than baking in an id", () => {
  const yaml = renderJiraWorkflow({ targetStatus: "In Progress" });
  assert.match(yaml, /\/transitions/);
  assert.match(yaml, /'in progress'/);
  assert.ok(!yaml.includes('"id":"2'), "no hard-coded transition id");
});

test("the Jira workflow never interpolates a credential into the YAML", () => {
  const yaml = renderJiraWorkflow({ secretName: "JIRA_API_TOKEN" });
  assert.ok(!/ATATT/.test(yaml));
  assert.match(yaml, /-u "\$JIRA_EMAIL:\$JIRA_API_TOKEN"/);
});

test("renderWorkflow dispatches on provider", () => {
  assert.match(renderWorkflow({ provider: "jira" }), /Jira issue sync/);
  assert.match(renderWorkflow({ provider: "clickup" }), /ClickUp task sync/);
  assert.match(renderWorkflow({}), /ClickUp task sync/);
});

/**
 * Byte-stability: a repo synced before providers existed must plan
 * `unchanged` for its committed clickup-sync.yml, not `update`.
 */
test("the ClickUp workflow is byte-identical for the bundled config shape", () => {
  const bundled = {
    enabled: true,
    provider: "clickup",
    targetBranch: "dev",
    taskIdPrefix: "CU-",
    todoStatuses: ["to do", "todo", "open", "backlog", "pending"],
    targetStatus: "in progress",
    secretName: "CLICKUP_TOKEN",
  };
  const viaProvider = renderWorkflow(normalizeTaskSync({ taskSync: bundled }));
  const direct = renderClickUpWorkflow(bundled);
  assert.equal(viaProvider, direct);
  assert.match(viaProvider, /name: ClickUp task sync/);
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
  assert.ok(renderClickUpWorkflow({}).startsWith(GENERATED_MARKER));
  assert.ok(renderJiraWorkflow({}).startsWith(GENERATED_MARKER));
});

test("removing an orphan passes the sha the delete API requires", async () => {
  const client = orphanClient({ ".github/workflows/jira-sync.yml": OURS });
  const [orphan] = await planSyncOrphans(client, "clickup");
  await removeSyncOrphan(client, orphan);
  assert.equal(client.deleted[0].sha, "sha-.github/workflows/jira-sync.yml");
  assert.match(client.deleted[0].message, /provider changed/);
});

test("a lowercase branch key is uppercased before it reaches the Jira API", () => {
  assert.match(renderJiraWorkflow({}), /tr '\[:lower:\]' '\[:upper:\]'/);
});
