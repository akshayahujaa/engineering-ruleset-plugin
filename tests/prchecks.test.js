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
  renderTrivyWorkflow,
  TRIVY_WORKFLOW_PATH,
  TRIVY_SCRIPT_PATH,
  TRIVY_CONTEXT,
  renderStrixWorkflow,
  STRIX_WORKFLOW_PATH,
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

test("ClickUp, Jira, and Kaneo wire only their own credentials", () => {
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

  const kaneo = envOf("kaneo");
  assert.equal(kaneo.ISSUE_PROVIDER, "kaneo");
  assert.equal(kaneo.KANEO_API_URL, "${{ vars.KANEO_API_URL }}");
  assert.equal(kaneo.KANEO_PROJECT_ID, "${{ vars.KANEO_PROJECT_ID }}");
  assert.equal(kaneo.KANEO_API_TOKEN, "${{ secrets.KANEO_API_TOKEN }}");
  assert.equal(kaneo.JIRA_API_TOKEN, undefined);
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

test("the script supports all three trackers, so one file serves any provider", () => {
  const script = renderScopeCheckScript();
  assert.match(script, /getClickUpTask/);
  assert.match(script, /getJiraTask/);
  assert.match(script, /getKaneoTask/);
  assert.match(script, /KANEO_PROJECT_ID/);
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

  const kaneo = await planPrChecks(stubClient(), { ...ON, environments: { dev: {} } }, { provider: "kaneo" });
  assert.deepEqual(kaneo.secrets.sort(), ["KANEO_API_TOKEN", "OPENROUTER_API_KEY"]);
  assert.deepEqual(kaneo.variables.sort(), ["KANEO_API_URL", "KANEO_PROJECT_ID"]);
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

// --- the Trivy security scan -----------------------------------------------------

const TRIVY_ON = { environments: { dev: {}, prod: {} }, prChecks: { trivy: { enabled: true } } };

test("trivy is off unless configured, and its defaults are a complete config", () => {
  assert.equal(normalizePrChecks({}).trivy.enabled, false);

  const t = normalizePrChecks(TRIVY_ON).trivy;
  assert.deepEqual(t.blockOn, ["CRITICAL"], "CRITICAL blocks by default");
  assert.deepEqual(t.severities, ["CRITICAL", "HIGH", "MEDIUM"], "HIGH and MEDIUM are still reported");
  assert.equal(t.blockScope, "changed-files");
  assert.equal(t.ignoreUnfixed, true);
  assert.equal(t.statusCheck, "trivy-security");
  assert.equal(t.rulesetName, "TRIVY-SECURITY");
});

test("the workflow's job id IS the required status-check context", () => {
  // Renaming one without the other leaves a required check waiting forever.
  const trivy = normalizePrChecks(TRIVY_ON).trivy;
  const yaml = renderTrivyWorkflow({ environments: ["dev"], trivy });

  assert.match(yaml, new RegExp(`^  ${trivy.statusCheck}:$`, "m"));
  assert.equal(trivy.statusCheck, TRIVY_CONTEXT);
});

test("the scan triggers on pull requests targeting every declared environment", () => {
  const yaml = renderTrivyWorkflow({
    environments: ["dev", "test", "prod"],
    trivy: normalizePrChecks(TRIVY_ON).trivy,
  });
  for (const env of ["dev", "test", "prod"]) assert.ok(yaml.includes(`      - '${env}'`), env);
});

test("the checkout is deep, because the changed-file list needs history", () => {
  const yaml = renderTrivyWorkflow({ environments: ["dev"], trivy: normalizePrChecks(TRIVY_ON).trivy });
  assert.match(yaml, /fetch-depth: 0/);
});

/**
 * The scan step must not be the gate. Trivy exits non-zero when it finds
 * anything, which would fail the job before the author is told what was found —
 * and would ignore the threshold and scope entirely.
 */
test("the scan step cannot fail the job; the report script decides", () => {
  const yaml = renderTrivyWorkflow({ environments: ["dev"], trivy: normalizePrChecks(TRIVY_ON).trivy });
  assert.match(yaml, /continue-on-error: true/);
  assert.match(yaml, /run: node \.github\/scripts\/trivy-report\.mjs/);
});

/**
 * The regression this exists for: the pin was shipped as `@0.28.0`, and every
 * run failed with "unable to find version 0.28.0" — aquasecurity tags releases
 * v-PREFIXED. The original test asserted only `\d+\.\d+\.\d+`, so it matched
 * the broken value and gave false confidence. The `v` is the whole point.
 */
test("the action is pinned to a v-prefixed release, not a moving branch", () => {
  const trivy = normalizePrChecks(TRIVY_ON).trivy;
  const yaml = renderTrivyWorkflow({ environments: ["dev"], trivy });

  assert.match(trivy.actionVersion, /^v\d+\.\d+\.\d+$/, "the default tag must carry the v");
  assert.match(yaml, new RegExp(`aquasecurity/trivy-action@${trivy.actionVersion}$`, "m"));
  assert.doesNotMatch(yaml, /trivy-action@(main|master)/, "a gate must not change on someone else's push");
});

test("the pinned version can be overridden without a plugin release", () => {
  const trivy = { ...normalizePrChecks(TRIVY_ON).trivy, actionVersion: "v0.35.0" };
  assert.match(renderTrivyWorkflow({ environments: ["dev"], trivy }), /trivy-action@v0\.35\.0$/m);
});

test("the threshold and scope reach the script as environment values", () => {
  const trivy = { ...normalizePrChecks(TRIVY_ON).trivy, blockOn: ["CRITICAL", "HIGH"], blockScope: "repository" };
  const yaml = renderTrivyWorkflow({ environments: ["dev"], trivy });

  assert.match(yaml, /BLOCK_ON: "CRITICAL,HIGH"/);
  assert.match(yaml, /BLOCK_SCOPE: "repository"/);
  assert.match(yaml, /severity: 'CRITICAL,HIGH,MEDIUM'/, "Trivy still looks wider than it blocks");
});

test("no environments means no workflow, and the plan says why", async () => {
  const client = stubClient({});
  const plan = await planPrChecks(client, { environments: {}, prChecks: { trivy: { enabled: true } } }, { provider: null });

  assert.deepEqual(plan.files, []);
  assert.ok(plan.blocked.some((b) => b.what === TRIVY_WORKFLOW_PATH && /nothing for it to trigger on/.test(b.reason)));
});

test("both trivy files are planned, and the policy rides along for the plan to print", async () => {
  const client = stubClient({});
  const plan = await planPrChecks(client, TRIVY_ON, { provider: null });

  assert.deepEqual(plan.files.map((f) => f.path), [TRIVY_WORKFLOW_PATH, TRIVY_SCRIPT_PATH]);
  assert.ok(plan.files.every((f) => f.action === "create"));
  assert.deepEqual(plan.trivy.blockOn, ["CRITICAL"]);
  assert.deepEqual(plan.secrets, [], "Trivy needs no secret — it pulls its database with the workflow token");
});

test("turning trivy off removes the files it wrote, and only those", async () => {
  const client = stubClient({
    [TRIVY_WORKFLOW_PATH]: `${GENERATED_MARKER} ...`,
    [TRIVY_SCRIPT_PATH]: `${GENERATED_MARKER_JS} ...`,
  });
  const orphans = await planPrCheckOrphans(client, []);
  assert.deepEqual(orphans.map((o) => o.path).sort(), [TRIVY_SCRIPT_PATH, TRIVY_WORKFLOW_PATH].sort());
});

test("a hand-written file at a trivy path is adopted loudly, never deleted", async () => {
  const client = stubClient({ [TRIVY_WORKFLOW_PATH]: "name: our own trivy\n" });

  const plan = await planPrChecks(client, TRIVY_ON, { provider: null });
  assert.equal(plan.files.find((f) => f.path === TRIVY_WORKFLOW_PATH).adopting, true);

  const orphans = await planPrCheckOrphans(client, []);
  assert.deepEqual(orphans, [], "without the marker it is not ours to remove");
});

test("the generated script is the plugin's asset, marked as generated", async () => {
  const client = stubClient({});
  const plan = await planPrChecks(client, TRIVY_ON, { provider: null });
  const script = plan.files.find((f) => f.path === TRIVY_SCRIPT_PATH);

  assert.ok(script.content.startsWith(GENERATED_MARKER_JS));
  assert.match(script.content, /export function isBlocking/, "the real logic, copied verbatim");
});

// --- the Strix pentest, on manual trigger ----------------------------------------

const STRIX_ON = { environments: { dev: {} }, prChecks: { strix: { enabled: true } } };
const strixYaml = () => renderStrixWorkflow({ strix: normalizePrChecks(STRIX_ON).strix });

test("strix is off unless configured, and its defaults are a complete config", () => {
  assert.equal(normalizePrChecks({}).strix.enabled, false);

  const s = normalizePrChecks(STRIX_ON).strix;
  assert.match(s.model, /^openrouter\//, "a LiteLLM model id, which is what STRIX_LLM takes");
  assert.match(s.model, /:free$/, "the default is a free tier");
  assert.equal(s.keySecret, "OPENROUTER_API_KEY", "reuses the key the other checks read");
  assert.equal(s.scanMode, "quick");
  assert.match(s.packageVersion, /^\d+\.\d+\.\d+$/, "pinned to an exact release");
  assert.ok(Number(s.pythonVersion) >= 3.12, "strix-agent requires >= 3.12");
});

/**
 * Manual by design, not by omission: an agent run takes minutes and many model
 * calls. Nothing requires the check, so no ruleset is involved and it cannot
 * wedge a merge — which is the whole reason it needs no compiler support.
 */
test("it triggers only on workflow_dispatch — never a pull request", () => {
  const doc = parseYaml(strixYaml());
  assert.deepEqual(Object.keys(triggers(doc)), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(doc.jobs), ["strix-pentest"]);
  assert.deepEqual(doc.permissions, { contents: "read" });
});

test("the dispatch form offers target, depth, focus and a diff base", () => {
  const inputs = triggers(parseYaml(strixYaml())).workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["target", "scan_mode", "instruction", "diff_base"]);
  assert.deepEqual(inputs.scan_mode.options, ["quick", "standard", "deep"]);
});

/**
 * The regression that matters most here. `${{ … }}` is substituted BEFORE the
 * shell runs, so an input interpolated into a run block executes as code. In a
 * security tool that is indefensible — every input arrives through env instead.
 */
test("no dispatch input is interpolated into a script body", () => {
  const doc = parseYaml(strixYaml());
  for (const step of doc.jobs["strix-pentest"].steps) {
    if (!step.run) continue;
    assert.doesNotMatch(step.run, /\$\{\{/, `${step.name} must not expand a template into the shell`);
    assert.doesNotMatch(step.run, /\beval\b/, `${step.name} must not eval`);
  }
});

test("the inputs reach the agent as env, and the command is built as an argv array", () => {
  const step = parseYaml(strixYaml()).jobs["strix-pentest"].steps.find((s) => s.id === "strix");

  assert.deepEqual(Object.keys(step.env), [
    "STRIX_LLM",
    "LLM_API_KEY",
    "INPUT_TARGET",
    "INPUT_SCAN_MODE",
    "INPUT_INSTRUCTION",
    "INPUT_DIFF_BASE",
  ]);
  assert.match(step.run, /args=\(-n --target "\$\{INPUT_TARGET:-\.\/\}"/, "an array, not a string");
  assert.match(step.run, /strix "\$\{args\[@\]\}"/, "expanded as separate words");
});

test("a missing key is reported rather than silently producing an empty scan", () => {
  const step = parseYaml(strixYaml()).jobs["strix-pentest"].steps.find((s) => s.id === "strix");
  assert.match(step.run, /OPENROUTER_API_KEY is not set/);
});

/**
 * A half-finished agent still carries findings. Losing them is worse than the
 * failure, so the upload runs regardless — and the job's result still follows
 * the agent's, or a rate-limited run would read as a clean pass.
 */
test("findings upload even when the agent fails, and the job still fails", () => {
  const steps = parseYaml(strixYaml()).jobs["strix-pentest"].steps;
  const strixStep = steps.find((s) => s.id === "strix");
  const upload = steps.find((s) => s.name === "Upload findings");
  const reflect = steps.at(-1);

  assert.equal(strixStep["continue-on-error"], true);
  assert.equal(upload.if, "always()");
  assert.match(upload.uses, /actions\/upload-artifact@v\d+/);
  assert.match(reflect.if, /steps\.strix\.outcome != 'success'/);
  assert.equal(reflect.run.trim(), "exit 1");
});

test("it is installed pinned from PyPI, not piped from a URL into a shell", () => {
  const install = parseYaml(strixYaml()).jobs["strix-pentest"].steps.find((s) => s.name === "Install Strix");
  assert.match(install.run, /pip install .*strix-agent==\d+\.\d+\.\d+/);
  assert.doesNotMatch(install.run, /curl.*\|\s*bash/, "a security tool is not installed by curl | bash");
});

test("the run is time-bounded, so one stuck agent cannot burn hours", () => {
  assert.equal(parseYaml(strixYaml()).jobs["strix-pentest"]["timeout-minutes"], 45);
});

test("it is planned as one file, needs the shared AI key, and is cleaned up when off", async () => {
  const plan = await planPrChecks(stubClient(), STRIX_ON, { provider: null });
  assert.deepEqual(plan.files.map((f) => f.path), [STRIX_WORKFLOW_PATH]);
  assert.deepEqual(plan.secrets, ["OPENROUTER_API_KEY"], "no new secret is introduced");

  const client = stubClient({ [STRIX_WORKFLOW_PATH]: `${GENERATED_MARKER} ...` });
  assert.deepEqual((await planPrCheckOrphans(client, [])).map((o) => o.path), [STRIX_WORKFLOW_PATH]);
});
