import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveConfig,
  isMarketplaceClone,
  isValidEnvName,
  parseEnvList,
  OVERRIDE_PATH,
} from "../src/config.js";

/** A directory tree standing in for a checkout, an override, or a plugin root. */
function tempDir(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ruleset-config-test-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const BUNDLED = JSON.stringify({ environments: { dev: {}, test: {}, prod: {} } });
const REMOTE = JSON.stringify({ environments: { dev: {}, uat: {} } });
const LOCAL = JSON.stringify({ environments: { staging: {} } });

function stubClient({ remote = null, error = null } = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    getFile: async (p) => {
      assert.equal(p, OVERRIDE_PATH);
      if (error) throw error;
      return remote === null ? null : { sha: "s", content: remote };
    },
  };
}

// --- the regression: --repo must read the TARGET repo's override --------------

test("--repo mode takes the override from the target repository, not the cwd", async () => {
  // The caller stands in a checkout that HAS an override; it must be ignored.
  const cwd = tempDir({ [OVERRIDE_PATH]: LOCAL });
  const pluginRoot = tempDir({ "ruleset-config.json": BUNDLED });

  const result = await resolveConfig({
    client: stubClient({ remote: REMOTE }),
    repoMode: true,
    cwd,
    pluginRoot,
  });

  assert.equal(result.origin, "remote-override");
  assert.deepEqual(Object.keys(result.config.environments), ["dev", "uat"]);
  assert.match(result.label, /acme\/widgets/);
});

test("--repo mode falls back to the bundled policy when the target has no override", async () => {
  // Even then, the caller's local override must play no part.
  const cwd = tempDir({ [OVERRIDE_PATH]: LOCAL });
  const pluginRoot = tempDir({ "ruleset-config.json": BUNDLED });

  const result = await resolveConfig({ client: stubClient(), repoMode: true, cwd, pluginRoot });

  assert.equal(result.origin, "bundled");
  assert.deepEqual(Object.keys(result.config.environments), ["dev", "test", "prod"]);
});

test("a committed override that is not JSON is a hard failure, not a fallback", async () => {
  const pluginRoot = tempDir({ "ruleset-config.json": BUNDLED });
  await assert.rejects(
    () =>
      resolveConfig({
        client: stubClient({ remote: "{ not json" }),
        repoMode: true,
        cwd: tempDir(),
        pluginRoot,
      }),
    /not valid JSON/,
  );
});

test("a non-404 failure fetching the override propagates untouched", async () => {
  const boom = Object.assign(new Error("HTTP 500"), { status: 500 });
  await assert.rejects(
    () => resolveConfig({ client: stubClient({ error: boom }), repoMode: true, cwd: tempDir() }),
    /HTTP 500/,
  );
});

test("a remote override is never writable", async () => {
  const pluginRoot = tempDir({ "ruleset-config.json": BUNDLED });
  const result = await resolveConfig({
    client: stubClient({ remote: REMOTE }),
    repoMode: true,
    cwd: tempDir(),
    pluginRoot,
  });
  assert.equal(result.writablePath, null);
});

// --- implicit mode -------------------------------------------------------------

test("implicit mode honours the working tree's override, uncommitted edits included", async () => {
  const cwd = tempDir({ [OVERRIDE_PATH]: LOCAL });
  const result = await resolveConfig({ client: stubClient(), repoMode: false, cwd });

  assert.equal(result.origin, "local-override");
  assert.deepEqual(Object.keys(result.config.environments), ["staging"]);
  assert.equal(result.writablePath, path.join(cwd, OVERRIDE_PATH));
});

test("implicit mode without an override uses the bundled policy, writable in place", async () => {
  const pluginRoot = tempDir({ "ruleset-config.json": BUNDLED });
  const result = await resolveConfig({
    client: stubClient(),
    repoMode: false,
    cwd: tempDir(),
    pluginRoot,
  });

  assert.equal(result.origin, "bundled");
  assert.equal(result.writablePath, path.join(pluginRoot, "ruleset-config.json"));
});

test("implicit mode never touches the network", async () => {
  const client = {
    getFile: async () => assert.fail("implicit mode must not fetch the override remotely"),
  };
  const cwd = tempDir({ [OVERRIDE_PATH]: LOCAL });
  const result = await resolveConfig({ client, repoMode: false, cwd });
  assert.equal(result.origin, "local-override");
});

// --- marketplace clone detection ----------------------------------------------

test("a marketplace clone path is recognised, a dev checkout is not", () => {
  assert.equal(
    isMarketplaceClone("/Users/a/.claude/plugins/marketplaces/tehvault-engineering/ruleset-config.json"),
    true,
  );
  assert.equal(isMarketplaceClone("/Users/a/Desktop/engineering-ruleset-plugin/ruleset-config.json"), false);
  assert.equal(isMarketplaceClone(null), false);
});

// --- env name hygiene -----------------------------------------------------------

test("environment names must be usable as branch names", () => {
  for (const good of ["staging", "uat", "pre-prod", "qa2", "release/candidate"]) {
    assert.equal(isValidEnvName(good), true, `expected '${good}' to be valid`);
  }
  for (const bad of ["", "has space", "*", "a..b", "trailing/", "-leadinghyphen", "~x"]) {
    assert.equal(isValidEnvName(bad), false, `expected '${bad}' to be rejected`);
  }
});

test("a comma-separated answer parses into clean names", () => {
  assert.deepEqual(parseEnvList(" staging , uat ,,"), ["staging", "uat"]);
  assert.deepEqual(parseEnvList(""), []);
  assert.deepEqual(parseEnvList(null), []);
});
