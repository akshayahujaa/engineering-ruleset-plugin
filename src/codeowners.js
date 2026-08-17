/**
 * CODEOWNERS: who reviews this repository, and what the sync can do with that.
 *
 * It answers two questions, from a single read of the file.
 *
 * 1. WHO GOES IN A REVIEWER TEAM. `required_reviewers` binds a GitHub team,
 *    and a team that does not exist — or exists with nobody in it — can never
 *    supply the review it gates. The people who already own the code are the
 *    right members, so a missing or empty team is seeded from here.
 *
 * 2. WHETHER CODEOWNERS CAN CARRY THE REVIEW ON ITS OWN. Teams exist only
 *    inside organisations, so on a personal repo — or when a team names
 *    another org, or nobody can be found to seed it — the team requirement is
 *    dropped and the review used to vanish with it. GitHub's
 *    `require_code_owner_review` needs no team at all, so where it is
 *    satisfiable it takes over instead.
 *
 * Satisfiability is the whole game. A review nobody can supply does not harden
 * a repository, it bricks it: every pull request blocks forever. So a code
 * owner only counts when they have write access — GitHub ignores the rest —
 * and a pattern owned by exactly ONE person is refused, because a pull request
 * that person authors could never be approved by anybody else.
 *
 * Nothing here writes. It answers "who would be added" and "what could be
 * enforced"; the CLI puts both in the plan first.
 */

/** GitHub's own lookup order; the first file that exists is the one in force. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

const lower = (value) => String(value).toLowerCase();

function dedupe(logins) {
  const seen = new Set();
  const out = [];
  for (const login of logins) {
    if (seen.has(lower(login))) continue;
    seen.add(lower(login));
    out.push(login);
  }
  return out;
}

/**
 * A `#` starts a comment unless it is escaped, which CODEOWNERS allows so a
 * path pattern can contain one. Cutting at the first `#` regardless would
 * silently truncate such a line and lose its owners.
 */
function stripComment(line) {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && line[i + 1] === "#") {
      out += "#";
      i += 1;
      continue;
    }
    if (line[i] === "#") break;
    out += line[i];
  }
  return out;
}

/**
 * A section header (`[Backend]`, `^[Backend][2]`) carries owners directly,
 * with no path pattern in front of them — so unlike an ordinary line, the
 * first token after the brackets is already an owner.
 */
const SECTION_HEADER = /^\^?\[[^\]]*\](?:\[\d+\])?/;

/** GitHub logins: alphanumeric and hyphens, nothing else. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Splits on whitespace, except where it is escaped — CODEOWNERS spells a path
 * containing a space as `docs\ and\ specs/`, and splitting that into three
 * would report two of its halves as unrecognised owners.
 */
const split = (line) => line.split(/(?<!\\)\s+/).filter(Boolean);

export function classifyOwner(token) {
  if (token.startsWith("@")) {
    const body = token.slice(1);
    const parts = body.split("/");
    if (parts.length === 2 && LOGIN.test(parts[0]) && parts[1] !== "") {
      return { kind: "team", value: `${parts[0]}/${parts[1]}` };
    }
    if (parts.length === 1 && LOGIN.test(body)) return { kind: "user", value: body };
    return null;
  }
  if (EMAIL.test(token)) return { kind: "email", value: token };
  return null;
}

/**
 * The file as GitHub reads it: one entry per owning line, in order.
 *
 * The rules are kept separate rather than flattened because ownership is
 * per-pattern — the last pattern matching a file decides who owns it, so
 * "does every owned path have somebody who can review it" can only be
 * answered one pattern at a time.
 *
 * @returns {Array<{pattern: string, owners: string[]}>}
 */
export function parseCodeownerRules(text) {
  const rules = [];

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === "") continue;

    const header = line.match(SECTION_HEADER);
    const tokens = header
      ? split(line.slice(header[0].length).trim())
      : // The first token is the path pattern, never an owner.
        split(line).slice(1);

    if (tokens.length === 0) continue;
    rules.push({ pattern: header ? header[0] : split(line)[0], owners: tokens });
  }

  return rules;
}

/**
 * The distinct owners a CODEOWNERS file names, by kind, in the order they
 * first appear.
 *
 * @returns {{users: string[], teams: string[], emails: string[], unresolved: string[]}}
 */
export function parseCodeowners(text) {
  const users = [];
  const teams = [];
  const emails = [];
  const unresolved = [];
  const seen = new Set();

  for (const rule of parseCodeownerRules(text)) {
    for (const token of rule.owners) {
      const owner = classifyOwner(token);
      const key = `${owner?.kind ?? "?"}:${lower(owner?.value ?? token)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!owner) unresolved.push(token);
      else if (owner.kind === "user") users.push(owner.value);
      else if (owner.kind === "team") teams.push(owner.value);
      else emails.push(owner.value);
    }
  }

  return { users, teams, emails, unresolved };
}

/**
 * Reads the repository's CODEOWNERS, honouring GitHub's lookup order.
 *
 * @returns {Promise<{path: string, rules: Array<{pattern, owners}>, users: string[],
 *                    teams: string[], emails: string[], unresolved: string[]}|null>}
 */
export async function readCodeowners(client) {
  for (const path of CODEOWNERS_PATHS) {
    const file = await client.getFile(path);
    if (file) {
      return { path, rules: parseCodeownerRules(file.content), ...parseCodeowners(file.content) };
    }
  }
  return null;
}

/**
 * Reads CODEOWNERS and resolves every owner it names to GitHub logins, once.
 *
 * `@org/team` owners are expanded to their members, each team looked up at
 * most once however many patterns name it. Owners that cannot be resolved to a
 * login — an email, another org's team, a team that could not be read — are
 * kept per pattern as `unverified` and reported in `skipped`, never dropped
 * silently.
 *
 * `exclude` is the set of teams this run is about to create or fill. Skipping
 * them costs nothing: a team that does not exist yet, or that is empty, has no
 * members to contribute to either question.
 *
 * @returns {Promise<{path: string, byPattern: Array<{pattern, owners: string[], unverified: string[]}>,
 *                    logins: string[], skipped: Array<{who, reason}>}|null>}
 */
export async function inspectCodeowners(client, { org, exclude = [] }) {
  const found = await readCodeowners(client);
  if (!found) return null;

  const excluded = new Set(exclude.map(lower));
  const members = new Map(); // 'org/team' → logins, or null when unreadable
  const notes = new Map(); // who → reason, so one bad owner is reported once
  const byPattern = [];
  const logins = [];

  const note = (who, reason) => {
    if (!notes.has(who)) notes.set(who, reason);
  };

  for (const rule of found.rules) {
    const owners = [];
    const unverified = [];

    for (const token of rule.owners) {
      const owner = classifyOwner(token);

      if (!owner) {
        note(token, "is not a recognisable @user, @org/team, or email owner");
        unverified.push(token);
        continue;
      }
      if (owner.kind === "email") {
        note(token, "is an email address, which GitHub cannot resolve to a login from here");
        unverified.push(token);
        continue;
      }
      if (owner.kind === "user") {
        owners.push(owner.value);
        continue;
      }

      const [teamOrg, slug] = owner.value.split("/");
      if (lower(teamOrg) !== lower(org)) {
        note(token, `is a team of '${teamOrg}', not '${org}', so its members cannot be read from here`);
        unverified.push(token);
        continue;
      }
      if (excluded.has(lower(owner.value))) {
        unverified.push(token);
        continue;
      }
      if (!members.has(owner.value)) {
        try {
          members.set(owner.value, await client.teamMembers(teamOrg, slug));
        } catch (error) {
          members.set(owner.value, null);
          note(token, `its members could not be read (${error.message})`);
        }
      }
      const resolved = members.get(owner.value);
      if (resolved === null) unverified.push(token);
      else owners.push(...resolved);
    }

    byPattern.push({ pattern: rule.pattern, owners: dedupe(owners), unverified });
    logins.push(...owners);
  }

  return {
    path: found.path,
    byPattern,
    logins: dedupe(logins),
    skipped: [...notes].map(([who, reason]) => ({ who, reason })),
  };
}

/**
 * Filters candidates down to the ones who can actually be made team members
 * here, and who would actually be able to approve once they are.
 *
 * `pushCapable` undefined means the collaborator list could not be read; the
 * write-access filter is then skipped rather than rejecting everybody, which
 * matches how the compiler treats an unknown review capacity.
 *
 * `orgMembers` null means the same for organisation membership — but that one
 * fails closed. Adding a non-member to a team invites them to the
 * organisation, and an invitation nobody asked for is not something to send on
 * a guess.
 */
export function screenOwners(logins, { repoLabel, org, orgMembers, pushCapable, runner }) {
  const canPush = pushCapable && new Set(pushCapable.map(lower));
  const members = [];
  const skipped = [];

  for (const login of logins) {
    // The runner is exempt from the membership check: adding yourself to a
    // team is not an invitation sent to somebody else.
    const isRunner = runner && lower(login) === lower(runner);

    if (canPush && !canPush.has(lower(login))) {
      skipped.push({
        who: `@${login}`,
        reason: `has no write access to ${repoLabel}, so their approval would not count`,
      });
      continue;
    }
    if (!isRunner && !orgMembers) {
      skipped.push({
        who: `@${login}`,
        reason:
          `the '${org}' member list could not be read, so membership cannot be confirmed — ` +
          "adding an outside account would invite it to the organisation",
      });
      continue;
    }
    if (!isRunner && !orgMembers.has(lower(login))) {
      skipped.push({
        who: `@${login}`,
        reason:
          `is not a member of '${org}' — adding them would send them an organisation ` +
          "invitation, which this sync will not do on their behalf",
      });
      continue;
    }
    members.push(login);
  }

  return { members, skipped };
}

/**
 * Who this run would put in a reviewer team, and why anyone named by
 * CODEOWNERS was left out.
 *
 * `includeRunner` decides whether whoever runs the sync joins too:
 *   "fallback" (default) — only when CODEOWNERS produced nobody, so a team is
 *                          never created empty, but running the command does
 *                          not quietly enrol you as a reviewer for a
 *                          repository you do not own
 *   true                 — always
 *   false                — never; the team is skipped if CODEOWNERS is empty
 *
 * @param {object|null} inspection  the result of inspectCodeowners, or null
 * @returns {Promise<{path: string|null, members: string[], skipped: Array<{who, reason}>,
 *                    runnerAdded: boolean, fromCodeowners: number}>}
 */
export async function planTeamSeed(
  client,
  { inspection, org, repoLabel, runner, includeRunner = "fallback", fromCodeowners = true, pushCapable },
) {
  const source = fromCodeowners ? inspection : null;
  const skipped = [...(source?.skipped ?? [])];
  const logins = source?.logins ?? [];

  // Only worth a round trip when there is somebody to screen.
  let orgMembers = null;
  if (logins.length > 0) {
    try {
      orgMembers = new Set((await client.orgMembers(org)).map(lower));
    } catch {
      /* null: unknown, which screenOwners fails closed on */
    }
  }

  const screened = screenOwners(logins, { repoLabel, org, orgMembers, pushCapable, runner });
  skipped.push(...screened.skipped);

  const members = [...screened.members];
  const alreadyThere = members.some((m) => lower(m) === lower(runner ?? ""));
  const runnerAdded =
    Boolean(runner) &&
    !alreadyThere &&
    (includeRunner === true || (includeRunner === "fallback" && members.length === 0));

  if (runnerAdded) members.push(runner);

  return {
    path: source?.path ?? null,
    members,
    skipped,
    runnerAdded,
    fromCodeowners: screened.members.length,
  };
}

/** How the seed reads in the plan: where the members came from, and who they are. */
export function describeSeed(seed, { limit = 8 } = {}) {
  const origin = seed.path
    ? seed.fromCodeowners > 0
      ? `from ${seed.path}`
      : `${seed.path} named nobody who can be added here`
    : "no CODEOWNERS file in this repository";

  if (seed.members.length === 0) return origin;

  const shown = seed.members.slice(0, limit).map((m) => `@${m}`).join(", ");
  const more = seed.members.length > limit ? `, +${seed.members.length - limit} more` : "";
  const source =
    seed.fromCodeowners > 0
      ? `${origin}${seed.runnerAdded ? " plus you" : ""}`
      : `(${origin}), so just you`;

  return `${seed.members.length} member(s) ${source}: ${shown}${more}`;
}

/**
 * Whether `require_code_owner_review` could carry the review here, and if not,
 * exactly what is missing.
 *
 * Two things have to hold. Every owner must have write access, because GitHub
 * ignores a code owner who does not — an owner it ignores is an owner who
 * cannot clear the gate. And every owned pattern needs at least TWO of them:
 * with one, the pull requests that owner writes touching their own files could
 * never be approved by anybody, and would block forever.
 *
 * A pattern with no eligible owner at all is not a problem — GitHub asks for
 * no code owner review on paths nobody owns.
 *
 * @returns {{usable: boolean, path: string|null, owners?: string[], patterns?: number,
 *            reason?: string, remedy?: string}}
 */
export function assessCodeownerReview(inspection, { pushCapable } = {}) {
  const remedyFile =
    "add .github/CODEOWNERS naming at least two owners with write access, then re-run";

  if (!inspection) {
    return { usable: false, path: null, reason: "this repository has no CODEOWNERS file", remedy: remedyFile };
  }

  const canPush = pushCapable && new Set(pushCapable.map(lower));
  const owned = inspection.byPattern
    .map((entry) => ({
      pattern: entry.pattern,
      owners: canPush ? entry.owners.filter((o) => canPush.has(lower(o))) : entry.owners,
      unverified: entry.unverified,
    }))
    .filter((entry) => entry.owners.length > 0);

  if (owned.length === 0) {
    return {
      usable: false,
      path: inspection.path,
      reason: `no owner named in ${inspection.path} has write access to this repository`,
      remedy: `name owners in ${inspection.path} who can push to this repository, then re-run`,
    };
  }

  const thin = owned.filter((entry) => entry.owners.length < 2);
  if (thin.length > 0) {
    const patterns = thin.map((entry) => entry.pattern).join(", ");
    const unverified = thin.some((entry) => entry.unverified.length > 0);
    return {
      usable: false,
      path: inspection.path,
      reason:
        `${patterns} ${thin.length === 1 ? "has" : "have"} a single owner who can push, so a pull ` +
        `request that owner writes could never be approved` +
        (unverified ? " (and its other owners could not be verified from here)" : ""),
      remedy: `give ${patterns} a second owner with write access in ${inspection.path}, then re-run`,
    };
  }

  return {
    usable: true,
    path: inspection.path,
    owners: dedupe(owned.flatMap((entry) => entry.owners)),
    patterns: owned.length,
  };
}
