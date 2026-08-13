/**
 * Compiles ruleset-config.json into GitHub ruleset API payloads.
 *
 * Pure: no filesystem, no network. Everything the compiler needs about the
 * target repository arrives in `context`, so generation is fully testable.
 */

const ref = (branch) => `refs/heads/${branch}`;

/**
 * `required_reviewers` binds a GitHub team, which only resolves when the
 * repository's owner is the organisation that owns the team. Personal repos,
 * and org repos naming a team from a different org, cannot use it.
 */
function teamIsUsable(team, context) {
  if (context.ownerType !== "Organization") return false;
  const org = String(team).split("/")[0];
  return org.toLowerCase() === String(context.ownerLogin).toLowerCase();
}

/**
 * Builds a pull_request rule, dropping the team requirement when the target
 * repo cannot honour it. Every drop is recorded so the plan can report it
 * instead of silently weakening the policy.
 */
function pullRequestRule({ approvals, teams, mergeMethods }, context, rulesetName, degradations) {
  const parameters = { required_approving_review_count: approvals ?? 0 };

  if (mergeMethods) parameters.allowed_merge_methods = mergeMethods;

  const usable = (teams ?? []).filter((team) => {
    if (teamIsUsable(team, context)) return true;
    degradations.push({
      ruleset: rulesetName,
      dropped: "required_reviewers",
      team,
      reason:
        context.ownerType === "Organization"
          ? `team '${team}' does not belong to org '${context.ownerLogin}'`
          : `'${context.ownerLogin}' is a user account, which cannot require team review`,
    });
    return false;
  });

  if (usable.length > 0) {
    parameters.required_reviewers = usable.map((team) => ({
      minimum_approvals: 1,
      file_patterns: ["*"],
      reviewer: { id: context.teamIds?.[team], type: "Team" },
    }));
  }

  return { type: "pull_request", parameters };
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
    rules.push(
      pullRequestRule(
        {
          approvals: baseline.requiredApprovals,
          teams: baseline.reviewerTeams,
          mergeMethods: baseline.allowedMergeMethods,
        },
        context,
        name,
        degradations,
      ),
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

function statusCheckRulesets(config, _context, _degradations) {
  return Object.entries(config.environments ?? {})
    .filter(([, env]) => (env.statusChecks ?? []).length > 0)
    .map(([envName, env]) => ({
      name: env.statusCheckRuleset ?? `status-checks-${envName}`,
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: [ref(envName)], exclude: [] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: env.statusChecks.map((context) => ({ context })),
          },
        },
      ],
    }));
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
      return {
        name,
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: [ref(envName)], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          pullRequestRule(
            {
              approvals: env.requiredApprovals,
              teams: env.reviewerTeams,
              mergeMethods: env.allowedMergeMethods ?? config.baseline?.allowedMergeMethods,
            },
            context,
            name,
            degradations,
          ),
        ],
      };
    });
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

  const exclude = [
    ...environments.map(ref),
    ...(context.defaultBranch ? [ref(context.defaultBranch)] : []),
    ...(naming.allowedPrefixes ?? []).map((prefix) => `${ref(prefix)}/**/*`),
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
      },
      context,
      name,
      degradations,
    ),
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
export function referencedTeams(config) {
  const teams = [
    ...(config.baseline?.reviewerTeams ?? []),
    ...(config.branchNaming?.reviewerTeams ?? []),
    ...Object.values(config.environments ?? {}).flatMap((env) => env.reviewerTeams ?? []),
  ];
  return dedupe(teams);
}
