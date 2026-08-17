/**
 * Diffs desired rulesets against what the repository actually has, and applies
 * the difference. Planning never writes, so it is always safe to run.
 *
 * Rulesets are matched by name rather than id: the config is the source of
 * truth and ids are assigned by GitHub, so name matching is what makes a
 * re-run update in place instead of creating duplicates.
 */

const sortedSet = (items = []) => [...items].sort();

/**
 * True when `actual` already carries everything `desired` asks for.
 *
 * The comparison is deliberately one-directional for rule *parameters*: GitHub
 * fills in defaults we never sent, and treating those as drift would make every
 * run report an update. Arrays still require equal length, so a bypass actor
 * added by hand shows up as drift rather than being tolerated.
 */
function covers(desired, actual) {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || desired.length !== actual.length) return false;
    return desired.every((item, i) => covers(item, actual[i]));
  }
  if (desired && typeof desired === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(desired).every(([key, value]) => covers(value, actual[key]));
  }
  return desired === actual;
}

function rulesMatch(desiredRules = [], actualRules = []) {
  const desiredTypes = sortedSet(desiredRules.map((r) => r.type));
  const actualTypes = sortedSet(actualRules.map((r) => r.type));
  if (desiredTypes.join() !== actualTypes.join()) return false;

  return desiredRules.every((rule) => {
    const actual = actualRules.find((r) => r.type === rule.type);
    return covers(rule.parameters ?? {}, actual?.parameters ?? {});
  });
}

export function isUnchanged(desired, actual) {
  if (!actual) return false;
  if (desired.enforcement !== actual.enforcement) return false;
  if (desired.target !== actual.target) return false;

  const d = desired.conditions?.ref_name ?? {};
  const a = actual.conditions?.ref_name ?? {};
  if (sortedSet(d.include).join() !== sortedSet(a.include).join()) return false;
  if (sortedSet(d.exclude).join() !== sortedSet(a.exclude).join()) return false;

  if ((desired.bypass_actors ?? []).length !== (actual.bypass_actors ?? []).length) return false;

  return rulesMatch(desired.rules, actual.rules);
}

/**
 * Refs an update would stop covering. A full PUT replaces the conditions, so a
 * ref dropped from the scope silently loses whatever that ruleset gave it —
 * which the plan must name rather than only showing the new scope.
 */
export function droppedRefs(desired, actual) {
  const before = new Set(actual?.conditions?.ref_name?.include ?? []);
  const after = new Set(desired?.conditions?.ref_name?.include ?? []);
  return [...before].filter((ref) => !after.has(ref));
}

/**
 * @returns {Promise<{steps: Array<{action, name, payload, id?, existing?, dropped?}>,
 *                    undeclared: Array<{name, id, ruleset}>}>}
 *   `undeclared` carries each full ruleset, not just its name: a leftover from
 *   an earlier config can still be actively blocking merges, and that can only
 *   be judged from its rules.
 */
export async function plan(client, desiredRulesets) {
  const existing = await client.listRulesets();
  const byName = new Map(existing.map((r) => [r.name, r]));

  const steps = [];
  for (const payload of desiredRulesets) {
    const match = byName.get(payload.name);
    if (!match) {
      steps.push({ action: "create", name: payload.name, payload });
      continue;
    }
    // The list endpoint omits `rules`, so the full ruleset is needed to diff.
    const full = await client.getRuleset(match.id);
    steps.push({
      action: isUnchanged(payload, full) ? "unchanged" : "update",
      name: payload.name,
      payload,
      id: match.id,
      existing: full,
      dropped: droppedRefs(payload, full),
    });
  }

  const declared = new Set(desiredRulesets.map((r) => r.name));
  const undeclared = [];
  for (const r of existing.filter((r) => !declared.has(r.name))) {
    undeclared.push({ name: r.name, id: r.id, ruleset: await client.getRuleset(r.id) });
  }

  return { steps, undeclared };
}

/**
 * Whether a ruleset the config no longer manages is actively preventing
 * merges: it demands approvals (or a team review) that this repository cannot
 * supply. Left in place these silently block every pull request, which is the
 * worst way to discover an abandoned policy.
 */
export function isBlockingMerges(ruleset, approvalsAvailable) {
  if (ruleset?.enforcement !== "active") return false;
  const pr = (ruleset.rules ?? []).find((r) => r.type === "pull_request");
  if (!pr) return false;

  const needed = pr.parameters?.required_approving_review_count ?? 0;
  const reviewers = pr.parameters?.required_reviewers ?? [];
  return needed > approvalsAvailable || (reviewers.length > 0 && approvalsAvailable < 1);
}

/**
 * Applies a plan. Each ruleset is independent: one rejection does not stop the
 * rest, so a partial apply still makes progress and reports precisely what
 * failed.
 */
export async function apply(client, steps) {
  const results = [];

  for (const step of steps) {
    if (step.action === "unchanged") {
      results.push({ ...step, status: "skipped" });
      continue;
    }
    try {
      if (step.action === "create") await client.createRuleset(step.payload);
      else await client.updateRuleset(step.id, step.payload);
      results.push({ ...step, status: "applied" });
    } catch (error) {
      results.push({ ...step, status: "failed", error: error.message, detail: error.body?.errors });
    }
  }

  return results;
}
