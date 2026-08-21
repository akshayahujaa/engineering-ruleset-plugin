/**
 * Reading credentials from a secret manager.
 *
 * The value must never enter this process, and no config value may become shell
 * code. Both are properties of the command that gets built, so the command is
 * what these tests assert — plus the failure path, because a fetch that fails
 * must not write an empty secret over a good one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSecretsSource,
  resolveSourceName,
  plannedFetches,
  pipelineArgv,
  pushCredential,
  noSourceAccessMessage,
  SOURCE_PROVIDERS,
} from "../src/secretsource.js";

const SOURCE = normalizeSecretsSource({
  secretsSource: { provider: "gcp-secret-manager", project: "tehvault-platform" },
});

// --- configuration ----------------------------------------------------------------

test("absent or disabled means the feature is simply off", () => {
  assert.equal(normalizeSecretsSource({}), null);
  assert.equal(normalizeSecretsSource({ secretsSource: { enabled: false } }), null);
});

test("gcp is the default provider, and latest is the default version", () => {
  const s = normalizeSecretsSource({ secretsSource: { project: "p" } });
  assert.equal(s.provider, "gcp-secret-manager");
  assert.equal(s.version, "latest", "a rotation should take effect without editing configs");
  assert.equal(s.label, "Google Secret Manager");
});

test("an unknown provider is refused by name rather than ignored", () => {
  assert.throws(
    () => normalizeSecretsSource({ secretsSource: { provider: "vault" } }),
    /Unknown secretsSource provider 'vault'/,
  );
});

test("a GitHub secret name maps to a manager id by convention, overridable", () => {
  assert.equal(resolveSourceName("CLICKUP_TOKEN", SOURCE), "clickup-token");
  assert.equal(resolveSourceName("JIRA_BASE_URL", SOURCE), "jira-base-url");

  const mapped = normalizeSecretsSource({ secretsSource: { mapping: { CLICKUP_TOKEN: "cu-prod" } } });
  assert.equal(resolveSourceName("CLICKUP_TOKEN", mapped), "cu-prod", "an explicit mapping wins");
  assert.equal(resolveSourceName("OPENROUTER_API_KEY", mapped), "openrouter-api-key", "others still derive");
});

test("secrets and variables are planned separately, because they are written differently", () => {
  assert.deepEqual(plannedFetches(SOURCE, { secrets: ["CLICKUP_TOKEN"], variables: ["JIRA_EMAIL"] }), [
    { name: "CLICKUP_TOKEN", sourceName: "clickup-token", kind: "secret" },
    { name: "JIRA_EMAIL", sourceName: "jira-email", kind: "variable" },
  ]);
  assert.deepEqual(plannedFetches(SOURCE, {}), []);
});

// --- the command, which is where the guarantees live ------------------------------

/**
 * The value goes gcloud → gh through a kernel pipe in ONE shell. Piping it
 * through Node instead would put the plaintext in this process's heap, which is
 * exactly what the hidden-prompt design exists to avoid.
 */
test("fetch and write are one shell joined by a pipe, with pipefail", () => {
  const { command, args } = pipelineArgv({
    name: "CLICKUP_TOKEN",
    sourceName: "clickup-token",
    kind: "secret",
    repo: "o/r",
    source: SOURCE,
  });

  assert.equal(command, "/bin/bash", "pipefail is not POSIX, so not /bin/sh");
  const script = args[1];
  assert.match(script, /^set -o pipefail;/, "a failed fetch must fail the pipeline");
  assert.match(script, /\|\s*gh "\$WRITE_KIND" set/);
});

/**
 * The regression this exists for: a project or secret name containing shell
 * metacharacters must be DATA. The script text is a constant and every value
 * arrives via env or argv, so there is nothing to interpolate into.
 */
test("no config value is interpolated into the script", () => {
  const hostile = normalizeSecretsSource({
    secretsSource: { project: "p; echo PWNED", mapping: { X: "$(whoami)" } },
  });
  const { args, env } = pipelineArgv({
    name: "X",
    sourceName: resolveSourceName("X", hostile),
    kind: "secret",
    repo: "o/r; rm -rf /",
    source: hostile,
  });

  const script = args[1];
  for (const bad of ["PWNED", "whoami", "rm -rf"]) {
    assert.ok(!script.includes(bad), `'${bad}' must not reach the script text`);
  }
  assert.ok(args.includes("--project=p; echo PWNED"), "it travels as one argument instead");
  assert.equal(env.TARGET_REPO, "o/r; rm -rf /", "and the repo as one env value");
});

test("a variable is written with gh variable set, a secret with gh secret set", () => {
  const asVar = pipelineArgv({ name: "JIRA_EMAIL", sourceName: "jira-email", kind: "variable", repo: "o/r", source: SOURCE });
  const asSecret = pipelineArgv({ name: "JIRA_API_TOKEN", sourceName: "jira-api-token", kind: "secret", repo: "o/r", source: SOURCE });

  assert.equal(asVar.env.WRITE_KIND, "variable");
  assert.equal(asSecret.env.WRITE_KIND, "secret");
});

test("the version and project reach gcloud as flags, not as script text", () => {
  const pinned = normalizeSecretsSource({ secretsSource: { project: "proj", version: "7" } });
  const { args } = pipelineArgv({ name: "N", sourceName: "n", kind: "secret", repo: "o/r", source: pinned });

  assert.deepEqual(args.slice(3), ["secrets", "versions", "access", "7", "--secret=n", "--project=proj"]);
});

test("with no project configured, gcloud is left to use its own default", () => {
  const noProject = normalizeSecretsSource({ secretsSource: {} });
  const { args } = pipelineArgv({ name: "N", sourceName: "n", kind: "secret", repo: "o/r", source: noProject });
  assert.ok(!args.some((a) => a.startsWith("--project=")));
});

// --- failure ----------------------------------------------------------------------

/**
 * The worst outcome would be reporting success after a failed fetch: gh would
 * have written an empty secret over a working one. pipefail prevents it; this
 * asserts the reporting.
 */
test("a failed fetch is reported, and never as success", () => {
  const run = () => ({ status: 1, stderr: "ERROR: NOT_FOUND: Secret [clickup-token] not found." });
  const result = pushCredential(
    { name: "CLICKUP_TOKEN", sourceName: "clickup-token", kind: "secret", repo: "o/r", source: SOURCE },
    run,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /'clickup-token' was not found in Google Secret Manager \(project tehvault-platform\)/);
});

test("any other failure is passed through as the tool reported it", () => {
  const run = () => ({ status: 1, stderr: "PERMISSION_DENIED: caller lacks secretmanager.versions.access" });
  const result = pushCredential(
    { name: "X", sourceName: "x", kind: "secret", repo: "o/r", source: SOURCE },
    run,
  );
  assert.match(result.error, /PERMISSION_DENIED/, "a permissions problem needs a different fix from a missing secret");
});

/** stdout is discarded, so a failure cannot echo the value it failed to write. */
test("the value is never captured, even to report a failure", () => {
  let opts;
  pushCredential({ name: "X", sourceName: "x", kind: "secret", repo: "o/r", source: SOURCE }, (_c, _a, o) => {
    opts = o;
    return { status: 0 };
  });
  assert.deepEqual(opts.stdio, ["ignore", "ignore", "pipe"], "stdin ignored, stdout discarded, stderr only");
});

test("success is reported without any value in it", () => {
  const result = pushCredential(
    { name: "X", sourceName: "x", kind: "secret", repo: "o/r", source: SOURCE },
    () => ({ status: 0, stdout: "SUPER-SECRET" }),
  );
  assert.deepEqual(result, { name: "X", ok: true });
});

// --- preconditions ----------------------------------------------------------------

test("a missing CLI and a missing login read differently, because the fixes differ", () => {
  const notInstalled = noSourceAccessMessage(SOURCE, { installed: false });
  assert.match(notInstalled, /not installed/);
  assert.match(notInstalled, /cloud\.google\.com\/sdk/);

  const notLoggedIn = noSourceAccessMessage(SOURCE, { installed: true });
  assert.match(notLoggedIn, /no active login/);
  assert.match(notLoggedIn, /gcloud auth login/);
  assert.match(notLoggedIn, /never run for you/, "an OAuth flow a pipe cannot answer");
});

test("the provider table only claims what it can do", () => {
  assert.deepEqual(Object.keys(SOURCE_PROVIDERS), ["gcp-secret-manager"]);
});
