import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizePrChecks,
  renderScopeCheckWorkflow,
  renderPrAgentWorkflow,
  renderScopeCheckScript,
  planPrChecks,
  planPrCheckOrphans,
  GENERATED_MARKER,
  GENERATED_MARKER_JS,
  SCOPE_CHECK_WORKFLOW_PATH,
  SCOPE_CHECK_SCRIPT_PATH,
  PR_AGENT_WORKFLOW_PATH,
} from "../src/prchecks.js";

const ON = { prChecks: { scopeCheck: { enabled: true }, prAgent: { enabled: true } } };
const checks = normalizePrChecks(ON);
const ENVS = ["dev", "test", "prod"];

/** Parses YAML by shelling out to python, so a broken document fails loudly. */
function parseYaml(text) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "prchecks-")), "w.yml");
  writeFileSync(file, text);
  const out = execFileSync("python3", ["-c", `import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))`, file], {
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/** GitHub Actions' `on:` key is the YAML boolean true once parsed. */
const triggers = (doc) => doc[true] ?? doc.on;

// --- the scope-check workflow ------------------------------------------------------

test("the scope-check workflow is valid YAML and keeps the required job id", () => {
  const doc = parseYaml(renderScopeCheckWorkflow({ environments: ENVS, provider: "clickup", scopeCheck: checks.scopeCheck }));
  // This job id IS the `scope-check` context PR-SCOPE-CHECK requires; if it
  // ever drifts, every merge into a guarded branch waits on a check that no
  // workflow reports.
  assert.deepEqual(Object.keys(doc.jobs), ["scope-check"]);
});

test("it triggers on exactly the declared environments, quoted so none become booleans", () => {
  const yaml = renderScopeCheckWorkflow({
    environments: ["dev", "no", "2"],
    provider: "clickup",
    scopeCheck: checks.scopeCheck,
  });
  assert.deepEqual(triggers(parseYaml(yaml)).pull_request.branches, ["dev", "no", "2"]);
});

test("ClickUp wires only its token; Jira wires its two variables and token", () => {
  const envOf = (provider) => {
    const doc = parseYaml(renderScopeCheckWorkflow({ environments: ENVS, provider, scopeCheck: checks.scopeCheck }));
    return doc.jobs["scope-check"].steps.at(-1).env;
  };

  const clickup = envOf("clickup");
  assert.equal(clickup.ISSUE_PROVIDER, "clickup");
  assert.equal(clickup.CLICKUP_TOKEN, "${{ secrets.CLICKUP_TOKEN }}");
  assert.equal(clickup.JIRA_API_TOKEN, undefined, "a ClickUp repo is never asked for Jira credentials");

  const jira = envOf("jira");
  assert.equal(jira.ISSUE_PROVIDER, "jira");
  assert.equal(jira.JIRA_BASE_URL, "${{ vars.JIRA_BASE_URL }}");
  assert.equal(jira.JIRA_EMAIL, "${{ vars.JIRA_EMAIL }}");
  assert.equal(jira.JIRA_API_TOKEN, "${{ secrets.JIRA_API_TOKEN }}");
  assert.equal(jira.CLICKUP_TOKEN, undefined);
});

test("behaviour flags reach the workflow as strings the script can read", () => {
  const config = normalizePrChecks({
    prChecks: { scopeCheck: { enabled: true, requireTask: false, failOpenOnError: true, maxDiffChars: 1234 } },
  });
  const doc = parseYaml(renderScopeCheckWorkflow({ environments: ENVS, provider: "clickup", scopeCheck: config.scopeCheck }));
  const env = doc.jobs["scope-check"].steps.at(-1).env;
  assert.equal(env.REQUIRE_TASK, "false");
  assert.equal(env.FAIL_OPEN_ON_ERROR, "true");
  assert.equal(env.MAX_DIFF_CHARS, "1234");
});

test("the workflow runs the script at the path the plugin also writes", () => {
  const doc = parseYaml(renderScopeCheckWorkflow({ environments: ENVS, provider: "clickup", scopeCheck: checks.scopeCheck }));
  assert.equal(doc.jobs["scope-check"].steps.at(-1).run, `node ${SCOPE_CHECK_SCRIPT_PATH}`);
});

test("rendering is refused rather than producing a workflow that cannot work", () => {
  assert.throws(
    () => renderScopeCheckWorkflow({ environments: [], provider: "clickup", scopeCheck: checks.scopeCheck }),
    /no environment branches/,
  );
  assert.throws(
    () => renderScopeCheckWorkflow({ environments: ENVS, provider: "none", scopeCheck: checks.scopeCheck }),
    /issue provider 'none'/,
  );
});

// --- the scope-check script --------------------------------------------------------

test("the generated script is valid JavaScript and carries the ownership marker", () => {
  const script = renderScopeCheckScript();
  assert.ok(script.startsWith(GENERATED_MARKER_JS));

  const file = path.join(mkdtempSync(path.join(tmpdir(), "prchecks-")), "scope-check.mjs");
  writeFileSync(file, script);
  execFileSync(process.execPath, ["--check", file]); // throws if it does not parse
});

/** Explicitly removed on request: the plugin must never gate on it. */
test("the script has no acceptance-criteria gate", () => {
  const script = renderScopeCheckScript();
  assert.doesNotMatch(script, /acceptance criteria/i);
  assert.doesNotMatch(script, /hasAcceptanceCriteria/);
});

test("the script supports both trackers, so one file serves either provider", () => {
  const script = renderScopeCheckScript();
  assert.match(script, /getClickUpTask/);
  assert.match(script, /getJiraTask/);
});

// --- the PR-Agent workflow ---------------------------------------------------------

test("the PR-Agent workflow is valid YAML with a review job and a security gate", () => {
  const doc = parseYaml(renderPrAgentWorkflow({ prAgent: checks.prAgent }));
  assert.deepEqual(Object.keys(doc.jobs), ["pr_agent", "security_gate"]);
  assert.equal(doc.jobs.security_gate.needs, "pr_agent");
});

test("its security gate is valid bash", () => {
  const doc = parseYaml(renderPrAgentWorkflow({ prAgent: checks.prAgent }));
  const file = path.join(mkdtempSync(path.join(tmpdir(), "prchecks-")), "gate.sh");
  writeFileSync(file, doc.jobs.security_gate.steps[0].run);
  execFileSync("bash", ["-n", file]); // throws on a syntax error
});

test("the security gate can be turned off, leaving only the reviewer", () => {
  const off = normalizePrChecks({ prChecks: { prAgent: { enabled: true, securityGate: false } } });
  const doc = parseYaml(renderPrAgentWorkflow({ prAgent: off.prAgent }));
  assert.deepEqual(Object.keys(doc.jobs), ["pr_agent"]);
});

test("model settings are configurable and reach the action as strings", () => {
  const custom = normalizePrChecks({
    prChecks: { prAgent: { enabled: true, model: "openrouter/x", fallbackModels: ["a", "b"], numCodeSuggestions: 9 } },
  });
  const env = parseYaml(renderPrAgentWorkflow({ prAgent: custom.prAgent })).jobs.pr_agent.steps[0].env;
  assert.equal(env.CONFIG__MODEL, "openrouter/x");
  assert.equal(env.CONFIG__FALLBACK_MODELS, '["a","b"]');
  assert.equal(env.PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS, "9");
});

// --- planning ----------------------------------------------------------------------

const stubClient = (files = {}) => ({
  getFile: async (p) => (p in files ? { sha: `sha-${p}`, content: files[p] } : null),
});

test("nothing is planned when the feature is off", async () => {
  const result = await planPrChecks(stubClient(), { environments: { dev: {} } }, { provider: "clickup" });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.blocked, []);
});

test("all three files are planned when both checks are on", async () => {
  const result = await planPrChecks(
    stubClient(),
    { ...ON, environments: { dev: {} } },
    { provider: "clickup" },
  );
  assert.deepEqual(result.files.map((f) => f.path), [
    SCOPE_CHECK_WORKFLOW_PATH,
    SCOPE_CHECK_SCRIPT_PATH,
    PR_AGENT_WORKFLOW_PATH,
  ]);
  assert.ok(result.files.every((f) => f.action === "create"));
});

test("the credentials each enabled check needs are reported", async () => {
  const clickup = await planPrChecks(stubClient(), { ...ON, environments: { dev: {} } }, { provider: "clickup" });
  assert.deepEqual(clickup.secrets.sort(), ["CLICKUP_TOKEN", "OPENROUTER_API_KEY"]);
  assert.deepEqual(clickup.variables, []);

  const jira = await planPrChecks(stubClient(), { ...ON, environments: { dev: {} } }, { provider: "jira" });
  assert.deepEqual(jira.secrets.sort(), ["JIRA_API_TOKEN", "OPENROUTER_API_KEY"]);
  assert.deepEqual(jira.variables.sort(), ["JIRA_BASE_URL", "JIRA_EMAIL"]);
});

/** A scope check with no tracker could only ever fail; say so, don't write it. */
test("with no tracker the scope check is blocked with a reason, but PR-Agent still runs", async () => {
  const result = await planPrChecks(stubClient(), { ...ON, environments: { dev: {} } }, { provider: null });
  assert.deepEqual(result.files.map((f) => f.path), [PR_AGENT_WORKFLOW_PATH]);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0].reason, /taskSync is off/);
});

test("with no environments the scope check is blocked rather than rendered", async () => {
  const result = await planPrChecks(stubClient(), { ...ON, environments: {} }, { provider: "clickup" });
  assert.ok(!result.files.some((f) => f.path === SCOPE_CHECK_WORKFLOW_PATH));
  assert.match(result.blocked[0].reason, /no environment branches/);
});

test("an unchanged file is recognised, so a re-run is quiet", async () => {
  const content = renderPrAgentWorkflow({ prAgent: checks.prAgent });
  const result = await planPrChecks(
    stubClient({ [PR_AGENT_WORKFLOW_PATH]: content }),
    { prChecks: { prAgent: { enabled: true } }, environments: { dev: {} } },
    { provider: "clickup" },
  );
  assert.equal(result.files[0].action, "unchanged");
  assert.equal(result.files[0].adopting, false);
});

/**
 * Overwriting a hand-written workflow is a reasonable thing to ask for, but
 * never a reasonable thing to do silently — the plan has to say it.
 */
test("replacing a file the plugin did not write is flagged as adoption", async () => {
  const result = await planPrChecks(
    stubClient({ [PR_AGENT_WORKFLOW_PATH]: "name: my own hand-written reviewer\non: push\n" }),
    { prChecks: { prAgent: { enabled: true } }, environments: { dev: {} } },
    { provider: "clickup" },
  );
  assert.equal(result.files[0].action, "update");
  assert.equal(result.files[0].adopting, true);
});

// --- orphans -----------------------------------------------------------------------

test("turning a check off plans its generated files for removal", async () => {
  const generated = `${GENERATED_MARKER}\nname: PR Agent Review\n`;
  const orphans = await planPrCheckOrphans(stubClient({ [PR_AGENT_WORKFLOW_PATH]: generated }), []);
  assert.deepEqual(orphans.map((o) => o.path), [PR_AGENT_WORKFLOW_PATH]);
});

/** The same ownership rule as everywhere else: never delete someone else's file. */
test("a hand-written file at a managed path is never removed", async () => {
  const orphans = await planPrCheckOrphans(
    stubClient({ [PR_AGENT_WORKFLOW_PATH]: "name: mine\non: push\n" }),
    [],
  );
  assert.deepEqual(orphans, []);
});

test("a file still planned is never treated as an orphan", async () => {
  const generated = `${GENERATED_MARKER}\nname: PR Agent Review\n`;
  const orphans = await planPrCheckOrphans(stubClient({ [PR_AGENT_WORKFLOW_PATH]: generated }), [
    PR_AGENT_WORKFLOW_PATH,
  ]);
  assert.deepEqual(orphans, []);
});

test("the .mjs script is matched by its own comment-syntax marker", async () => {
  const generated = `${GENERATED_MARKER_JS}\nconsole.log(1);\n`;
  const orphans = await planPrCheckOrphans(stubClient({ [SCOPE_CHECK_SCRIPT_PATH]: generated }), []);
  assert.deepEqual(orphans.map((o) => o.path), [SCOPE_CHECK_SCRIPT_PATH]);
});
