import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLookupFailure,
  findInvitation,
  invitationGrantsAdmin,
  describeInvitation,
  noAccessMessage,
  probeAccess,
  acceptAndReprobe,
} from "../src/access.js";

const CONTEXT = {
  ownerType: "User",
  ownerLogin: "akshayahujaa",
  defaultBranch: "main",
  visibility: "public",
  isAdmin: true,
};

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/**
 * Stub client. `contextFailures` lets a call fail the first N times, so the
 * accept-then-retry path can be exercised.
 */
function stubClient({ owner = "acme", repo = "widgets", contextError = null, invitations = [], invitationsError = null } = {}) {
  const calls = { accepted: [], contextCalls: 0 };
  let error = contextError;

  return {
    owner,
    repo,
    calls,
    /** Clears the failure, mimicking access appearing after acceptance. */
    grantAccess: () => {
      error = null;
    },
    context: async () => {
      calls.contextCalls += 1;
      if (error) throw error;
      return CONTEXT;
    },
    listInvitations: async () => {
      if (invitationsError) throw invitationsError;
      return invitations;
    },
    acceptInvitation: async (id) => {
      calls.accepted.push(id);
    },
  };
}

const INVITE = {
  id: 42,
  permissions: "admin",
  inviter: { login: "octocat" },
  repository: { full_name: "acme/widgets" },
};

// --- classification ----------------------------------------------------------

test("only a 404 is treated as possibly-reachable-by-invitation", () => {
  assert.equal(classifyLookupFailure(httpError(404)), "unreachable");
  assert.equal(classifyLookupFailure(httpError(401)), "unauthenticated");
  assert.equal(classifyLookupFailure(httpError(403)), "forbidden");
  assert.equal(classifyLookupFailure(httpError(500)), "other");
  assert.equal(classifyLookupFailure(new Error("network down")), "other");
});

// --- invitation matching -----------------------------------------------------

test("an invitation is matched regardless of casing", () => {
  const invites = [{ ...INVITE, repository: { full_name: "Acme/Widgets" } }];
  assert.ok(findInvitation(invites, "acme", "widgets"));
});

test("an invitation for a different repository is not matched", () => {
  const invites = [{ ...INVITE, repository: { full_name: "acme/other" } }];
  assert.equal(findInvitation(invites, "acme", "widgets"), null);
});

test("an empty or missing invitation list matches nothing", () => {
  assert.equal(findInvitation([], "acme", "widgets"), null);
  assert.equal(findInvitation(undefined, "acme", "widgets"), null);
});

test("only admin-grade invitations can unblock a ruleset sync", () => {
  assert.equal(invitationGrantsAdmin({ permissions: "admin" }), true);
  assert.equal(invitationGrantsAdmin({ permissions: "maintain" }), true);
  assert.equal(invitationGrantsAdmin({ permissions: "write" }), false);
  assert.equal(invitationGrantsAdmin({ permissions: "read" }), false);
  assert.equal(invitationGrantsAdmin({}), false);
});

test("a write-only invitation is described as insufficient", () => {
  const text = describeInvitation({ ...INVITE, permissions: "write" }, "acme", "widgets");
  assert.match(text, /octocat/);
  assert.match(text, /needs 'admin'/);
});

test("an admin invitation carries no insufficiency warning", () => {
  const text = describeInvitation(INVITE, "acme", "widgets");
  assert.doesNotMatch(text, /not be enough/);
});

// --- the no-access message ---------------------------------------------------

test("the no-access message refuses to claim the repository exists", () => {
  const text = noAccessMessage("acme", "widgets");
  assert.match(text, /No repo access to acme\/widgets/);
  assert.match(text, /or it does not exist/);
  assert.match(text, /settings\/access/);
});

// --- probing -----------------------------------------------------------------

test("a reachable repository probes ok and reports its context", async () => {
  const result = await probeAccess(stubClient());
  assert.equal(result.ok, true);
  assert.equal(result.context.defaultBranch, "main");
});

test("a 404 with a pending invitation surfaces the invitation", async () => {
  const client = stubClient({ contextError: httpError(404), invitations: [INVITE] });
  const result = await probeAccess(client);

  assert.equal(result.ok, false);
  assert.equal(result.invitation.id, 42);
  assert.match(result.message, /pending invitation/);
});

test("a 404 with no invitation yields the no-access message", async () => {
  const result = await probeAccess(stubClient({ contextError: httpError(404) }));

  assert.equal(result.ok, false);
  assert.equal(result.invitation, null);
  assert.match(result.message, /No repo access/);
});

test("probing never accepts an invitation on its own", async () => {
  const client = stubClient({ contextError: httpError(404), invitations: [INVITE] });
  await probeAccess(client);
  assert.deepEqual(client.calls.accepted, []);
});

test("a failure to list invitations does not mask the 404", async () => {
  const client = stubClient({
    contextError: httpError(404),
    invitationsError: new Error("no scope for invitations"),
  });
  const result = await probeAccess(client);

  assert.equal(result.ok, false);
  assert.match(result.message, /No repo access/);
});

test("a non-404 failure propagates rather than becoming an access prompt", async () => {
  const client = stubClient({ contextError: httpError(500) });
  await assert.rejects(() => probeAccess(client), /HTTP 500/);
});

// --- accepting ---------------------------------------------------------------

test("accepting an invitation re-probes and returns the now-reachable context", async () => {
  const client = stubClient({ contextError: httpError(404), invitations: [INVITE] });
  client.acceptInvitation = async (id) => {
    client.calls.accepted.push(id);
    client.grantAccess();
  };

  const context = await acceptAndReprobe(client, INVITE);
  assert.deepEqual(client.calls.accepted, [42]);
  assert.equal(context.defaultBranch, "main");
});

test("an accepted invitation that still leaves the repo unreachable fails loudly", async () => {
  const client = stubClient({ contextError: httpError(404), invitations: [INVITE] });
  await assert.rejects(() => acceptAndReprobe(client, INVITE), /still not reachable/);
});
