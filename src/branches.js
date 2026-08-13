/**
 * Environment branch provisioning.
 *
 * A ruleset naming `refs/heads/dev` protects nothing until that branch exists,
 * so a freshly connected repo needs its environment branches created. The
 * order is forced: `Pull Request Compulsion` requires a pull request for dev,
 * and creating a branch counts as a direct push, so once that ruleset is
 * active GitHub refuses the creation with a 422. Branches therefore have to
 * exist before the rulesets that guard them — and on a repo already synced,
 * the guard must be relaxed for the moment it takes to create them.
 */

/** Rules that make a branch impossible to create by pushing a new ref. */
const BLOCKING_RULES = new Set(["pull_request", "creation", "required_status_checks"]);

/**
 * Compiles a GitHub ref pattern to a regex.
 *
 * Tokenised in one pass rather than by chained replaces: handling `**` and
 * then `*` separately corrupts the first substitution's output, which is how
 * `feature/**` silently stops matching `feature/a/b`.
 */
export function globToRegExp(pattern) {
  let out = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${out}$`);
}

/** Resolves the `~ALL` / `~DEFAULT_BRANCH` aliases before matching. */
export function refMatches(pattern, ref, defaultBranch) {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return ref === `refs/heads/${defaultBranch}`;
  return globToRegExp(pattern).test(ref);
}

/** Whether a ruleset's conditions select this ref. Exclusions win. */
export function rulesetCovers(ruleset, ref, defaultBranch) {
  const { include = [], exclude = [] } = ruleset?.conditions?.ref_name ?? {};
  if (exclude.some((p) => refMatches(p, ref, defaultBranch))) return false;
  return include.some((p) => refMatches(p, ref, defaultBranch));
}

/**
 * The active rulesets that would refuse creation of any of these refs. Only
 * these need relaxing, so an unrelated ruleset is never touched.
 */
export function blockingRulesets(rulesets, refs, defaultBranch) {
  return (rulesets ?? []).filter(
    (r) =>
      r.enforcement === "active" &&
      (r.rules ?? []).some((rule) => BLOCKING_RULES.has(rule.type)) &&
      refs.some((ref) => rulesetCovers(r, ref, defaultBranch)),
  );
}

/** Environment branches that do not exist yet, in config order. */
export function missingEnvironments(environments, existingBranches) {
  const present = new Set(existingBranches ?? []);
  return (environments ?? []).filter((name) => !present.has(name));
}

/**
 * Works out which environment branches need creating, and which rulesets
 * stand in the way. Read-only.
 *
 * `guardDefaultBranchWrite` widens the probe to the default branch: a pending
 * file write there (the ClickUp workflow) is refused by the same pull_request
 * rule that refuses branch creation, so it shares the one relax window rather
 * than earning a second.
 */
export async function planBranches(client, environments, defaultBranch, { guardDefaultBranchWrite = false } = {}) {
  const branches = await client.listBranches();
  const missing = missingEnvironments(environments, branches);
  if (missing.length === 0 && !guardDefaultBranchWrite) return { missing: [], blocked: [] };

  const refs = missing.map((name) => `refs/heads/${name}`);
  if (guardDefaultBranchWrite) refs.push(`refs/heads/${defaultBranch}`);
  const existing = await client.fullRulesets();

  return { missing, blocked: blockingRulesets(existing, refs, defaultBranch) };
}

/**
 * Relaxes the given rulesets to `evaluate`, runs `fn`, and restores them.
 *
 * The restore is per-ruleset in a `finally`: one failed restore must not
 * abandon the others at `evaluate`, and every failure is reported by name so
 * the caller can say exactly which guard is still down.
 *
 * @returns {Promise<{value: any, restoreFailures: Array<{name, error}>}>}
 */
export async function withRelaxedEnforcement(client, blocked, fn) {
  const restoreFailures = [];
  let value;

  try {
    for (const ruleset of blocked) {
      await client.setEnforcement(ruleset, "evaluate");
    }
    value = await fn();
  } finally {
    for (const ruleset of blocked) {
      try {
        await client.setEnforcement(ruleset, "active");
      } catch (error) {
        restoreFailures.push({ name: ruleset.name, error: error.message });
      }
    }
  }

  return { value, restoreFailures };
}

/**
 * Creates the missing branches from the default branch head. Runs inside an
 * already-open relax window — the caller owns relax/restore via
 * `withRelaxedEnforcement`, so one window can cover the workflow-file write
 * to the default branch as well.
 *
 * @returns {Promise<Array<{name, status, error?}>>}
 */
export async function createMissingBranches(client, missing, defaultBranch) {
  if (missing.length === 0) return [];

  let head;
  try {
    head = await client.refSha(defaultBranch);
  } catch (error) {
    if (error?.status === 404) {
      throw new Error(
        `Branch '${defaultBranch}' has no resolvable head — the repository appears to have ` +
          "no commits. Push an initial commit, then re-run.",
      );
    }
    throw error;
  }

  const results = [];
  for (const name of missing) {
    try {
      await client.createRef(`refs/heads/${name}`, head);
      results.push({ name, status: "created" });
    } catch (error) {
      results.push({ name, status: "failed", error: error.message });
    }
  }
  return results;
}
