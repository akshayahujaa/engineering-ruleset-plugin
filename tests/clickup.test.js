import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTaskId, decideTransition, renderWorkflow, DEFAULT_TODO_STATUSES } from "../src/clickup.js";

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
