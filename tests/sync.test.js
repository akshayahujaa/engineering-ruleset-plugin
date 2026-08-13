import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, apply, isUnchanged } from "../src/sync.js";
import { parseRemote, parseSlug } from "../src/github.js";

const RULESET = {
  name: "Pull Request Compulsion",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/dev"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 0 } }],
};

/** Stub standing in for the REST client; records what would be written. */
function stubClient({ existing = [], full = {}, failOn = null } = {}) {
  const calls = { created: [], updated: [] };
  return {
    calls,
    listRulesets: async () => existing,
    getRuleset: async (id) => full[id],
    createRuleset: async (payload) => {
      if (failOn === payload.name) throw Object.assign(new Error("422 Unprocessable"), { body: {} });
      calls.created.push(payload);
    },
    updateRuleset: async (id, payload) => {
      calls.updated.push({ id, payload });
    },
  };
}

test("an empty repository plans a create for every ruleset", async () => {
  const { steps, undeclared } = await plan(stubClient(), [RULESET]);
  assert.deepEqual(steps.map((s) => s.action), ["create"]);
  assert.deepEqual(undeclared, []);
});

test("a ruleset already matching plans no write", async () => {
  const client = stubClient({ existing: [{ id: 7, name: RULESET.name }], full: { 7: RULESET } });
  const { steps } = await plan(client, [RULESET]);
  assert.deepEqual(steps.map((s) => s.action), ["unchanged"]);
});

test("server-side defaults we never sent are not mistaken for drift", async () => {
  const withDefaults = structuredClone(RULESET);
  withDefaults.rules[1].parameters.dismiss_stale_reviews_on_push = false;
  withDefaults.rules[1].parameters.require_code_owner_review = false;

  const client = stubClient({ existing: [{ id: 7, name: RULESET.name }], full: { 7: withDefaults } });
  const { steps } = await plan(client, [RULESET]);
  assert.deepEqual(steps.map((s) => s.action), ["unchanged"]);
});

test("a drifted ruleset plans an update carrying the existing id", async () => {
  const drifted = structuredClone(RULESET);
  drifted.conditions.ref_name.include = ["~DEFAULT_BRANCH"]; // dev was removed by hand

  const client = stubClient({ existing: [{ id: 7, name: RULESET.name }], full: { 7: drifted } });
  const { steps } = await plan(client, [RULESET]);

  assert.equal(steps[0].action, "update");
  assert.equal(steps[0].id, 7);
});

test("a bypass actor added by hand is reported as drift", async () => {
  const bypassed = structuredClone(RULESET);
  bypassed.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];

  const client = stubClient({ existing: [{ id: 7, name: RULESET.name }], full: { 7: bypassed } });
  const { steps } = await plan(client, [RULESET]);
  assert.equal(steps[0].action, "update");
});

test("rulesets the config does not declare are reported, never deleted", async () => {
  const client = stubClient({ existing: [{ id: 9, name: "hand-made-rule" }] });
  const { steps, undeclared } = await plan(client, [RULESET]);

  assert.deepEqual(undeclared, ["hand-made-rule"]);
  assert.ok(steps.every((s) => s.name !== "hand-made-rule"));
});

test("one rejected ruleset does not stop the others", async () => {
  const client = stubClient({ failOn: "bad" });
  const results = await apply(client, [
    { action: "create", name: "bad", payload: { name: "bad" } },
    { action: "create", name: "good", payload: { name: "good" } },
  ]);

  assert.deepEqual(results.map((r) => r.status), ["failed", "applied"]);
  assert.deepEqual(client.calls.created.map((p) => p.name), ["good"]);
});

test("unchanged steps are skipped rather than rewritten", async () => {
  const client = stubClient();
  const results = await apply(client, [{ action: "unchanged", name: RULESET.name, payload: RULESET }]);

  assert.equal(results[0].status, "skipped");
  assert.equal(client.calls.created.length, 0);
  assert.equal(client.calls.updated.length, 0);
});

test("enforcement flipped to disabled counts as drift", () => {
  assert.equal(isUnchanged(RULESET, { ...RULESET, enforcement: "disabled" }), false);
});

// --- remote parsing ----------------------------------------------------------

for (const [url, expected] of [
  ["https://github.com/akshayahujaa/shop-ui.git", { owner: "akshayahujaa", repo: "shop-ui" }],
  ["https://github.com/akshayahujaa/shop-ui", { owner: "akshayahujaa", repo: "shop-ui" }],
  ["git@github.com:tehvault/frontend-app.git", { owner: "tehvault", repo: "frontend-app" }],
  ["ssh://git@github.com/tehvault/frontend-app.git", { owner: "tehvault", repo: "frontend-app" }],
]) {
  test(`parses remote ${url}`, () => assert.deepEqual(parseRemote(url), expected));
}

test("an unparseable remote fails with the offending url", () => {
  assert.throws(() => parseRemote("not-a-remote"), /not-a-remote/);
});

test("--repo accepts owner/name and rejects anything else", () => {
  assert.deepEqual(parseSlug("tehvault/frontend-app"), { owner: "tehvault", repo: "frontend-app" });
  assert.deepEqual(parseSlug(" akshayahujaa/shop-ui "), { owner: "akshayahujaa", repo: "shop-ui" });
  assert.throws(() => parseSlug("https://github.com/a/b"), /expects 'owner\/name'/);
  assert.throws(() => parseSlug("just-a-name"), /expects 'owner\/name'/);
});
