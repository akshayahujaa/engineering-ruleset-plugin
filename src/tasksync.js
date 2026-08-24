/**
 * Task-tracker sync: on a merge into the target branch, advance the linked
 * task. ClickUp, Jira, and Kaneo sit behind one plan/apply surface.
 *
 * Pure logic plus workflow rendering — no network beyond what the client
 * does, and never a token: credentials live as repository secrets and are
 * read only by the workflow running on GitHub. The conventions match the
 * pr-guardrails scope-check suite (`ISSUE_PROVIDER: clickup | jira | kaneo`,
 * `JIRA_BASE_URL`/`JIRA_EMAIL` variables + `JIRA_API_TOKEN` secret), so one
 * repository setup feeds both tools.
 */

/** ClickUp's own default to-do status, plus the spellings teams commonly use. */
export const DEFAULT_TODO_STATUSES = ["to do", "todo", "open", "backlog", "pending"];

export const DEFAULT_TODO_STATUSES_BY_PROVIDER = {
  kaneo: ["to-do", "todo", "open", "backlog", "pending"],
};

/**
 * What the conventional environments mean in a tracker, when the config does
 * not say. Without these, an unlisted `dev` would map to a status literally
 * called "dev" — which no workspace has, so every merge would fail. Any other
 * environment name still falls back to itself, which is what makes a new
 * `staging` work with no configuration at all.
 */
export const DEFAULT_ENVIRONMENT_STATUSES = {
  dev: "in progress",
  test: "QA",
  // Several names, because boards disagree about this one and all of them mean
  // the same thing. The first that the board actually has is the one written.
  prod: ["done", "complete", "completed"],
};

export const DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER = {
  kaneo: {
    dev: "in-progress",
    test: "in-review",
    prod: "done",
  },
};

/**
 * Kaneo's board has exactly four columns — to-do, in-progress, in-review,
 * done. `DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER` above assumes none of them
 * is claimed yet, so a merge into `dev` gets to be "in-progress": the first
 * sign work has started.
 *
 * With a push stage configured, that sign already happened at push time —
 * `DEFAULT_PUSH_STATUS_BY_PROVIDER` puts the task at "in-progress" before any
 * merge exists to claim it. Reusing the same default for `dev` would not
 * advance the task at all, just repeat a status it already has. Once push
 * owns "in-progress", the two columns left on the board are what `dev` and
 * `prod` advance to instead. There is deliberately no default for a third
 * environment here — Kaneo has no fifth column to give it, so a repo that
 * declares one (e.g. `test`) alongside push falls back to the generic
 * `DEFAULT_ENVIRONMENT_STATUSES` and must name the real status itself in
 * `environmentStatuses` if that generic guess is wrong.
 */
export const DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER_WITH_PUSH = {
  kaneo: {
    dev: "in-review",
    prod: "done",
  },
};

/**
 * The push stage has no per-provider default the way `environmentStatuses`
 * does — `branchPushStatus` is one scalar, not a map keyed by environment, so
 * there is no "was this key explicitly set" to branch on. The shared example
 * in the README sets it to `"in progress"`, which is ClickUp/Jira's own
 * spelling; Kaneo's board uses the hyphenated `"in-progress"` (see
 * `DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER` above). A Kaneo repo configured
 * the same way as a ClickUp one — copying that example verbatim, exactly as
 * every other provider's setup docs show — would ask Kaneo to write a status
 * it does not have, and the push would never move the task out of to-do.
 *
 * `pushStage` folds this in as an *additional accepted name*, so both
 * spellings are tried on write and both rank as "arrived" — the same
 * many-names support `environmentStatuses` already has for `prod`.
 */
export const DEFAULT_PUSH_STATUS_BY_PROVIDER = {
  kaneo: "in-progress",
};

export const PROVIDERS = {
  clickup: {
    label: "ClickUp",
    workflowPath: ".github/workflows/clickup-sync.yml",
    secretName: "CLICKUP_TOKEN",
    taskIdPrefix: "CU-",
    requiredVariables: [],
    // A URL, not a breadcrumb trail through a settings tree: whoever holds the
    // account should be able to open one link and generate the token there.
    tokenHint: "https://app.clickup.com/settings/apps  (Apps → API Token; the value starts 'pk_')",
    variableHints: {},
  },
  jira: {
    label: "Jira",
    workflowPath: ".github/workflows/jira-sync.yml",
    secretName: "JIRA_API_TOKEN",
    taskIdPrefix: "",
    requiredVariables: ["JIRA_BASE_URL", "JIRA_EMAIL"],
    tokenHint:
      "https://id.atlassian.com/manage-profile/security/api-tokens  (Create API token; the value starts 'ATATT')",
    // Where each non-sensitive variable comes from. Kept beside the token hint
    // so the interactive prompt and the plan's fallback cannot drift apart.
    variableHints: {
      JIRA_BASE_URL:
        "the root URL of your Jira site, e.g. https://your-company.atlassian.net — copy it from the browser bar, with no trailing slash or path",
      JIRA_EMAIL:
        "the Atlassian account email that created the API token — https://id.atlassian.com/manage-profile/profile-and-visibility",
    },
  },
  kaneo: {
    label: "Kaneo",
    workflowPath: ".github/workflows/kaneo-sync.yml",
    secretName: "KANEO_API_TOKEN",
    taskIdPrefix: "",
    requiredVariables: ["KANEO_API_URL", "KANEO_PROJECT_ID"],
    tokenHint: "https://kaneo.mintlify.app/api-reference/authentication  (create an API key)",
    variableHints: {
      KANEO_API_URL:
        "the Kaneo API base URL, including /api, e.g. https://cloud.kaneo.app/api or your self-hosted URL",
      KANEO_PROJECT_ID:
        "the Kaneo project ID whose task numbers are used in branches such as feature/PROJ-2/description",
    },
  },
};

/**
 * Whether the tracker's credentials still need setting up.
 *
 * Deliberately says nothing about whether the provider was just *chosen*. That
 * used to be the gate, and it left the commonest case unasked: the bundled
 * config already names `clickup`, so `--provider clickup` changed nothing and
 * therefore prompted for nothing — on a real terminal, with no token set. The
 * only question that matters is whether the credentials are there.
 *
 * @param {{provider?: string, hasToken?: boolean, missingVariables?: string[]}} state
 */
export function trackerCredentialsMissing(state = {}) {
  const { provider, hasToken, missingVariables = [] } = state;
  if (!provider || !PROVIDERS[provider]) return false;
  return !hasToken || missingVariables.length > 0;
}

/**
 * Resolves the task-sync section of the policy to one normalized shape.
 *
 * `taskSync` is the section's name; a legacy `clickup` section is honoured
 * as `provider: "clickup"` so configs written before providers existed keep
 * working unchanged. Returns null when the feature is off.
 */
export function normalizeTaskSync(config) {
  const raw = config?.taskSync ?? config?.clickup;
  if (!raw?.enabled) return null;

  const provider = raw.provider ?? "clickup";
  const known = PROVIDERS[provider];
  if (!known) {
    throw new Error(
      `Unknown task-sync provider '${provider}'. Supported: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }

  return {
    provider,
    taskIdPrefix: raw.taskIdPrefix ?? known.taskIdPrefix,
    todoStatuses: raw.todoStatuses ?? DEFAULT_TODO_STATUSES_BY_PROVIDER[provider] ?? DEFAULT_TODO_STATUSES,
    // The status a task moves to when its branch is first pushed — work has
    // started, before anything is merged anywhere. Off unless configured:
    // switching it on by default would start writing to the tracker on every
    // push in every repo already synced, which is not a version bump's call.
    branchPushStatus: raw.branchPushStatus ?? null,
    // Per-environment target statuses. The legacy single-branch form
    // (targetBranch + targetStatus) maps onto exactly one stage.
    environmentStatuses:
      raw.environmentStatuses ??
      (raw.targetBranch ? { [raw.targetBranch]: raw.targetStatus ?? "in progress" } : undefined),
    // Only set for the legacy single-branch form, whose branch may not be a
    // declared environment at all. An explicit environmentStatuses map is a
    // lookup table, not a list of stages — a status declared there for an
    // environment the repo does not have must not become one.
    legacyBranch: raw.environmentStatuses ? undefined : raw.targetBranch,
    secretName: raw.secretName ?? known.secretName,
  };
}

/** An opt-out spelling for a status: nothing to move to. */
const optedOut = (status) => status === null || status === undefined || status === false || status === "";

/**
 * The names one stage accepts, in preference order.
 *
 * A stage's status may be a single name or a list of them. Trackers disagree
 * about what the last column is called — `done`, `complete`, `completed` — and
 * they all mean the same thing, so insisting on one spelling makes the sync fail
 * on a board that is set up perfectly reasonably. The first name is preferred
 * when writing; every name is recognised when ranking.
 *
 * A list whose entries are all opt-out spellings opts the stage out, exactly as
 * a bare `null` does.
 */
export function statusNames(value) {
  return (Array.isArray(value) ? value : [value]).filter((v) => !optedOut(v)).map((v) => String(v));
}

/**
 * The stage a task reaches when its branch is PUSHED, before any merge.
 *
 * It is always rank 1 — ahead of every environment — because pushing the branch
 * is the earliest evidence the work has actually started, which is exactly the
 * transition a to-do task is waiting for. Environment stages shift up behind it
 * so the forwards-only rule still holds end to end.
 *
 * The trigger patterns come from `branchNaming.allowedPrefixes`, so the one list
 * that decides which branch names are legal also decides which pushes count.
 * With no prefixes there is nothing to match, and no stage; see
 * `pushStageBlocked` for saying so out loud.
 *
 * The configured status is tried first, but see
 * `DEFAULT_PUSH_STATUS_BY_PROVIDER`: a provider whose own convention differs
 * from the configured spelling gets it folded in as a second accepted name,
 * so the shared example config works on that provider's real board too.
 *
 * @returns {{status: string, rank: 1, prefixes: string[]}|null}
 */
export function pushStage(config, sync) {
  if (optedOut(sync?.branchPushStatus)) return null;

  const prefixes = config?.branchNaming?.allowedPrefixes ?? [];
  if (prefixes.length === 0) return null;

  const configured = statusNames(sync.branchPushStatus);
  // An empty list (`[]`) is a documented opt-out, same as `null` — it must not
  // be rescued back to life by a provider default the operator never asked for.
  const providerDefault = configured.length > 0 ? DEFAULT_PUSH_STATUS_BY_PROVIDER[sync?.provider] : undefined;
  const names =
    providerDefault && !configured.some((n) => n.toLowerCase() === providerDefault.toLowerCase())
      ? [...configured, providerDefault]
      : configured;

  return { status: names[0], statuses: names, rank: 1, prefixes: [...prefixes] };
}

/**
 * Why a configured push stage produced nothing, so the plan can say it rather
 * than silently shipping a workflow that ignores half the config.
 *
 * @returns {string|null} null when there is nothing wrong
 */
export function pushStageBlocked(config, sync) {
  if (optedOut(sync?.branchPushStatus)) return null;
  if ((config?.branchNaming?.allowedPrefixes ?? []).length > 0) return null;

  return (
    "branchNaming.allowedPrefixes is empty, so there are no branch patterns a push could match — " +
    "add the prefixes your work branches use, or remove taskSync.branchPushStatus"
  );
}

/**
 * Every stage a status can be ranked against, the push stage included.
 *
 * Ranking the task's CURRENT status needs the push stage as well as the
 * environments: a task sitting at the push status must rank as 1, or the first
 * merge would read it as "not in the pipeline" and leave it there forever —
 * which is the one thing that would make the push stage a trap rather than a
 * head start.
 */
export const rankedStages = (push, pipeline = []) =>
  push
    ? [{ env: null, status: push.status, statuses: push.statuses ?? [push.status], rank: push.rank }, ...pipeline]
    : [...pipeline];

/**
 * The ordered pipeline a task walks as its branch is merged onward.
 *
 * Order comes from the order of `environments` in the config — that IS the
 * delivery pipeline — and each stage carries the tracker status to move to.
 * A status is taken from `environmentStatuses`, falling back to the
 * environment's own name, so a newly added `staging` maps to a `staging`
 * status without any extra configuration. An explicit `null` opts an
 * environment out of task sync entirely.
 *
 * Rank is what makes "never drag a task backwards" work with more than one
 * target: every to-do status sits at rank 0, and a merge only advances a task
 * whose current rank is strictly lower than the stage it is arriving at.
 *
 * @returns {Array<{env: string, status: string, rank: number}>}
 */
export function statusPipeline(config, sync) {
  // A push stage occupies rank 1, so every environment shifts up behind it —
  // and, for a provider whose board has a fixed set of columns, changes which
  // column each environment defaults to; see
  // DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER_WITH_PUSH.
  const push = pushStage(config, sync);
  const offset = push ? 1 : 0;
  const providerDefaults =
    (push && DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER_WITH_PUSH[sync?.provider]) ??
    DEFAULT_ENVIRONMENT_STATUSES_BY_PROVIDER[sync?.provider] ??
    {};

  // The legacy single-branch form synced exactly one branch. Upgrading must
  // not quietly start moving tasks on merges into other environments.
  if (sync?.legacyBranch) {
    const names = statusNames(sync.environmentStatuses?.[sync.legacyBranch] ?? "in progress");
    if (names.length === 0) return [];
    return [{ env: sync.legacyBranch, status: names[0], statuses: names, rank: 1 + offset }];
  }

  const explicit = sync?.environmentStatuses;
  const stages = [];

  for (const env of Object.keys(config?.environments ?? {})) {
    const configured =
      explicit && Object.hasOwn(explicit, env)
        ? explicit[env]
        : providerDefaults[env] ?? DEFAULT_ENVIRONMENT_STATUSES[env] ?? env;
    // null/false is the documented opt-out; "" would otherwise become a stage
    // that matches an unreadable tracker status. An empty list opts out too.
    const names = statusNames(configured);
    if (names.length === 0) continue;
    // `status` stays the preferred name, so the plan output and everything that
    // reads one status keep working; `statuses` is what ranking and writing use.
    stages.push({ env, status: names[0], statuses: names, rank: stages.length + 1 + offset });
  }

  return stages;
}

/**
 * Pulls the task id out of a branch name.
 *
 * Branches are `<prefix>/<taskIdPrefix><id>[/description]`, which the
 * nomenclature ruleset enforces at creation time — so a branch reaching a
 * merge without an id means the ruleset was bypassed, not that the format is
 * optional. Returns null rather than guessing.
 */
export function extractTaskId(branchName, { prefixes = [], taskIdPrefix = "CU-" } = {}) {
  if (!branchName) return null;

  const branch = String(branchName).replace(/^refs\/heads\//, "");
  const segments = branch.split("/");
  if (segments.length < 2) return null;

  const [prefix, candidate] = segments;
  if (prefixes.length > 0 && !prefixes.includes(prefix)) return null;
  if (!candidate.startsWith(taskIdPrefix)) return null;

  const id = candidate.slice(taskIdPrefix.length);
  return id.length > 0 ? id : null;
}

/**
 * Decides whether a task should move, given the status it is currently in.
 *
 * Only a to-do task advances. A task already in progress, in review, or done
 * is left alone — a later merge must never drag a task backwards, which is the
 * failure mode that makes people distrust this kind of automation.
 */
export function decideTransition(
  currentStatus,
  { todoStatuses = DEFAULT_TODO_STATUSES, target = "in progress", pipeline = [], targetRank } = {},
) {
  const current = String(currentStatus ?? "").trim().toLowerCase();
  if (!current) return { move: false, reason: "the task has no readable status" };

  const stages = pipeline.length > 0 ? pipeline : [{ status: target, rank: 1 }];
  const wantRank = targetRank ?? stages.find((s) => s.status.toLowerCase() === target.toLowerCase())?.rank;

  // Treating an unlocatable target as the first stage would advance tasks to a
  // status the pipeline does not contain, and report nonsense about the rest.
  if (wantRank === undefined) {
    return { move: false, reason: `target '${target}' is not a stage in the configured pipeline` };
  }
  // Two stages can share a status; arriving at one the task already holds is a
  // no-op, not a forward move. Writing it anyway makes Jira fail on a
  // self-transition that usually does not exist.
  if (current === target.toLowerCase()) {
    return { move: false, reason: `already '${currentStatus}'` };
  }

  // Rank 0 is everything before the pipeline starts.
  const currentRank = todoStatuses.map((s) => s.toLowerCase()).includes(current)
    ? 0
    : stages.find((s) => s.status.toLowerCase() === current)?.rank;

  // A status nobody declared could be anywhere in the workflow — including
  // past the end. Guessing risks dragging a task backwards, so it is left be.
  if (currentRank === undefined) {
    return { move: false, reason: `status '${currentStatus}' is not in the configured pipeline; leaving it alone` };
  }
  if (currentRank >= wantRank) {
    return { move: false, reason: `'${currentStatus}' is already at or past '${target}'` };
  }

  return { move: true, target, reason: `'${currentStatus}' comes before '${target}'` };
}

/** The first line of every rendered workflow — the ownership marker. */
export const GENERATED_MARKER = "# Generated by engineering-ruleset-plugin";

/** Single-quoted shell literal; the only user-controlled values are from config. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Single-quoted YAML scalar. Unquoted, an environment called `no`, `on` or
 * `2` is parsed as a boolean or a number and stops naming its branch, and a
 * `#`, `*`, `&` or quote breaks the document outright.
 */
const yamlQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** One-line, comment-safe: a newline in a name would split the YAML block. */
const commentSafe = (value) => String(value).replace(/\s+/g, " ").trim();


/** Every name a stage accepts, as shell literals. */
const acceptedNames = (stage) => (stage.statuses ?? [stage.status]).map((n) => shellQuote(n)).join(" ");

/**
 * `dev) want='in progress'; want_rank=1; set -- 'in progress' ;;` — one arm per
 * stage.
 *
 * The accepted names go into the positional parameters rather than a delimited
 * string: a status can contain a space ("in progress"), so there is no separator
 * that is safe to split on, and `set --` sidesteps the question entirely. Nothing
 * else in the generated script uses "$@".
 */
function branchCases(pipeline) {
  return pipeline
    .map(
      (st) =>
        `            ${shellQuote(st.env)}) want=${shellQuote(st.status)}; want_rank=${st.rank}; ` +
        `set -- ${acceptedNames(st)} ;;`,
    )
    .join("\n");
}

/**
 * The `on.push.branches` list, one pattern per allowed branch prefix, so a push
 * to a work branch fires the workflow. Environment branches are never in this
 * list — their stage is reached by a merge, not a push.
 */
function pushBranches(push) {
  return push.prefixes.map((prefix) => `      - ${yamlQuote(`${prefix}/**`)}`).join("\n");
}

/**
 * Picks the stage this run arrived at.
 *
 * With a push stage there are two ways in, so the event decides: a push to a
 * work branch is rank 1, and a merged pull request is its target environment's
 * stage. Without one, this is exactly the `case` it always was — so a config
 * that never asked for push sync renders byte-identical output.
 */
function stageSelection(push, pipeline) {
  const cases =
    `case "$BASE_REF" in\n${branchCases(pipeline)}\n` +
    `            *) echo "::warning::'$BASE_REF' is not a pipeline environment; nothing to sync."; exit 0 ;;\n` +
    `          esac`;

  if (!push) return cases;

  return (
    `if [ "\${EVENT_NAME:-}" = "push" ]; then\n` +
    `            want=${shellQuote(push.status)}; want_rank=${push.rank}; set -- ${acceptedNames(push)}\n` +
    `          else\n` +
    `            ${cases.split("\n").join("\n  ")}\n` +
    `          fi`
  );
}

/**
 * Ranks the task's CURRENT status. To-do spellings are rank 0; each pipeline
 * status takes its own rank; anything else stays unranked so the task is left
 * alone rather than risked backwards.
 */
function statusCases(pipeline, todo) {
  const seen = new Set();
  // An empty list must emit no arm at all: `) rank=0 ;;` is a bash syntax error
  // that only surfaces when the workflow runs, on every merge.
  const arms = todo.length
    ? [`            ${todo.map((t) => shellQuote(String(t).toLowerCase())).join("|")}) rank=0 ;;`]
    : [];
  for (const st of pipeline) {
    // Every name the stage accepts ranks at that stage. Without this a card
    // sitting in `completed` would be unranked, and the forwards-only guard
    // would read it as "not in the pipeline" and never touch it again.
    const keys = (st.statuses ?? [st.status]).map((n) => n.toLowerCase()).filter((k) => !seen.has(k));
    if (keys.length === 0) continue;
    for (const k of keys) seen.add(k);
    arms.push(`            ${keys.map(shellQuote).join("|")}) rank=${st.rank} ;;`);
  }
  arms.push("            *) rank=-1 ;;");
  return arms.join("\n");
}

/**
 * Renders the ClickUp workflow.
 *
 * It fires on a merge into ANY pipeline environment and moves the task to that
 * environment's status — and, when a push stage is configured, on a push to a
 * work branch too, which is what moves a to-do task the moment work starts.
 * Either way only forwards: a task whose current status already ranks at or past
 * the arriving stage is left alone, so merging an old branch into dev can never
 * pull a finished task back.
 */
export function renderClickUpWorkflow(sync = {}, pipeline = [], push = null) {
  const idPrefix = sync.taskIdPrefix ?? "CU-";
  const todo = sync.todoStatuses ?? DEFAULT_TODO_STATUSES;
  // Must match what planTaskSync checks and --set-token sets, or the
  // committed workflow would read a secret nobody ever wrote.
  const secretName = sync.secretName ?? "CLICKUP_TOKEN";
  // No invented default: a caller with no stages has nothing to sync, and
  // fabricating `dev → in progress` here silently defeated the documented
  // opt-out and rendered a workflow the plan never showed.
  const stages = pipeline;
  if (stages.length === 0) throw new Error("Cannot render a task-sync workflow with no pipeline stages.");
  // An empty idPrefix is the bare-task-id form; "No  task id" would read as a
  // typo, so the label collapses to just "task id" there.
  const idLabel = idPrefix ? `${idPrefix} task id` : "task id";

  return `# Generated by engineering-ruleset-plugin. Re-run the sync to update it;
# local edits are overwritten.
#
# Pipeline (a task only ever moves forwards):
${push ? `#   push ${push.prefixes.map((p) => `${commentSafe(p)}/**`).join(", ")} → ${commentSafe(push.status)}\n` : ""}\
${stages.map((st) => `#   merge into ${commentSafe(st.env)} → ${commentSafe(st.status)}`).join("\n")}
name: ClickUp task sync

on:
  pull_request:
    types: [closed]
    branches:
${stages.map((st) => `      - ${yamlQuote(st.env)}`).join("\n")}
${
  push
    ? `  # Work has started: the first push of a work branch moves its task out of to-do.\n` +
      `  push:\n    branches:\n${pushBranches(push)}\n`
    : ""
}\
  # Manual test entry: simulates a merged branch without needing a real PR,
  # so the wiring (secret, id extraction, ClickUp auth) can be verified alone.
  workflow_dispatch:
    inputs:
      head_ref:
        description: "Branch that was merged, e.g. feature/${idPrefix}123/thing"
        required: true
        type: string
      base_ref:
        description: ${yamlQuote(`Environment merged into (${stages.map((st) => commentSafe(st.env)).join(", ")})`)}
        required: false
        default: ${yamlQuote(stages[0].env)}
        type: string

permissions:
  contents: read

jobs:
  advance-task:
    # Closing a PR without merging must not touch the task.
    if: ${push ? "github.event_name == 'push' || " : ""}github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Advance the linked ClickUp task
        env:
          CLICKUP_TOKEN: \${{ secrets.${secretName} }}
          # Only needed when the workspace uses ClickUp Custom Task IDs.
          CLICKUP_TEAM_ID: \${{ secrets.CLICKUP_TEAM_ID }}
          EVENT_NAME: \${{ github.event_name }}
          # inputs.head_ref BEFORE github.ref_name: on a manual dispatch the ref
          # is whatever branch the run was started from, which would otherwise
          # win over the branch the operator actually typed.
          HEAD_REF: \${{ github.event.pull_request.head.ref || inputs.head_ref || github.ref_name }}
          BASE_REF: \${{ github.event.pull_request.base.ref || inputs.base_ref }}
        run: |
          set -euo pipefail

          if [ -z "\${CLICKUP_TOKEN:-}" ]; then
            echo "::warning::CLICKUP_TOKEN is not set; skipping ClickUp sync."
            exit 0
          fi

          # Which stage did this arrive at?
          want=""; want_rank=0
          ${stageSelection(push, stages)}

          # Branches are <prefix>/${idPrefix}<id>[/description], enforced by the
          # branch-nomenclature ruleset.
          id="$(printf '%s' "$HEAD_REF" | awk -F/ -v p=${shellQuote(idPrefix)} \\
            'index($2, p) == 1 { print substr($2, length(p) + 1) }')"

          if [ -z "$id" ]; then
            echo "::warning::No ${idLabel} in '$HEAD_REF'; nothing to sync."
            exit 0
          fi

          query=""
          if [ -n "\${CLICKUP_TEAM_ID:-}" ]; then
            query="?custom_task_ids=true&team_id=\${CLICKUP_TEAM_ID}"
          fi
          url="https://api.clickup.com/api/v2/task/\${id}\${query}"

          status="$(curl -sS -f -H "Authorization: $CLICKUP_TOKEN" "$url" \\
            | jq -r '.status.status // empty')"
          echo "Task $id is '\${status:-unknown}'; this \${EVENT_NAME:-event} wants '$want'."

          # Trimmed as well as lowered: the case patterns are exact literals,
          # so a padded status would fall through to "not in the pipeline".
          lower="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

          # Two stages may share a status; arriving at one already held is a
          # no-op. Any of the stage's accepted names counts as already there —
          # a card in 'completed' must not be rewritten to 'done'.
          for cand in "$@"; do
            if [ "$lower" = "$(printf '%s' "$cand" | tr '[:upper:]' '[:lower:]')" ]; then
              echo "Already '$status'; nothing to do."
              exit 0
            fi
          done

          rank=-1
          case "$lower" in
${statusCases(rankedStages(push, stages), todo)}
          esac

          # An unranked status could be anywhere in the workflow, including past
          # the end — guessing risks dragging the task backwards.
          if [ "$rank" -lt 0 ]; then
            echo "Status '\${status:-unknown}' is not in the configured pipeline; leaving task $id alone."
            exit 0
          fi
          if [ "$rank" -ge "$want_rank" ]; then
            echo "Task $id is already at or past '$want'; leaving it alone."
            exit 0
          fi

          # Boards disagree about what the last column is called, so the stage
          # may accept several names. Try them in order and keep the first the
          # board accepts. A rejected NAME is not a failure; a rejected
          # CREDENTIAL is, so those two are told apart rather than retried.
          moved=""
          for cand in "$@"; do
            code="$(curl -sS -o /tmp/clickup-put.json -w '%{http_code}' -X PUT \\
              -H "Authorization: $CLICKUP_TOKEN" \\
              -H "Content-Type: application/json" \\
              -d "$(jq -nc --arg s "$cand" '{status: $s}')" \\
              "$url" || true)"

            if [ "$code" = "200" ]; then moved="$cand"; break; fi
            case "$code" in
              401|403)
                echo "::error::ClickUp rejected the credentials (HTTP $code). Check the CLICKUP_TOKEN secret."
                exit 1
                ;;
            esac
            echo "'$cand' was not accepted (HTTP $code); trying the next name for this stage."
          done

          if [ -z "$moved" ]; then
            echo "::error::None of this stage's status names exist on task $id's board. Tried: $*"
            echo "::error::Rename the column, or list the name your board uses in taskSync.environmentStatuses."
            exit 1
          fi

          echo "Task $id moved to '$moved'."
`;
}

/**
 * Renders the Jira workflow.
 *
 * Same shape and guarantees as the ClickUp one, with Jira's model mapped in:
 * the issue key is the standard `PROJ-123` form found in the branch's second
 * segment (after the optional taskIdPrefix), status comes from
 * `fields.status.name`, and the move is a transition looked up by name at run
 * time — Jira transition ids are per-project, so they cannot be baked in.
 * Auth follows the scope-check convention: JIRA_BASE_URL and JIRA_EMAIL as
 * repository variables (not sensitive), JIRA_API_TOKEN as a secret.
 */
export function renderJiraWorkflow(sync = {}, pipeline = [], push = null) {
  const idPrefix = sync.taskIdPrefix ?? "";
  const todo = sync.todoStatuses ?? DEFAULT_TODO_STATUSES;
  const secretName = sync.secretName ?? "JIRA_API_TOKEN";
  // No invented default: a caller with no stages has nothing to sync, and
  // fabricating `dev → in progress` here silently defeated the documented
  // opt-out and rendered a workflow the plan never showed.
  const stages = pipeline;
  if (stages.length === 0) throw new Error("Cannot render a task-sync workflow with no pipeline stages.");
  const example = `${idPrefix}PROJ-123`;

  return `# Generated by engineering-ruleset-plugin. Re-run the sync to update it;
# local edits are overwritten.
#
# Pipeline (an issue only ever moves forwards):
${push ? `#   push ${push.prefixes.map((p) => `${commentSafe(p)}/**`).join(", ")} → ${commentSafe(push.status)}\n` : ""}\
${stages.map((st) => `#   merge into ${commentSafe(st.env)} → ${commentSafe(st.status)}`).join("\n")}
name: Jira issue sync

on:
  pull_request:
    types: [closed]
    branches:
${stages.map((st) => `      - ${yamlQuote(st.env)}`).join("\n")}
${
  push
    ? `  # Work has started: the first push of a work branch moves its issue out of to-do.\n` +
      `  push:\n    branches:\n${pushBranches(push)}\n`
    : ""
}\
  # Manual test entry: simulates a merged branch without needing a real PR,
  # so the wiring (variables, secret, key extraction, Jira auth) can be
  # verified alone.
  workflow_dispatch:
    inputs:
      head_ref:
        description: "Branch that was merged, e.g. feature/${example}/thing"
        required: true
        type: string
      base_ref:
        description: ${yamlQuote(`Environment merged into (${stages.map((st) => commentSafe(st.env)).join(", ")})`)}
        required: false
        default: ${yamlQuote(stages[0].env)}
        type: string

permissions:
  contents: read

jobs:
  advance-issue:
    # Closing a PR without merging must not touch the issue.
    if: ${push ? "github.event_name == 'push' || " : ""}github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Advance the linked Jira issue
        env:
          JIRA_BASE_URL: \${{ vars.JIRA_BASE_URL }}
          JIRA_EMAIL: \${{ vars.JIRA_EMAIL }}
          JIRA_API_TOKEN: \${{ secrets.${secretName} }}
          EVENT_NAME: \${{ github.event_name }}
          # inputs.head_ref BEFORE github.ref_name: on a manual dispatch the ref
          # is whatever branch the run was started from, which would otherwise
          # win over the branch the operator actually typed.
          HEAD_REF: \${{ github.event.pull_request.head.ref || inputs.head_ref || github.ref_name }}
          BASE_REF: \${{ github.event.pull_request.base.ref || inputs.base_ref }}
        run: |
          set -euo pipefail

          if [ -z "\${JIRA_API_TOKEN:-}" ] || [ -z "\${JIRA_BASE_URL:-}" ] || [ -z "\${JIRA_EMAIL:-}" ]; then
            echo "::warning::JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN is not set; skipping Jira sync."
            exit 0
          fi
          base="\${JIRA_BASE_URL%/}"

          # Which stage did this arrive at?
          want=""; want_rank=0
          ${stageSelection(push, stages)}

          # Branches are <prefix>/${idPrefix}<KEY>[/description]; the key is the
          # standard Jira form PROJ-123.
          seg="$(printf '%s' "$HEAD_REF" | awk -F/ -v p=${shellQuote(idPrefix)} \\
            'index($2, p) == 1 { print substr($2, length(p) + 1) }')"
          key="$(printf '%s' "$seg" | grep -oE '^[A-Za-z][A-Za-z0-9]*-[0-9]+' \\
            | head -1 | tr '[:lower:]' '[:upper:]' || true)"

          if [ -z "$key" ]; then
            echo "::warning::No Jira issue key in '$HEAD_REF'; nothing to sync."
            exit 0
          fi

          status="$(curl -sS -f -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \\
            "$base/rest/api/3/issue/$key?fields=status" \\
            | jq -r '.fields.status.name // empty')"
          echo "Issue $key is '\${status:-unknown}'; this \${EVENT_NAME:-event} wants '$want'."

          # Trimmed as well as lowered: the case patterns are exact literals,
          # so a padded status would fall through to "not in the pipeline".
          lower="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

          # Two stages may share a status; arriving at one already held is a
          # no-op, and Jira has no self-transition so writing it would fail the
          # job. Any accepted name counts as already there.
          for cand in "$@"; do
            if [ "$lower" = "$(printf '%s' "$cand" | tr '[:upper:]' '[:lower:]')" ]; then
              echo "Already '$status'; nothing to do."
              exit 0
            fi
          done

          rank=-1
          case "$lower" in
${statusCases(rankedStages(push, stages), todo)}
          esac

          if [ "$rank" -lt 0 ]; then
            echo "Status '\${status:-unknown}' is not in the configured pipeline; leaving issue $key alone."
            exit 0
          fi
          if [ "$rank" -ge "$want_rank" ]; then
            echo "Issue $key is already at or past '$want'; leaving it alone."
            exit 0
          fi

          # Transition ids are per-project, so the transition is found by name at
          # run time — matching ANY name this stage accepts, since a project may
          # call the final column 'Complete' rather than 'Done'. --args puts the
          # accepted names in $ARGS.positional, which keeps names containing
          # spaces intact.
          transition="$(curl -sS -f -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \\
            "$base/rest/api/3/issue/$key/transitions" \\
            | jq -r --args '
                ($ARGS.positional | map(ascii_downcase)) as $want
                | .transitions[]
                | . as $t
                | select(($want | index(($t.name // "") | ascii_downcase))
                      or ($want | index((($t.to.name) // "") | ascii_downcase)))
                | .id' "$@" \\
            | head -1 || true)"

          if [ -z "$transition" ]; then
            echo "::error::Issue $key has no transition from '$status' to any of: $*"
            echo "::error::Check the Jira workflow scheme, or list the name your project uses in taskSync.environmentStatuses."
            exit 1
          fi

          curl -sS -f -X POST \\
            -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -nc --arg id "$transition" '{transition: {id: $id}}')" \\
            "$base/rest/api/3/issue/$key/transitions" > /dev/null

          echo "Issue $key moved to '$want'."
`;
}

/**
 * Renders the Kaneo workflow. Kaneo branches use `<project-key>-<number>`
 * (for example `feature/PROJ-2/description`), while its task endpoints use an
 * internal task id. The workflow resolves the number inside the configured
 * project before updating the task.
 */
export function renderKaneoWorkflow(sync = {}, pipeline = [], push = null) {
  const idPrefix = sync.taskIdPrefix ?? "";
  const todo = sync.todoStatuses ?? DEFAULT_TODO_STATUSES;
  const secretName = sync.secretName ?? "KANEO_API_TOKEN";
  const stages = pipeline;
  if (stages.length === 0) throw new Error("Cannot render a task-sync workflow with no pipeline stages.");
  const example = `${idPrefix}PROJ-2`;

  return `# Generated by engineering-ruleset-plugin. Re-run the sync to update it;
# local edits are overwritten.
#
# Pipeline (a task only ever moves forwards):
${push ? `#   push ${push.prefixes.map((p) => `${commentSafe(p)}/**`).join(", ")} → ${commentSafe(push.status)}\n` : ""}\
${stages.map((st) => `#   merge into ${commentSafe(st.env)} → ${commentSafe(st.status)}`).join("\n")}
name: Kaneo task sync

on:
  pull_request:
    types: [closed]
    branches:
${stages.map((st) => `      - ${yamlQuote(st.env)}`).join("\n")}
${
    push
      ? `  # Work has started: the first push of a work branch moves its task out of to-do.\n` +
        `  push:\n    branches:\n${pushBranches(push)}\n`
      : ""
}\
  workflow_dispatch:
    inputs:
      head_ref:
        description: "Branch that was merged, e.g. feature/${example}/thing"
        required: true
        type: string
      base_ref:
        description: ${yamlQuote(`Environment merged into (${stages.map((st) => commentSafe(st.env)).join(", ")})`)}
        required: false
        default: ${yamlQuote(stages[0].env)}
        type: string

permissions:
  contents: read

jobs:
  advance-task:
    if: ${push ? "github.event_name == 'push' || " : ""}github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Advance the linked Kaneo task
        env:
          KANEO_API_URL: \${{ vars.KANEO_API_URL }}
          KANEO_API_TOKEN: \${{ secrets.${secretName} }}
          KANEO_PROJECT_ID: \${{ vars.KANEO_PROJECT_ID }}
          EVENT_NAME: \${{ github.event_name }}
          HEAD_REF: \${{ github.event.pull_request.head.ref || inputs.head_ref || github.ref_name }}
          BASE_REF: \${{ github.event.pull_request.base.ref || inputs.base_ref }}
        run: |
          set -euo pipefail

          if [ -z "\${KANEO_API_TOKEN:-}" ] || [ -z "\${KANEO_API_URL:-}" ] || [ -z "\${KANEO_PROJECT_ID:-}" ]; then
            echo "::warning::KANEO_API_URL, KANEO_PROJECT_ID, or KANEO_API_TOKEN is not set; skipping Kaneo sync."
            exit 0
          fi
          base="\${KANEO_API_URL%/}"

          want=""; want_rank=0
          ${stageSelection(push, stages)}

          # Branches are <prefix>/${idPrefix}<PROJECT>-<number>[/description].
          seg="$(printf '%s' "$HEAD_REF" | awk -F/ -v p=${shellQuote(idPrefix)} \\
            'index($2, p) == 1 { print substr($2, length(p) + 1) }')"
          key="$(printf '%s' "$seg" | grep -oE '^[A-Za-z][A-Za-z0-9]*-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]' || true)"
          number="$(printf '%s' "$key" | grep -oE '[0-9]+$' || true)"

          if [ -z "$key" ] || [ -z "$number" ]; then
            echo "::warning::No Kaneo task key in '$HEAD_REF'; nothing to sync."
            exit 0
          fi

          tasks="$(curl -sS -f -H "Authorization: Bearer $KANEO_API_TOKEN" \\
            -H "Accept: application/json" "$base/task/tasks/$KANEO_PROJECT_ID")"
          task="$(printf '%s' "$tasks" | jq -c --arg n "$number" '.. | objects | select((.number? | tostring) == $n and (.id? != null)) | {id, status, title} | select(.id != null)' | head -1 || true)"

          if [ -z "$task" ]; then
            echo "::warning::Kaneo task $key was not found in project $KANEO_PROJECT_ID; nothing to sync."
            exit 0
          fi
          id="$(printf '%s' "$task" | jq -r '.id')"
          status="$(printf '%s' "$task" | jq -r '.status // empty')"
          echo "Task $key ($id) is '\${status:-unknown}'; this \${EVENT_NAME:-event} wants '$want'."

          lower="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
          for cand in "$@"; do
            if [ "$lower" = "$(printf '%s' "$cand" | tr '[:upper:]' '[:lower:]')" ]; then
              echo "Already '$status'; nothing to do."
              exit 0
            fi
          done

          rank=-1
          case "$lower" in
${statusCases(rankedStages(push, stages), todo)}
          esac

          if [ "$rank" -lt 0 ]; then
            echo "Status '\${status:-unknown}' is not in the configured pipeline; leaving task $key alone."
            exit 0
          fi
          if [ "$rank" -ge "$want_rank" ]; then
            echo "Task $key is already at or past '$want'; leaving it alone."
            exit 0
          fi

          moved=""
          for cand in "$@"; do
            code="$(curl -sS -o /tmp/kaneo-status.json -w '%{http_code}' -X PUT \\
              -H "Authorization: Bearer $KANEO_API_TOKEN" \\
              -H "Content-Type: application/json" \\
              -d "$(jq -nc --arg s "$cand" '{status: $s}')" "$base/task/status/$id" || true)"
            if [ "$code" = "200" ]; then moved="$cand"; break; fi
            case "$code" in
              401|403)
                echo "::error::Kaneo rejected the credentials (HTTP $code). Check the KANEO_API_TOKEN secret."
                exit 1
                ;;
            esac
            echo "'$cand' was not accepted (HTTP $code); trying the next name for this stage."
          done

          if [ -z "$moved" ]; then
            echo "::error::None of this stage's status names exist for Kaneo task $key. Tried: $*"
            echo "::error::Use Kaneo's status names in taskSync.environmentStatuses."
            exit 1
          fi
          echo "Task $key moved to '$moved'."
`;
}

export const renderWorkflow = (sync, pipeline = [], push = null) =>
  (sync?.provider ?? "clickup") === "jira"
    ? renderJiraWorkflow(sync, pipeline, push)
    : (sync?.provider ?? "clickup") === "kaneo"
      ? renderKaneoWorkflow(sync, pipeline, push)
      : renderClickUpWorkflow(sync, pipeline, push);

/**
 * Works out what the task-sync side of a sync would change. Read-only.
 *
 * Credentials are only ever *checked for*, never written or read back: the
 * secret check can only say whether one exists, and required Jira variables
 * are reported by name when missing.
 */
export async function planTaskSync(client, config) {
  const sync = normalizeTaskSync(config);
  if (!sync) return null;

  const known = PROVIDERS[sync.provider];
  const pipeline = statusPipeline(config, sync);
  // Every environment opted out, or none declared: there is nothing to sync,
  // so no workflow is planned — and any existing one becomes an orphan and is
  // removed, rather than being left running against a pipeline of nothing.
  // A push stage alone is not enough: the workflow's other trigger is a pull
  // request into an environment, and there would be none to name.
  if (pipeline.length === 0) return null;
  const push = pushStage(config, sync);
  const desired = renderWorkflow(sync, pipeline, push);
  const existing = await client.getFile(known.workflowPath);

  const missingVariables = [];
  for (const name of known.requiredVariables) {
    if (!(await client.hasVariable(name))) missingVariables.push(name);
  }

  return {
    provider: sync.provider,
    providerLabel: known.label,
    path: known.workflowPath,
    action: !existing ? "create" : existing.content === desired ? "unchanged" : "update",
    content: desired,
    sha: existing?.sha,
    hasToken: await client.hasSecret(sync.secretName),
    secretName: sync.secretName,
    missingVariables,
    tokenHint: known.tokenHint,
    variableHints: known.variableHints ?? {},
    pipeline,
    push,
    // A push stage that was asked for and could not be built. Reported rather
    // than dropped: silence would look exactly like "not configured".
    pushBlocked: pushStageBlocked(config, sync),
  };
}

/**
 * Sync workflows at managed paths that belong to a provider OTHER than the
 * active one — left behind by a provider switch. They keep firing on every
 * merge (multiple trackers would move tasks), so the plan removes them. Only
 * the managed provider paths are ever considered; nothing else in
 * .github/workflows
 * is touched.
 */
export async function planSyncOrphans(client, activeProvider) {
  const orphans = [];
  for (const [name, def] of Object.entries(PROVIDERS)) {
    if (name === activeProvider) continue;
    const existing = await client.getFile(def.workflowPath);
    // Ownership is proven by the generated marker, not by the path: a file a
    // team wrote by hand at this path is theirs, and this plugin never
    // deletes what it did not create.
    if (existing && existing.content.startsWith(GENERATED_MARKER)) {
      orphans.push({ provider: name, providerLabel: def.label, path: def.workflowPath, sha: existing.sha });
    }
  }
  return orphans;
}

/** Removes one orphaned sync workflow. */
export async function removeSyncOrphan(client, orphan) {
  await client.deleteFile(
    orphan.path,
    `ci: remove ${orphan.providerLabel} task sync workflow (provider changed)`,
    orphan.sha,
  );
}

/** Writes the workflow. Credentials are never touched. */
export async function applyTaskSync(client, step) {
  if (!step || step.action === "unchanged") return { status: "unchanged" };

  await client.putFile(
    step.path,
    step.content,
    `ci: ${step.action} ${step.providerLabel} task sync workflow`,
    step.sha,
  );
  return { status: "applied", action: step.action };
}
