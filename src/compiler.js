/**
 * Compiles ruleset-config.json into GitHub ruleset API payloads.
 *
 * Pure: no filesystem, no network. Everything the compiler needs about the
 * target repository arrives in `context`, so generation is fully testable.
 */

// Only the two name constants, so the gate the compiler generates and the
// workflow that reports it can never disagree. Nothing here touches the
// filesystem, so the compiler stays pure.
import { TRIVY_CONTEXT, DEFAULT_TRIVY_RULESET } from "./prchecks.js";

const ref = (branch) => `refs/heads/${branch}`;

/**
 * `required_reviewers` binds a GitHub team, which only resolves when the
 * repository's owner is the organisation that owns the team. Personal repos,
 * and org repos naming a team from a different org, cannot use it.
 *
 * A team the plugin is about to create counts as usable: its id arrives before
 * the payload is sent, because the apply recompiles once the team exists.
 *
 * @returns {string|null} why the team cannot be used, or null when it can.
 *   Each case reads differently on purpose — "it is another org's team" and
 *   "it does not exist yet" have completely different fixes.
 */
function whyTeamUnusable(team, context) {
  if (context.ownerType !== "Organization") {
    return `'${context.ownerLogin}' is a user account — GitHub has no teams outside an organisation`;
  }
  const org = String(team).split("/")[0];
  if (org.toLowerCase() !== String(context.ownerLogin).toLowerCase()) {
    return `team '${team}' belongs to '${org}', but this repository is owned by '${context.ownerLogin}'`;
  }
  if (context.teamIds?.[team] !== undefined || (context.pendingTeams ?? []).includes(team)) return null;

  return (
    `team '${team}' could not be resolved in '${context.ownerLogin}' — it does not exist and could ` +
    "not be seeded, or this token cannot see it"
  );
}

/**
 * How many approvals this repository can actually produce for a pull request.
 *
 * GitHub does not let an author approve their own pull request, so N
 * push-capable accounts yield at most N-1 approvals. A requirement above that
 * can never be met: it does not harden the repo, it bricks it — no merge into
 * that branch can ever complete.
 *
 * `reviewCapacity` is undefined when the collaborator list could not be read;
 * that becomes Infinity — "assume satisfiable" — so a permissions hiccup never
 * silently strips a policy the repo can honour.
 */
export function approvalsAvailable(context) {
  if (context?.reviewCapacity === undefined) return Infinity;
  return Math.max(0, context.reviewCapacity - 1);
}

/** How the shortfall is described, given who owns the repository. */
function capacityReason(context, needed, available) {
  const who =
    context.ownerType === "Organization"
      ? `'${context.ownerLogin}' has ${context.reviewCapacity} account(s) with write access`
      : context.ownerLogin === context.viewerLogin
        ? `you are the only account with write access`
        : `'${context.ownerLogin}' has ${context.reviewCapacity} account(s) with write access`;

  return (
    `${who}, and GitHub forbids approving your own pull request — at most ${available} approval(s) ` +
    `can ever be supplied, but ${needed} is required`
  );
}

/**
 * A team requirement that could not be bound leaves the review with nothing
 * behind it — and that is the common case, not the exotic one: teams exist
 * only inside organisations, so every personal repo lands here.
 *
 * `require_code_owner_review` needs no team. Where CODEOWNERS can actually
 * supply the review (see assessCodeownerReview), it takes over, so the rule
 * still gates the merge instead of quietly becoming a bare approval count.
 *
 * It is only substituted alongside a surviving approval count. GitHub's own
 * documentation pairs the two, and betting a repository's merges on
 * code-owner review being enforced at a count of zero is not worth the
 * uncertainty — at zero the plan says what is missing instead.
 */
function substituteCodeownerReview({ parameters, teams, context, rulesetName, degradations }) {
  const wanted = (teams ?? []).length > 0;
  const bound = (parameters.required_reviewers ?? []).length > 0;
  const review = context.codeownerReview;

  if (!wanted || bound || parameters.require_code_owner_review) return;
  if (parameters.required_approving_review_count < 1 || !review) return;

  if (review.usable) {
    parameters.require_code_owner_review = true;
    degradations.push({
      ruleset: rulesetName,
      substituted: "require_code_owner_review",
      reason:
        `no team could be bound, so ${review.path} gates the review instead — ` +
        `${review.owners.length} owner(s) with write access across ${review.patterns} pattern(s)`,
    });
    return;
  }

  degradations.push({
    ruleset: rulesetName,
    unsubstituted: "require_code_owner_review",
    reason: `it would have replaced the dropped team, but ${review.reason}`,
    remedy: review.remedy,
  });
}

/**
 * Builds a pull_request rule, dropping requirements the target repo cannot
 * honour. Every drop is recorded so the plan can report it instead of
 * silently weakening — or silently bricking — the policy.
 *
 * @returns {{rule: object, survived: boolean}} `survived` is whether any part
 *   of the requested review survived. A ruleset whose only purpose was a
 *   review that did not survive should not be created.
 */
function pullRequestRule({ approvals, teams, mergeMethods, review = {} }, context, rulesetName, degradations) {
  // GitHub's schema requires all four review booleans alongside the approval
  // count; sending the count alone is rejected with a 422 on the rule index.
  const parameters = {
    required_approving_review_count: approvals ?? 0,
    dismiss_stale_reviews_on_push: review.dismissStaleReviewsOnPush ?? false,
    require_code_owner_review: review.requireCodeOwnerReview ?? false,
    require_last_push_approval: review.requireLastPushApproval ?? false,
    required_review_thread_resolution: review.requireReviewThreadResolution ?? false,
  };

  if (mergeMethods) parameters.allowed_merge_methods = mergeMethods;

  const available = approvalsAvailable(context);
  const moreCollaborators =
    context.ownerType === "Organization"
      ? "grant write access to another member (directly or via a team), then re-run"
      : "add a second collaborator with write access, then re-run";

  const usable = (teams ?? []).filter((team) => {
    const unusable = whyTeamUnusable(team, context);
    if (unusable) {
      degradations.push({ ruleset: rulesetName, dropped: "required_reviewers", team, reason: unusable });
      return false;
    }

    // A team review needs one approver who is not the author. Nobody can
    // supply that from an empty team, or on a repo with no spare approver —
    // and a bound-but-unsatisfiable team blocks merges just as hard as an
    // impossible approval count.
    const size = context.teamSizes?.[team];
    if (available < 1 || size === 0) {
      degradations.push({
        ruleset: rulesetName,
        dropped: "required_reviewers",
        team,
        reason:
          size === 0
            ? `team '${team}' has no members, so its review could never be supplied`
            : capacityReason(context, 1, available),
        remedy: size === 0 ? `add a member to '${team}', then re-run` : moreCollaborators,
      });
      return false;
    }
    return true;
  });

  if (usable.length > 0) {
    parameters.required_reviewers = usable.map((team) => ({
      minimum_approvals: 1,
      file_patterns: ["*"],
      reviewer: { id: context.teamIds?.[team], type: "Team" },
    }));
  }

  // An approval requirement nobody can meet is worse than no requirement: it
  // permanently blocks every pull request. Reduce it to what this repository
  // can actually supply rather than dropping the whole idea.
  const needed = parameters.required_approving_review_count;
  if (needed > available) {
    degradations.push({
      ruleset: rulesetName,
      dropped: "required_approving_review_count",
      reason: capacityReason(context, needed, available),
      remedy: moreCollaborators,
      reducedTo: available,
    });
    parameters.required_approving_review_count = available;
  }

  substituteCodeownerReview({ parameters, teams, context, rulesetName, degradations });

  const survived =
    parameters.required_approving_review_count > 0 ||
    (parameters.required_reviewers ?? []).length > 0 ||
    parameters.require_code_owner_review === true;

  return { rule: { type: "pull_request", parameters }, survived };
}

function baselineRuleset(config, context, degradations) {
  const baseline = config.baseline ?? {};
  const name = baseline.rulesetName ?? "pull-request-required";
  const environments = Object.keys(config.environments ?? {});

  const include = [];
  if (baseline.includeDefaultBranch) include.push("~DEFAULT_BRANCH");
  include.push(...environments.map(ref));

  if (include.length === 0) return null;

  const rules = [];
  if (baseline.preventDeletion) rules.push({ type: "deletion" });
  if (baseline.preventForcePush) rules.push({ type: "non_fast_forward" });
  if (baseline.requirePullRequest) {
    // The baseline's pull_request rule earns its place even with zero
    // approvals: requiring a PR at all is the point.
    rules.push(
      pullRequestRule(
        {
          approvals: baseline.requiredApprovals,
          teams: baseline.reviewerTeams,
          mergeMethods: baseline.allowedMergeMethods,
          review: baseline.review,
        },
        context,
        name,
        degradations,
      ).rule,
    );
  }

  return {
    name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include, exclude: [] } },
    rules,
  };
}

/**
 * A status-check ruleset. With no checks left it is *neutered* — deletion and
 * force-push protection only — which is what an existing ruleset must become
 * when its check cannot be produced; see statusCheckRulesets.
 */
function statusCheckRuleset(name, include, checks) {
  const rules = [{ type: "deletion" }, { type: "non_fast_forward" }];

  if (checks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: checks.map((context) => ({ context })),
      },
    });
  }

  return {
    name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include, exclude: [] } },
    rules,
  };
}

/**
 * The status-check groups the baseline requires — one ruleset each.
 *
 * A group is `{ruleset, checks, secrets}`. Several exist because a gate should
 * name itself: `PR-SCOPE-CHECK` requiring a Trivy scan would mislead anyone
 * reading the repository's rules, and renaming a live ruleset is not a fix —
 * rulesets are matched by name, so a rename creates a second one and leaves the
 * original in place, still enforcing.
 *
 * `statusChecks` / `statusCheckRuleset` / `statusCheckSecrets` remain the
 * single-group shorthand, so configs and committed per-repo overrides written
 * before groups existed compile to exactly what they did before.
 */
export function statusCheckGroups(config) {
  const baseline = config?.baseline ?? {};
  const groups = [];

  for (const group of baseline.statusCheckGroups ?? []) {
    if ((group?.checks ?? []).length === 0) continue;
    groups.push({
      ruleset: group.ruleset ?? "status-checks",
      checks: [...group.checks],
      secrets: [...(group.secrets ?? [])],
    });
  }

  if ((baseline.statusChecks ?? []).length > 0) {
    groups.push({
      ruleset: baseline.statusCheckRuleset ?? "status-checks",
      checks: [...baseline.statusChecks],
      secrets: [...(baseline.statusCheckSecrets ?? [])],
    });
  }

  // DERIVED, not declared. The Trivy gate exists exactly when the workflow that
  // reports it does, so turning Trivy off removes the requirement with it — a
  // required check nobody reports is impossible here by construction. The scope
  // check cannot work this way: an external suite may supply that context, which
  // is why it stays declared and needs the drop-loudly guard instead.
  const trivy = config?.prChecks?.trivy;
  if (trivy?.enabled) {
    groups.push({
      ruleset: trivy.rulesetName ?? DEFAULT_TRIVY_RULESET,
      checks: [trivy.statusCheck ?? TRIVY_CONTEXT],
      secrets: [],
    });
  }

  return groups;
}

/**
 * Status-check rulesets.
 *
 * `baseline.statusChecks` apply to EVERY declared environment, in one ruleset.
 * That is what makes an environment added later inherit the check instead of
 * becoming the one branch nobody verifies — the same single-source rule the
 * baseline pull_request rule and the nomenclature excludes already follow.
 *
 * Deliberately NOT the default branch, even though the baseline's other rules
 * cover it: the check that reports these contexts triggers on pull requests
 * targeting an *environment*, so requiring it on the default branch would
 * demand a check nothing ever reports there — permanently unmergeable.
 *
 * An environment may still name extra checks of its own; those keep their own
 * ruleset, minus anything the baseline already requires, so one check is never
 * demanded twice from two different rulesets.
 */
function statusCheckRulesets(config, context, degradations) {
  const environments = Object.keys(config.environments ?? {});
  const groups = statusCheckGroups(config);
  const existing = context.existingRulesetNames ?? [];
  const rulesets = [];

  /**
   * Drops the checks nothing can report here.
   *
   * A required check no workflow reports never turns green, so it does not guard
   * the branch — it blocks every merge into it, forever. That is the same
   * unsatisfiability rule the review requirements follow, and it matters more
   * now that one ruleset can carry a check across every environment.
   */
  const satisfiable = (checks, rulesetName, scope) => {
    const unavailable = new Set(context.unavailableStatusChecks ?? []);
    for (const check of checks.filter((c) => unavailable.has(c))) {
      degradations.push({
        ruleset: rulesetName,
        dropped: "required_status_checks",
        check,
        reason:
          `'${check}' cannot be reported on this repository, so requiring it on ${scope} would ` +
          "block every merge instead of guarding it",
        remedy: "restore whatever produces that check (see the SKIPPED line above), then re-run",
      });
    }
    return checks.filter((c) => !unavailable.has(c));
  };

  if (environments.length > 0) {
    for (const group of groups) {
      const kept = satisfiable(group.checks, group.ruleset, environments.join(", "));
      // Nothing survived: only worth emitting if a previous sync already created
      // it, and then only to neuter it — dropping it from the desired set would
      // leave the live ruleset demanding the same impossible check.
      if (kept.length > 0 || existing.includes(group.ruleset)) {
        rulesets.push(statusCheckRuleset(group.ruleset, environments.map(ref), kept));
      }
    }
  }

  // A check the baseline already requires everywhere is not demanded a second
  // time by an environment's own ruleset.
  const alreadyRequired = new Set(groups.flatMap((g) => g.checks));

  for (const [envName, env] of Object.entries(config.environments ?? {})) {
    const own = (env.statusChecks ?? []).filter((check) => !alreadyRequired.has(check));
    if (own.length === 0) continue;

    const name = env.statusCheckRuleset ?? `status-checks-${envName}`;
    const kept = satisfiable(own, name, envName);
    if (kept.length === 0 && !existing.includes(name)) continue;
    rulesets.push(statusCheckRuleset(name, [ref(envName)], kept));
  }

  return rulesets;
}

/**
 * An environment only gets its own reviewer ruleset when it asks for more than
 * the baseline: extra approvals, or a reviewing team.
 */
function reviewerRulesets(config, context, degradations) {
  const baselineApprovals = config.baseline?.requiredApprovals ?? 0;

  return Object.entries(config.environments ?? {})
    .filter(([, env]) => (env.requiredApprovals ?? 0) > baselineApprovals || (env.reviewerTeams ?? []).length > 0)
    .map(([envName, env]) => {
      const name = env.reviewerRuleset ?? `reviewers-${envName}`;
      const { rule, survived } = pullRequestRule(
        {
          approvals: env.requiredApprovals,
          teams: env.reviewerTeams,
          mergeMethods: env.allowedMergeMethods ?? config.baseline?.allowedMergeMethods,
          review: env.review ?? config.baseline?.review,
        },
        context,
        name,
        degradations,
      );

      // This ruleset exists ONLY to add a review on top of the baseline. If
      // none of that survived the target repo's limits there is nothing to
      // create — but if a previous sync already created it, it must still be
      // emitted, neutered. Dropping it from the desired set would leave the
      // live ruleset in place, still demanding the review this repo cannot
      // supply, still blocking every merge, and reported only as "unmanaged".
      if (!survived && !(context.existingRulesetNames ?? []).includes(name)) return null;

      return {
        name,
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: [ref(envName)], exclude: [] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }, rule],
      };
    })
    .filter(Boolean);
}

/**
 * The nomenclature ruleset is inverted: it targets every ref *except* the
 * environments, the default branch, and the allowed prefixes. A branch that
 * matches it is by definition badly named, and its `creation` rule is what
 * blocks it.
 */
function nomenclatureRuleset(config, context, degradations) {
  const naming = config.branchNaming;
  if (!naming) return null;

  const name = naming.rulesetName ?? "branch-nomenclature";
  const environments = Object.keys(config.environments ?? {});

  // Excluded refs are the *permitted* ones. Requiring a task id narrows each
  // prefix from "anything below it" to "a task-id segment, optionally followed
  // by a description", which is what lets a merge be traced back to a task.
  //
  // `requireDescription` makes the description segment mandatory too, so the
  // shape is `<prefix>/<task-id>/<description>`. That matters most when
  // `taskIdPrefix` is empty: with no prefix marking the id, `feature/*` matches
  // any word, so the third segment is the only thing left that a
  // ref pattern can actually insist on. Whether the second segment names a REAL
  // ticket is not knowable from a ref pattern at all — the scope check enforces
  // that at pull-request time, where the tracker can be asked.
  const permitted = (naming.allowedPrefixes ?? []).flatMap((prefix) => {
    if (!naming.requireTaskId) return [`${ref(prefix)}/**/*`];
    const id = `${ref(prefix)}/${naming.taskIdPrefix ?? "CU-"}*`;
    return naming.requireDescription ? [`${id}/**`] : [id, `${id}/**`];
  });

  const exclude = [
    ...environments.map(ref),
    ...(context.defaultBranch ? [ref(context.defaultBranch)] : []),
    ...permitted,
  ];

  const rules = [];
  if (naming.preventForcePush) rules.push({ type: "non_fast_forward" });
  if (naming.restrictCreation) rules.push({ type: "creation" });
  rules.push(
    pullRequestRule(
      {
        approvals: naming.requiredApprovals,
        teams: naming.reviewerTeams,
        mergeMethods: naming.allowedMergeMethods,
        review: naming.review,
      },
      context,
      name,
      degradations,
    ).rule,
  );

  return {
    name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~ALL"], exclude: dedupe(exclude) } },
    rules,
  };
}

const dedupe = (items) => [...new Set(items)];

/**
 * @param {object} config  parsed ruleset-config.json
 * @param {{ownerType: string, ownerLogin: string, defaultBranch: string, teamIds?: Record<string, number>}} context
 * @returns {{rulesets: object[], degradations: object[]}}
 */
export function compile(config, context) {
  const degradations = [];

  const rulesets = [
    baselineRuleset(config, context, degradations),
    ...statusCheckRulesets(config, context, degradations),
    ...reviewerRulesets(config, context, degradations),
    nomenclatureRuleset(config, context, degradations),
  ].filter(Boolean);

  const names = rulesets.map((r) => r.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) {
    throw new Error(
      `Config generates two rulesets named '${duplicate}'. Set a distinct statusCheckRuleset or reviewerRuleset name.`,
    );
  }

  return { rulesets, degradations };
}

/**
 * Teams referenced anywhere in the config, so the caller can resolve their
 * numeric ids before compiling.
 */
/**
 * Teams are addressed by slug. A config naming `org/My Team` would create a
 * team whose GitHub-derived slug is `my-team`, which the next run then fails
 * to find — queueing a second create that GitHub refuses as a duplicate name.
 * Refusing up front beats that loop.
 */
export function assertTeamSlugs(teams) {
  const bad = teams.filter((t) => !/^[\w.-]+\/[a-z0-9][a-z0-9-]*$/.test(t));
  if (bad.length > 0) {
    throw new Error(
      `reviewerTeams must be 'org/team-slug', lowercase and hyphenated: ${bad.join(", ")}. ` +
        "The slug is in the team's GitHub URL (/orgs/<org>/teams/<slug>).",
    );
  }
}

/**
 * Environment names must not be integer-like. JS enumerates integer-like keys
 * first, in numeric order, so an environment called `2` would silently become
 * the first pipeline stage regardless of where it is written — breaking the
 * "declaration order is the pipeline" rule the whole task sync rests on.
 */
export function assertEnvironmentNames(config) {
  const numeric = Object.keys(config?.environments ?? {}).filter((n) => /^\d+$/.test(n));
  if (numeric.length > 0) {
    throw new Error(
      `Environment names must not be numbers: ${numeric.join(", ")}. ` +
        "They would jump to the front of the task-sync pipeline regardless of their position.",
    );
  }
}

export function referencedTeams(config) {
  const teams = [
    ...(config.baseline?.reviewerTeams ?? []),
    ...(config.branchNaming?.reviewerTeams ?? []),
    ...Object.values(config.environments ?? {}).flatMap((env) => env.reviewerTeams ?? []),
  ];
  // Deliberately NOT environmentProfiles: a profile is inert until its
  // environment is added, and addEnvironments runs first, so an environment
  // added this run is already in `environments` by the time teams resolve.
  // Scanning profiles here would plan to create a team for an environment
  // nobody asked for.
  return dedupe(teams);
}

/**
 * Secrets a required status check needs in order to actually run — e.g. the
 * `scope-check` context calls an AI provider and needs `OPENROUTER_API_KEY`.
 *
 * Read from the baseline (where a check covering every environment is declared)
 * as well as per environment, so moving a check up to the baseline does not
 * quietly stop the sync from checking for its secret.
 */
export function requiredStatusCheckSecrets(config) {
  const names = [
    ...statusCheckGroups(config).flatMap((group) => group.secrets),
    // Also read standalone, not only through a group: a repository may declare
    // the secret a check needs while the check itself is supplied from outside
    // this plugin, and dropping it would stop the sync verifying that secret
    // exists at all. Deduped, so the shorthand group naming it too costs nothing.
    ...(config?.baseline?.statusCheckSecrets ?? []),
    ...Object.values(config?.environments ?? {}).flatMap((env) => env.statusCheckSecrets ?? []),
  ];
  return dedupe(names);
}

/**
 * Adds environments to a config, returning the names that were genuinely new.
 *
 * A bare `{}` is deliberate: an environment with no settings still picks up
 * the baseline PR requirement and is excluded from the nomenclature ruleset,
 * which is the whole point of the environment list.
 */
export function addEnvironments(config, names) {
  config.environments ??= {};
  const added = [];

  for (const name of names) {
    if (Object.hasOwn(config.environments, name)) continue;
    // A known name brings its profile — adding 'prod' later must give the same
    // stricter policy as declaring it up front, or the environment that most
    // needs guarding would be the one that silently gets the least.
    const profile = config.environmentProfiles?.[name];
    config.environments[name] = profile ? structuredClone(profile) : {};
    added.push(name);
  }

  return added;
}

/** Environment names the config knows a profile for, in declaration order. */
export function knownEnvironments(config) {
  return Object.keys(config.environmentProfiles ?? {}).filter(
    (name) => !Object.hasOwn(config.environments ?? {}, name),
  );
}
