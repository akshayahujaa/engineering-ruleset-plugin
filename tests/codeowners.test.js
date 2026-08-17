import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCodeowners,
  parseCodeownerRules,
  readCodeowners,
  inspectCodeowners,
  screenOwners,
  planTeamSeed,
  describeSeed,
  assessCodeownerReview,
  CODEOWNERS_PATHS,
} from "../src/codeowners.js";

/**
 * Stub client. `files` maps a path to its raw content; anything else is a 404,
 * exactly as the real getFile reports an absent file.
 */
function stubClient({ files = {}, teams = {}, members = null, fail = {} } = {}) {
  const calls = { getFile: [], teamMembers: [], orgMembers: 0 };
  return {
    calls,
    async getFile(path) {
      calls.getFile.push(path);
      return files[path] ? { sha: "abc", content: files[path] } : null;
    },
    async teamMembers(org, slug) {
      calls.teamMembers.push(`${org}/${slug}`);
      if (fail.teamMembers) throw new Error(fail.teamMembers);
      return teams[`${org}/${slug}`] ?? [];
    },
    async orgMembers() {
      calls.orgMembers += 1;
      if (members === null) throw new Error("Not Found");
      return members;
    },
  };
}

// --- parsing -------------------------------------------------------------------

test("owners are read from every line, and the path pattern is never one", () => {
  const owners = parseCodeowners(
    ["*               @alice @bob", "/docs/          @carol", "*.js            @acme/frontend"].join("\n"),
  );

  assert.deepEqual(owners.users, ["alice", "bob", "carol"]);
  assert.deepEqual(owners.teams, ["acme/frontend"]);
  assert.deepEqual(owners.emails, []);
});

test("comments and blank lines are ignored, and an escaped # stays in the pattern", () => {
  const owners = parseCodeowners(
    ["# the whole line is a comment", "", "*  @alice  # trailing comment @nobody", "docs\\#1/ @bob"].join("\n"),
  );

  assert.deepEqual(owners.users, ["alice", "bob"], "@nobody was inside a comment");
});

test("a section header carries owners with no pattern in front of them", () => {
  const owners = parseCodeowners(["[Backend] @alice", "^[Frontend][2] @bob @acme/ui", "*.go @carol"].join("\n"));

  assert.deepEqual(owners.users, ["alice", "bob", "carol"]);
  assert.deepEqual(owners.teams, ["acme/ui"]);
});

test("emails and unparseable tokens are kept apart, never mistaken for logins", () => {
  const owners = parseCodeowners(["* dev@acme.com @alice junk @bad/slug/deep"].join("\n"));

  assert.deepEqual(owners.users, ["alice"]);
  assert.deepEqual(owners.emails, ["dev@acme.com"]);
  assert.deepEqual(owners.unresolved, ["junk", "@bad/slug/deep"]);
});

/** GitHub spells a path containing a space `docs\ and\ specs/`; both halves are the pattern. */
test("an escaped space keeps a path in one piece instead of inventing owners", () => {
  const owners = parseCodeowners("docs\\ and\\ specs/ @alice\n");

  assert.deepEqual(owners.users, ["alice"]);
  assert.deepEqual(owners.unresolved, []);
});

test("the same owner named on many lines is counted once", () => {
  const owners = parseCodeowners(["* @alice", "/docs/ @Alice", "/src/ @alice"].join("\n"));
  assert.deepEqual(owners.users, ["alice"]);
});

test("a pattern with no owners contributes nothing", () => {
  assert.deepEqual(parseCodeowners("/generated/\n").users, []);
  assert.deepEqual(parseCodeowners("").users, []);
  assert.deepEqual(parseCodeowners(undefined).users, []);
});

// --- locating the file -----------------------------------------------------------

test("CODEOWNERS is looked for where GitHub looks, in GitHub's order", async () => {
  const client = stubClient({ files: { "docs/CODEOWNERS": "* @alice" } });
  const found = await readCodeowners(client);

  assert.equal(found.path, "docs/CODEOWNERS");
  assert.deepEqual(client.calls.getFile, CODEOWNERS_PATHS);
});

test("the first CODEOWNERS that exists wins, and the rest are not read", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice", "CODEOWNERS": "* @bob" } });
  const found = await readCodeowners(client);

  assert.equal(found.path, ".github/CODEOWNERS");
  assert.deepEqual(found.users, ["alice"]);
  assert.deepEqual(client.calls.getFile, [".github/CODEOWNERS"]);
});

test("a repo with no CODEOWNERS reports none rather than failing", async () => {
  assert.equal(await readCodeowners(stubClient()), null);
});

// --- ownership, pattern by pattern --------------------------------------------------

/**
 * The last pattern matching a file decides who owns it, so "can this path be
 * reviewed by anybody" is a per-pattern question — flattening the file would
 * lose exactly the case that blocks a merge.
 */
test("rules are kept per pattern, in file order", () => {
  const rules = parseCodeownerRules(["* @alice @bob", "/api/ @carol", "# comment"].join("\n"));

  assert.deepEqual(rules, [
    { pattern: "*", owners: ["@alice", "@bob"] },
    { pattern: "/api/", owners: ["@carol"] },
  ]);
});

test("an @org/team owner expands to the people in it", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @alice @acme/platform" },
    teams: { "acme/platform": ["bob", "carol"] },
  });

  const { logins, byPattern } = await inspectCodeowners(client, { org: "acme" });
  assert.deepEqual(logins, ["alice", "bob", "carol"]);
  assert.deepEqual(byPattern[0].owners, ["alice", "bob", "carol"]);
});

test("a team named by several patterns is looked up once", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @acme/platform\n/api/ @acme/platform\n" },
    teams: { "acme/platform": ["bob"] },
  });

  await inspectCodeowners(client, { org: "acme" });
  assert.deepEqual(client.calls.teamMembers, ["acme/platform"]);
});

test("the team being seeded is never expanded into itself", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @acme/reviewers @alice" } });

  const { logins } = await inspectCodeowners(client, { org: "acme", exclude: ["acme/reviewers"] });
  assert.deepEqual(logins, ["alice"]);
  assert.deepEqual(client.calls.teamMembers, [], "no lookup of a team that does not exist yet");
});

test("a team from another org, an email, and junk are all reported, not dropped", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @other/team dev@acme.com @nope/deep/path" },
  });

  const { logins, skipped, byPattern } = await inspectCodeowners(client, { org: "acme" });
  assert.deepEqual(logins, []);
  assert.equal(byPattern[0].unverified.length, 3, "kept against the pattern, not just globally");
  assert.equal(skipped.length, 3);
  assert.match(skipped[0].reason, /is a team of 'other', not 'acme'/);
  assert.match(skipped[1].reason, /email address/);
  assert.match(skipped[2].reason, /not a recognisable/);
});

test("the same bad owner on many lines is reported once", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* dev@acme.com\n/api/ dev@acme.com\n" } });

  const { skipped } = await inspectCodeowners(client, { org: "acme" });
  assert.equal(skipped.length, 1);
});

test("a team whose members cannot be read is reported, and the rest still resolve", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @alice @acme/secret" },
    fail: { teamMembers: "Not Found" },
  });

  const { logins, skipped } = await inspectCodeowners(client, { org: "acme" });
  assert.deepEqual(logins, ["alice"]);
  assert.match(skipped[0].reason, /could not be read/);
});

// --- screening --------------------------------------------------------------------

const SCREEN = {
  repoLabel: "acme/app",
  org: "acme",
  orgMembers: new Set(["alice", "bob", "carol"]),
  pushCapable: ["alice", "bob", "runner"],
  runner: "runner",
};

test("a code owner who can push and is in the org is eligible", () => {
  const { members, skipped } = screenOwners(["alice", "bob"], SCREEN);
  assert.deepEqual(members, ["alice", "bob"]);
  assert.deepEqual(skipped, []);
});

/** An approval from someone without write access does not count, so the seat is useless. */
test("a code owner without write access is skipped, with the reason", () => {
  const { members, skipped } = screenOwners(["alice", "carol"], SCREEN);
  assert.deepEqual(members, ["alice"]);
  assert.match(skipped[0].reason, /no write access to acme\/app/);
});

/**
 * Adding a non-member to a team invites them to the organisation — an email to
 * a real person. That is never sent as a side effect of syncing rulesets.
 */
test("a code owner outside the org is skipped rather than invited to it", () => {
  const { members, skipped } = screenOwners(["dave"], { ...SCREEN, pushCapable: ["dave"] });
  assert.deepEqual(members, []);
  assert.match(skipped[0].reason, /would send them an organisation invitation/);
});

test("an unreadable org member list fails closed, for everyone but the runner", () => {
  const blind = { ...SCREEN, orgMembers: null, pushCapable: ["alice", "runner"] };
  const { members, skipped } = screenOwners(["alice", "runner"], blind);

  assert.deepEqual(members, ["runner"], "adding yourself is not an invitation to somebody else");
  assert.match(skipped[0].reason, /membership cannot be confirmed/);
});

test("an unreadable collaborator list skips the write-access filter instead of rejecting all", () => {
  const { members } = screenOwners(["alice", "carol"], { ...SCREEN, pushCapable: undefined });
  assert.deepEqual(members, ["alice", "carol"]);
});

test("logins are matched case-insensitively against both lists", () => {
  const { members } = screenOwners(["Alice"], SCREEN);
  assert.deepEqual(members, ["Alice"]);
});

// --- the whole seed ----------------------------------------------------------------

const ORG_SEED = {
  org: "acme",
  repoLabel: "acme/app",
  runner: "runner",
  pushCapable: ["alice", "bob", "runner"],
};

/** Inspect then plan, the way the CLI does it. */
const seedFor = async (client, opts = {}) =>
  planTeamSeed(client, {
    ...ORG_SEED,
    ...opts,
    inspection: await inspectCodeowners(client, { org: "acme", exclude: ["acme/reviewers"] }),
  });

test("the seed is the repo's code owners, so the reviewer rule can be satisfied", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @alice\n/api/ @acme/backend" },
    teams: { "acme/backend": ["bob"] },
    members: ["alice", "bob", "runner"],
  });

  const seed = await seedFor(client);
  assert.deepEqual(seed.members, ["alice", "bob"]);
  assert.equal(seed.path, ".github/CODEOWNERS");
  assert.equal(seed.runnerAdded, false, "code owners were found, so the runner is not enrolled");
});

/**
 * The old behaviour, kept exactly: with nobody to seed from, the person running
 * the sync is added so the team is never created empty.
 */
test("with no CODEOWNERS the runner is the fallback member", async () => {
  const seed = await seedFor(stubClient());
  assert.deepEqual(seed.members, ["runner"]);
  assert.equal(seed.runnerAdded, true);
  assert.equal(seed.path, null);
});

test("includeRunner: true always adds the runner alongside the code owners", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice" }, members: ["alice"] });
  const seed = await seedFor(client, { includeRunner: true });

  assert.deepEqual(seed.members, ["alice", "runner"]);
  assert.equal(seed.runnerAdded, true);
});

test("includeRunner: false leaves the team unseeded rather than enrolling the runner", async () => {
  const seed = await seedFor(stubClient(), { includeRunner: false });
  assert.deepEqual(seed.members, []);
});

test("the runner is never added twice when they are a code owner themselves", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @runner" }, members: ["runner"] });
  const seed = await seedFor(client, { includeRunner: true });

  assert.deepEqual(seed.members, ["runner"]);
  assert.equal(seed.runnerAdded, false);
});

test("fromCodeowners: false ignores the file and falls back to the runner", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice" }, members: ["alice"] });
  const seed = await seedFor(client, { fromCodeowners: false });

  assert.deepEqual(seed.members, ["runner"]);
  assert.equal(seed.path, null);
});

test("a CODEOWNERS naming only ineligible people still explains itself", async () => {
  const client = stubClient({
    files: { ".github/CODEOWNERS": "* @carol" },
    members: ["carol"],
  });
  const seed = await seedFor(client, { includeRunner: false });

  assert.deepEqual(seed.members, []);
  assert.equal(seed.fromCodeowners, 0);
  assert.match(seed.skipped[0].reason, /no write access/);
});

test("the org member list is not fetched when there is nobody to screen", async () => {
  const client = stubClient({ files: {} });
  await seedFor(client);
  assert.equal(client.calls.orgMembers, 0);
});

// --- can CODEOWNERS carry the review on its own? ----------------------------------------

const inspect = (client, org = "acme") => inspectCodeowners(client, { org });
const PUSH = { pushCapable: ["alice", "bob", "runner"] };

test("two owners with write access on every pattern makes code-owner review usable", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice @bob\n/api/ @alice @runner" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, true);
  assert.equal(review.patterns, 2);
  assert.deepEqual(review.owners, ["alice", "bob", "runner"]);
});

/**
 * The bricking case: a pull request its sole owner writes could never be
 * approved by anybody, and GitHub would block it forever.
 */
test("a pattern with a single owner is refused, and named", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice @bob\n/api/ @alice" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, false);
  assert.match(review.reason, /\/api\/ has a single owner who can push/);
  assert.match(review.remedy, /give \/api\/ a second owner/);
});

test("an owner without write access does not count towards the two", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice @carol" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, false, "carol cannot approve, so alice is alone");
  assert.match(review.reason, /single owner/);
});

test("an unverifiable owner is called out rather than counted", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice dev@acme.com" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, false);
  assert.match(review.reason, /could not be verified/);
});

test("a pattern nobody eligible owns is not a blocker — GitHub asks for no review there", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @alice @bob\n/vendor/ @carol" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, true, "an unowned path simply needs no code owner");
  assert.equal(review.patterns, 1);
});

test("no CODEOWNERS at all says so, with the file to add", async () => {
  const review = assessCodeownerReview(await inspect(stubClient()), PUSH);

  assert.equal(review.usable, false);
  assert.match(review.reason, /no CODEOWNERS file/);
  assert.match(review.remedy, /\.github\/CODEOWNERS/);
});

test("a CODEOWNERS whose owners all lack write access says that, not 'single owner'", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @carol @dave" } });
  const review = assessCodeownerReview(await inspect(client), PUSH);

  assert.equal(review.usable, false);
  assert.match(review.reason, /no owner named in .github\/CODEOWNERS has write access/);
});

test("an unreadable collaborator list assumes the owners can approve", async () => {
  const client = stubClient({ files: { ".github/CODEOWNERS": "* @carol @dave" } });
  const review = assessCodeownerReview(await inspect(client), { pushCapable: undefined });

  assert.equal(review.usable, true, "unknown is not the same as zero");
});

// --- how it reads in the plan --------------------------------------------------------

test("the plan line names the source and the members", () => {
  assert.equal(
    describeSeed({ path: ".github/CODEOWNERS", members: ["alice", "bob"], fromCodeowners: 2, runnerAdded: false }),
    "2 member(s) from .github/CODEOWNERS: @alice, @bob",
  );
  assert.equal(
    describeSeed({ path: ".github/CODEOWNERS", members: ["alice", "runner"], fromCodeowners: 1, runnerAdded: true }),
    "2 member(s) from .github/CODEOWNERS plus you: @alice, @runner",
  );
  assert.equal(
    describeSeed({ path: null, members: ["runner"], fromCodeowners: 0, runnerAdded: true }),
    "1 member(s) (no CODEOWNERS file in this repository), so just you: @runner",
  );
  assert.equal(
    describeSeed({ path: null, members: [], fromCodeowners: 0, runnerAdded: false }),
    "no CODEOWNERS file in this repository",
  );
});

test("a long member list is truncated in the plan, never silently", () => {
  const members = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const line = describeSeed({ path: "CODEOWNERS", members, fromCodeowners: 10, runnerAdded: false });

  assert.match(line, /10 member\(s\)/);
  assert.match(line, /\+2 more$/);
});
