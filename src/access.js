/**
 * Repository access probing.
 *
 * GitHub deliberately answers 404 — not 403 — for a private repository the
 * caller cannot see, so "no access" and "does not exist" are indistinguishable
 * from the API. Every message here has to stay honest about that ambiguity.
 *
 * The one path that genuinely grants access is a pending repository
 * invitation, which this module detects. Accepting it is an account-level
 * change, so it is never done implicitly — the caller must opt in.
 */

import { GitHubError } from "./github.js";

/**
 * Raised when the target repository cannot be reached and nothing further can
 * be done automatically. Carries an already-formatted message, so the CLI
 * prints it verbatim rather than re-wrapping it as an API failure.
 */
export class AccessDenied extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessDenied";
  }
}

/** Rulesets are an admin-scoped operation; a lesser invitation will not do. */
const ADMIN_PERMISSIONS = new Set(["admin", "maintain"]);

/**
 * Classifies a failed repository lookup. Only 404 means "possibly reachable
 * via an invitation"; anything else is a different problem wearing a
 * similar-looking error.
 */
export function classifyLookupFailure(error) {
  const status = error?.status;
  if (status === 404) return "unreachable";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  return "other";
}

/**
 * Finds a pending invitation for the target repository. GitHub's full_name
 * casing follows whatever the owner typed, so matching is case-insensitive.
 */
export function findInvitation(invitations, owner, repo) {
  const wanted = `${owner}/${repo}`.toLowerCase();
  return (
    (invitations ?? []).find((i) => String(i?.repository?.full_name ?? "").toLowerCase() === wanted) ??
    null
  );
}

/** Whether accepting this invitation would actually permit managing rulesets. */
export function invitationGrantsAdmin(invitation) {
  return ADMIN_PERMISSIONS.has(String(invitation?.permissions ?? "").toLowerCase());
}

/** Human-readable summary of an invitation, for the confirmation prompt. */
export function describeInvitation(invitation, owner, repo) {
  const from = invitation?.inviter?.login ?? "someone";
  const permission = invitation?.permissions ?? "unknown";
  const lines = [
    `A pending invitation to ${owner}/${repo} is waiting for you.`,
    `  Invited by:  ${from}`,
    `  Grants:      ${permission}`,
  ];
  if (!invitationGrantsAdmin(invitation)) {
    lines.push(
      `  Note:        managing rulesets needs 'admin'; '${permission}' will not be enough,`,
      `               so accepting alone will not unblock this sync.`,
    );
  }
  return lines.join("\n");
}

/**
 * The message shown when nothing can be done automatically. Deliberately
 * refuses to claim the repository exists.
 */
export function noAccessMessage(owner, repo) {
  return [
    `No repo access to ${owner}/${repo}.`,
    "",
    "It is either private and not shared with your account, or it does not exist.",
    "GitHub returns the same 404 for both, so this cannot be narrowed down from here.",
    "",
    "To continue, ask an owner to grant you admin on the repository:",
    `  https://github.com/${owner}/${repo}/settings/access`,
    "",
    "Once the invitation is sent, re-run this command and it will be detected.",
  ].join("\n");
}

/** Highest-to-lowest, so the caller's effective role can be named in a message. */
const ROLE_ORDER = [
  ["admin", "admin"],
  ["maintain", "maintain"],
  ["push", "write"],
  ["triage", "triage"],
  ["pull", "read"],
];

export function describePermission(permissions) {
  const found = ROLE_ORDER.find(([key]) => permissions?.[key]);
  return found ? found[1] : "no";
}

/**
 * The message for a repository you can see but cannot administer.
 *
 * The owner type decides whether this is fixable at all: an organisation can
 * grant the Admin role to anyone, whereas a repository owned by a personal
 * account reserves admin for the owner — its collaborators top out at write —
 * so no invitation will ever unblock it.
 */
export function needsAdminMessage({ owner, repo, ownerType, ownerLogin, permissions, viewer }) {
  const role = describePermission(permissions);
  const who = viewer ? `You are authenticated as '${viewer}', who has ${role} access.` : `Your credentials have ${role} access.`;

  const lines = [`No admin access to ${owner}/${repo}.`, "", who, "Managing rulesets requires admin.", ""];

  if (ownerType === "Organization") {
    lines.push(
      `Ask an owner of the '${ownerLogin}' organisation to grant you the Admin role:`,
      `  https://github.com/${owner}/${repo}/settings/access`,
    );
  } else {
    lines.push(
      "This repository belongs to a personal account, and GitHub reserves admin on",
      `those for the owner alone — collaborators cannot go above write. Being added`,
      "to the repository therefore will not unblock this.",
      "",
      "The rules have to be applied by the owner instead. Either:",
      `  - ask ${ownerLogin} to run this command themselves, or`,
      `  - have the repository transferred to an organisation, where admin can be granted.`,
    );
  }

  lines.push(
    "",
    "If a different account of yours already has admin, switch to it and re-run:",
    "  gh auth switch          (or: gh auth login)",
  );

  return lines.join("\n");
}

/**
 * Probes the target repository, returning either its context or a description
 * of what is blocking. Never mutates anything.
 *
 * @returns {Promise<{ok: true, context: object} | {ok: false, reason: string, invitation: object|null, message: string}>}
 */
export async function probeAccess(client) {
  const { owner, repo } = client;

  try {
    return { ok: true, context: await client.context() };
  } catch (error) {
    const reason = classifyLookupFailure(error);

    if (reason !== "unreachable") {
      // Not an access-grant problem; let the original error speak for itself.
      throw error;
    }

    let invitation = null;
    try {
      invitation = findInvitation(await client.listInvitations(), owner, repo);
    } catch {
      // Invitation listing is best-effort; its failure must not mask the 404.
    }

    return {
      ok: false,
      reason,
      invitation,
      message: invitation
        ? describeInvitation(invitation, owner, repo)
        : noAccessMessage(owner, repo),
    };
  }
}

/**
 * Accepts an invitation and re-probes. Callers must have obtained consent
 * before calling this — it changes the user's GitHub account state.
 */
export async function acceptAndReprobe(client, invitation) {
  await client.acceptInvitation(invitation.id);

  const result = await probeAccess(client);
  if (!result.ok) {
    throw new GitHubError(
      `Accepted the invitation to ${client.owner}/${client.repo}, but the repository is still not reachable. ` +
        "GitHub can lag briefly after an invitation is accepted; try re-running in a moment.",
    );
  }
  return result.context;
}
