import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  refMatches,
  rulesetCovers,
  blockingRulesets,
  missingEnvironments,
  planBranches,
  createMissingBranches,
  withRelaxedEnforcement,
} from "../src/branches.js";

const BASELINE = {
  id: 1,
  name: "Pull Request Compulsion",
  enforcement: "active",
  rules: [{ type: "deletion" }, { type: "pull_request" }],
  conditions: {
    ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/dev", "refs/heads/prod"], exclude: [] },
  },
};

const NOMENCLATURE = {
  id: 2,
  name: "Enforce Branch Nomenclature",
  enforcement: "active",
  rules: [{ type: "creation" }],
  conditions: {
    ref_name: {
      include: ["~ALL"],
      exclude: ["refs/heads/dev", "refs/heads/prod", "refs/heads/main", "refs/heads/feature/CU-*/**"],
    },
  },
};

// --- glob compilation --------------------------------------------------------

test("a single star does not cross a path separator", () => {
  const re = globToRegExp("refs/heads/feature/*");
  assert.ok(re.test("refs/heads/feature/thing"));
  assert.ok(!re.test("refs/heads/feature/a/b"));
});

test("a double star crosses separators", () => {
  const re = globToRegExp("refs/heads/feature/**");
  assert.ok(re.test("refs/heads/feature/a/b/c"));
});

/**
 * Regression: replacing `**` and then `*` corrupts the first substitution, so
 * nested branches stop matching. This is the bug in the original design.
 */
test("a mixed pattern still matches nested refs", () => {
  const re = globToRegExp("refs/heads/feature/CU-*/**");
  assert.ok(re.test("refs/heads/feature/CU-123/api"));
  assert.ok(re.test("refs/heads/feature/CU-123/api/v2"));
});

test("regex metacharacters in a pattern are escaped, not interpreted", () => {
  const re = globToRegExp("refs/heads/v1.0");
  assert.ok(re.test("refs/heads/v1.0"));
  assert.ok(!re.test("refs/heads/v1x0"), "the dot must be literal");
});

test("a pattern is anchored at both ends", () => {
  const re = globToRegExp("refs/heads/dev");
  assert.ok(!re.test("refs/heads/dev-two"));
  assert.ok(!re.test("x/refs/heads/dev"));
});

// --- alias resolution --------------------------------------------------------

test("~ALL matches anything and ~DEFAULT_BRANCH only the default", () => {
  assert.ok(refMatches("~ALL", "refs/heads/anything", "main"));
  assert.ok(refMatches("~DEFAULT_BRANCH", "refs/heads/main", "main"));
  assert.ok(!refMatches("~DEFAULT_BRANCH", "refs/heads/dev", "main"));
});

// --- coverage ----------------------------------------------------------------

test("an exclusion beats an inclusion", () => {
  assert.equal(rulesetCovers(NOMENCLATURE, "refs/heads/dev", "main"), false);
  assert.equal(rulesetCovers(NOMENCLATURE, "refs/heads/staging", "main"), true);
});

test("the baseline covers the environments it names", () => {
  assert.equal(rulesetCovers(BASELINE, "refs/heads/dev", "main"), true);
  assert.equal(rulesetCovers(BASELINE, "refs/heads/test", "main"), false);
});

// --- identifying blockers ----------------------------------------------------

/** The empirically confirmed case: creating dev is refused by the baseline. */
test("the baseline blocks creating an environment branch it guards", () => {
  const blocked = blockingRulesets([BASELINE, NOMENCLATURE], ["refs/heads/dev"], "main");
  assert.deepEqual(blocked.map((r) => r.name), ["Pull Request Compulsion"]);
});

test("nomenclature blocks a brand-new environment it has not been told about", () => {
  const blocked = blockingRulesets([BASELINE, NOMENCLATURE], ["refs/heads/staging"], "main");
  assert.deepEqual(blocked.map((r) => r.name), ["Enforce Branch Nomenclature"]);
});

test("a ruleset already in evaluate mode needs no relaxing", () => {
  const evaluating = { ...BASELINE, enforcement: "evaluate" };
  assert.deepEqual(blockingRulesets([evaluating], ["refs/heads/dev"], "main"), []);
});

test("a ruleset with only non-blocking rules is left alone", () => {
  const harmless = { ...BASELINE, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };
  assert.deepEqual(blockingRulesets([harmless], ["refs/heads/dev"], "main"), []);
});

// --- what is missing ---------------------------------------------------------

test("only absent environments are reported, in config order", () => {
  assert.deepEqual(missingEnvironments(["dev", "test", "prod"], ["main", "test"]), ["dev", "prod"]);
  assert.deepEqual(missingEnvironments(["dev"], ["dev", "main"]), []);
});

// --- planning and applying ---------------------------------------------------

function stubClient({ branches = ["main"], rulesets = [], failOn = [] } = {}) {
  const calls = { created: [], enforcement: [] };
  return {
    calls,
    listBranches: async () => branches,
    fullRulesets: async () => rulesets,
    refSha: async () => "abc123",
    setEnforcement: async (rs, mode) => calls.enforcement.push(`${rs.id}:${mode}`),
    createRef: async (ref, sha) => {
      const name = ref.replace("refs/heads/", "");
      if (failOn.includes(name)) throw new Error("Reference update failed");
      calls.created.push({ ref, sha });
    },
  };
}

test("planning a fresh repo finds every environment missing and nothing blocking", async () => {
  const result = await planBranches(stubClient(), ["dev", "test", "prod"], "main");
  assert.deepEqual(result.missing, ["dev", "test", "prod"]);
  assert.deepEqual(result.blocked, []);
});

test("planning a synced repo identifies the ruleset that must be relaxed", async () => {
  const client = stubClient({ rulesets: [BASELINE, NOMENCLATURE] });
  const result = await planBranches(client, ["dev"], "main");
  assert.deepEqual(result.blocked.map((r) => r.name), ["Pull Request Compulsion"]);
});

test("nothing missing means the rulesets are never even listed", async () => {
  const client = stubClient({ branches: ["main", "dev"] });
  client.fullRulesets = async () => assert.fail("must not list rulesets when nothing is missing");
  assert.deepEqual((await planBranches(client, ["dev"], "main")).missing, []);
});

test("branches are created from the default branch head", async () => {
  const client = stubClient();
  const results = await createMissingBranches(client, ["dev", "test"], "main");

  assert.deepEqual(client.calls.created, [
    { ref: "refs/heads/dev", sha: "abc123" },
    { ref: "refs/heads/test", sha: "abc123" },
  ]);
  assert.deepEqual(results.map((r) => r.status), ["created", "created"]);
});

test("one branch failing to create does not stop the others", async () => {
  const client = stubClient({ failOn: ["dev"] });
  const results = await createMissingBranches(client, ["dev", "test"], "main");
  assert.deepEqual(results.map((r) => r.status), ["failed", "created"]);
});

test("an empty repository fails with instructions rather than a bare 404", async () => {
  const client = stubClient();
  client.refSha = async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  };
  await assert.rejects(() => createMissingBranches(client, ["dev"], "main"), /no commits/);
});

test("no missing branches means no writes at all", async () => {
  const client = stubClient();
  assert.deepEqual(await createMissingBranches(client, [], "main"), []);
  assert.deepEqual(client.calls.created, []);
});

// --- the relax window ----------------------------------------------------------

test("the window relaxes before the work and restores after it", async () => {
  const client = stubClient();
  const order = [];
  const { restoreFailures } = await withRelaxedEnforcement(client, [BASELINE], async () => {
    order.push(...client.calls.enforcement, "work");
  });

  assert.deepEqual(order, ["1:disabled", "work"]);
  assert.deepEqual(client.calls.enforcement, ["1:disabled", "1:active"]);
  assert.deepEqual(restoreFailures, []);
});

/** The property that matters most: a failure must not leave the repo open. */
test("enforcement is restored even when the work throws", async () => {
  const client = stubClient();
  await assert.rejects(
    () =>
      withRelaxedEnforcement(client, [BASELINE], async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.deepEqual(client.calls.enforcement, ["1:disabled", "1:active"]);
});

/** One failed restore must not abandon the other rulesets at 'evaluate'. */
test("a restore failure on one ruleset does not stop the other restores", async () => {
  const other = { ...BASELINE, id: 9, name: "Other Guard" };
  const client = stubClient();
  client.setEnforcement = async (rs, mode) => {
    client.calls.enforcement.push(`${rs.id}:${mode}`);
    if (mode === "active" && rs.id === 1) throw new Error("restore refused");
  };

  const { restoreFailures } = await withRelaxedEnforcement(client, [BASELINE, other], async () => {});

  assert.deepEqual(restoreFailures, [{ name: "Pull Request Compulsion", error: "restore refused" }]);
  assert.ok(client.calls.enforcement.includes("9:active"), "the second ruleset must still be restored");
});

test("an empty blocked list opens no window and still runs the work", async () => {
  const client = stubClient();
  let ran = false;
  await withRelaxedEnforcement(client, [], async () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.deepEqual(client.calls.enforcement, []);
});

// --- guarding the default-branch write ------------------------------------------

test("a pending workflow write pulls the default-branch guards into the window", async () => {
  // Nothing missing, but the write to main is pending — the baseline guards main.
  const client = stubClient({ branches: ["main", "dev", "prod"], rulesets: [BASELINE, NOMENCLATURE] });
  const result = await planBranches(client, ["dev", "prod"], "main", { guardDefaultBranchWrite: true });

  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.blocked.map((r) => r.name), ["Pull Request Compulsion"]);
});

test("without a pending write, nothing missing still means no ruleset listing", async () => {
  const client = stubClient({ branches: ["main", "dev"] });
  client.fullRulesets = async () => assert.fail("must not list rulesets when nothing needs the window");
  assert.deepEqual(await planBranches(client, ["dev"], "main"), { missing: [], blocked: [] });
});

test("restore failures ride along when the work throws, instead of vanishing", async () => {
  const client = stubClient();
  client.setEnforcement = async (rs, mode) => {
    client.calls.enforcement.push(`${rs.id}:${mode}`);
    if (mode === "active") throw new Error("restore refused");
  };

  await assert.rejects(
    () =>
      withRelaxedEnforcement(client, [BASELINE], async () => {
        throw new Error("boom");
      }),
    (error) => {
      assert.match(error.message, /boom/);
      assert.deepEqual(error.restoreFailures, [
        { name: "Pull Request Compulsion", error: "restore refused" },
      ]);
      return true;
    },
  );
});
