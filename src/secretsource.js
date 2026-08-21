/**
 * Reading credentials from a secret manager and writing them into a
 * repository's Actions secrets — without the value passing through this
 * process.
 *
 * The existing route hands the terminal to `gh`, which prompts with hidden
 * input. That is safe but manual: one prompt, per secret, per repository. This
 * is the automated equivalent, and it keeps the same guarantee by the same
 * means — the plugin never holds the value.
 *
 * HOW THE VALUE AVOIDS THIS PROCESS. The fetch and the write are joined by one
 * shell, their halves connected by a kernel pipe:
 *
 *     gcloud secrets versions access … | gh secret set …
 *
 * Node spawns that single shell and inherits nothing but its exit status.
 * Piping the bytes through Node instead — `src.stdout.pipe(sink.stdin)` — would
 * put the plaintext in this process's heap, which is exactly what the
 * hidden-prompt design exists to avoid, so it is not done that way.
 *
 * WHY THE SHELL CANNOT BE INJECTED. The script text is a CONSTANT. Every value
 * — project, secret name, repository — arrives through the environment or as a
 * positional argument, so one containing `;` or a backtick is data rather than
 * code. Nothing is interpolated into the script.
 */

import { execFileSync, spawnSync } from "node:child_process";

/**
 * Where credentials can be read from. Only Google Secret Manager today; the
 * shape exists so a second one does not require reworking the callers.
 *
 * `fetchArgv` returns the argv for a command that writes the secret's bytes to
 * stdout and nothing else — no progress output, no trailing newline of its own.
 */
export const SOURCE_PROVIDERS = {
  "gcp-secret-manager": {
    label: "Google Secret Manager",
    cli: "gcloud",
    loginHint: "gcloud auth login",
    installHint: "https://cloud.google.com/sdk/docs/install",
    /** `gcloud auth list` exits 0 with an empty line when nothing is active. */
    authArgv: () => ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    fetchArgv: ({ sourceName, project, version }) => [
      "secrets",
      "versions",
      "access",
      version,
      `--secret=${sourceName}`,
      ...(project ? [`--project=${project}`] : []),
    ],
  },
};

/**
 * Resolves the `secretsSource` section, or null when the feature is off.
 *
 * @returns {{provider: string, label: string, project: string|null, version: string,
 *            mapping: Record<string,string>}|null}
 */
export function normalizeSecretsSource(config) {
  const raw = config?.secretsSource;
  if (!raw || raw.enabled === false) return null;

  const provider = raw.provider ?? "gcp-secret-manager";
  const known = SOURCE_PROVIDERS[provider];
  if (!known) {
    throw new Error(
      `Unknown secretsSource provider '${provider}'. Supported: ${Object.keys(SOURCE_PROVIDERS).join(", ")}.`,
    );
  }

  return {
    provider,
    label: known.label,
    project: raw.project ?? null,
    // Pinning a version is possible but 'latest' is what a rotation expects to
    // take effect without editing every config that names it.
    version: String(raw.version ?? "latest"),
    mapping: { ...(raw.mapping ?? {}) },
  };
}

/**
 * The name to look up in the secret manager for a given GitHub secret.
 *
 * An explicit mapping wins. Otherwise the GitHub name is lowercased and
 * underscores become hyphens — `CLICKUP_TOKEN` → `clickup-token` — which is the
 * usual convention for Secret Manager ids and means most configs need no
 * mapping at all.
 */
export function resolveSourceName(name, source) {
  return source?.mapping?.[name] ?? String(name).toLowerCase().replace(/_/g, "-");
}

/**
 * Whether the source's CLI is on PATH at all, independent of auth state.
 * Separate from the auth check for the same reason `ghInstalled` is: the two
 * failures need different messages.
 */
export function sourceCliInstalled(source) {
  const known = SOURCE_PROVIDERS[source.provider];
  try {
    execFileSync(known.cli, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether the source's CLI has an active credential. */
export function sourceAuthenticated(source) {
  const known = SOURCE_PROVIDERS[source.provider];
  try {
    const out = execFileSync(known.cli, known.authArgv(), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The message when the source cannot be reached. Pure, so the wording is
 * testable without shelling out — and deliberately telling the user to run the
 * login themselves: an OAuth flow asks interactive questions a pipe cannot
 * answer, the same reason `gh auth login` is never run on their behalf.
 */
export function noSourceAccessMessage(source, { installed }) {
  const known = SOURCE_PROVIDERS[source.provider];
  if (!installed) {
    return (
      `${source.label} is configured as the credential source, but '${known.cli}' is not installed.\n` +
      `Install it from ${known.installHint}, then run \`${known.loginHint}\`.`
    );
  }
  return (
    `${source.label} is configured as the credential source, but '${known.cli}' has no active login.\n` +
    `Run this yourself, in your own terminal:\n\n    ${known.loginHint}\n\n` +
    "It opens a browser flow that a pipe cannot answer, so it is never run for you."
  );
}

/**
 * The argv for the one shell that fetches and writes, joined by a pipe.
 *
 * Exported so a test can assert the exact command — including that no config
 * value is interpolated into the script. `kind` picks `gh secret set` for a
 * sensitive value or `gh variable set` for one that is not.
 *
 * @returns {{command: string, args: string[]}}
 */
export function pipelineArgv({ name, sourceName, kind, repo, source }) {
  const known = SOURCE_PROVIDERS[source.provider];
  const fetch = known.fetchArgv({ sourceName, project: source.project, version: source.version });

  // bash, not sh: `pipefail` is not POSIX, and without it a FAILED FETCH would
  // be masked by gh's exit status — writing an empty secret over a good one,
  // which is far worse than failing.
  //
  // The script is a CONSTANT. Every value arrives through the environment or as
  // a positional argument, so a project or secret name containing `;` or a
  // backtick is data. With `bash -c script bash a b c`, "$@" is exactly the
  // fetch arguments.
  const script =
    'set -o pipefail; "$SRC_CLI" "$@" | gh "$WRITE_KIND" set "$SECRET_NAME" --repo "$TARGET_REPO"';

  return {
    command: "/bin/bash",
    args: ["-c", script, "bash", ...fetch],
    env: {
      SRC_CLI: known.cli,
      WRITE_KIND: kind === "variable" ? "variable" : "secret",
      SECRET_NAME: name,
      TARGET_REPO: repo,
    },
  };
}

/**
 * Fetches one credential and writes it to the repository.
 *
 * `run` is injectable so tests can assert the command without executing it.
 * Nothing here ever reads the value: stdout is discarded and only stderr is
 * captured, so a failure can be reported without echoing what failed to write.
 *
 * @returns {{name: string, ok: boolean, error?: string}}
 */
export function pushCredential({ name, sourceName, kind, repo, source }, run = spawnSync) {
  const { command, args, env } = pipelineArgv({ name, sourceName, kind, repo, source });

  const result = run(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });

  if (result.status === 0) return { name, ok: true };

  // A secret manager's "not found" is the common case and worth naming plainly;
  // anything else is passed through as the tool reported it.
  const stderr = String(result.stderr ?? "").trim();
  const missing = /NOT_FOUND|not found|does not exist/i.test(stderr);
  return {
    name,
    ok: false,
    error: missing
      ? `'${sourceName}' was not found in ${source.label}${source.project ? ` (project ${source.project})` : ""}`
      : stderr.split("\n").slice(0, 3).join(" ") || `exit ${result.status}`,
  };
}

/**
 * What the source would be asked for, given what the repository is missing.
 *
 * Pure: the caller has already worked out which names are absent, so this only
 * decides where each comes from and whether it is a secret or a variable.
 *
 * @returns {Array<{name: string, sourceName: string, kind: 'secret'|'variable'}>}
 */
export function plannedFetches(source, { secrets = [], variables = [] } = {}) {
  return [
    ...secrets.map((name) => ({ name, sourceName: resolveSourceName(name, source), kind: "secret" })),
    ...variables.map((name) => ({ name, sourceName: resolveSourceName(name, source), kind: "variable" })),
  ];
}
