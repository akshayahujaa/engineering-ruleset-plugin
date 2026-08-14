/**
 * Policy resolution: which ruleset-config.json applies to the target repo.
 *
 * A repository may override the bundled policy by committing its own
 * `.github/ruleset-config.json`. Where the override is read from depends on
 * how the target was named:
 *
 * - implicit (cwd) — the working tree *is* the target, so the local file is
 *   authoritative and uncommitted edits are honoured deliberately.
 * - `--repo owner/name` — the override must come from THAT repository via the
 *   API. Reading the caller's directory here was a bug: standing in one repo
 *   while targeting another silently applied the wrong policy. There is no
 *   special case when `--repo` names the repo the cwd is checked out to — the
 *   checkout may be dirty or stale, and `--repo` always means the remote's
 *   live state, from any directory.
 *
 * A malformed override is a hard failure in both modes. Falling back to the
 * bundled policy would apply rules the repository explicitly replaced, while
 * the plan output names a source whose content was never used.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const OVERRIDE_PATH = ".github/ruleset-config.json";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bundledConfig(pluginRoot) {
  const bundled = path.join(pluginRoot, "ruleset-config.json");
  try {
    return {
      config: JSON.parse(readFileSync(bundled, "utf8")),
      origin: "bundled",
      label: "ruleset-config.json (plugin default)",
      writablePath: bundled,
    };
  } catch (error) {
    throw new Error(`Cannot read ruleset config at ${bundled}: ${error.message}`);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.client    authenticated GitHub client for the target repo
 * @param {boolean} opts.repoMode true when the target came from --repo
 * @param {string}  opts.cwd      the caller's directory, used only in implicit mode
 * @returns {Promise<{config: object, origin: 'remote-override'|'local-override'|'bundled',
 *                    label: string, writablePath: string|null}>}
 *          `writablePath` is where --env may persist; null means the policy
 *          lives in the target repo and can only change by a PR there.
 */
export async function resolveConfig({ client, repoMode, cwd, pluginRoot = PLUGIN_ROOT }) {
  if (repoMode) {
    const remote = await client.getFile(OVERRIDE_PATH);
    if (remote) {
      try {
        return {
          config: JSON.parse(remote.content),
          origin: "remote-override",
          label: `${client.owner}/${client.repo}:${OVERRIDE_PATH} (committed override)`,
          writablePath: null,
        };
      } catch (error) {
        throw new Error(
          `${client.owner}/${client.repo} commits ${OVERRIDE_PATH}, but it is not valid JSON: ` +
            `${error.message}. Fix or remove it — it will not be silently ignored.`,
        );
      }
    }
    return bundledConfig(pluginRoot);
  }

  const override = path.join(cwd, OVERRIDE_PATH);
  if (existsSync(override)) {
    try {
      return {
        config: JSON.parse(readFileSync(override, "utf8")),
        origin: "local-override",
        label: `${OVERRIDE_PATH} (this repo's override)`,
        writablePath: override,
      };
    } catch (error) {
      throw new Error(`Cannot read ruleset config at ${override}: ${error.message}`);
    }
  }
  return bundledConfig(pluginRoot);
}

/**
 * The marketplace clone is refreshed from its source repo, so an edit made
 * there does not survive `claude plugin marketplace update`.
 */
export const isMarketplaceClone = (p) =>
  p != null && p.split(path.sep).includes("marketplaces") && p.includes(`${path.sep}.claude${path.sep}`);

/** A branch name an environment can safely use; rejects globs, spaces, and traversal. */
export const isValidEnvName = (name) =>
  /^[\w][\w./-]*$/.test(name) && !name.includes("..") && !name.endsWith("/");

export function parseEnvList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The credential-setting flags; none of them ever takes a value. */
const TOKEN_FLAGS = ["--set-token", "--set-clickup-token"];

/**
 * Detects a token value that has already leaked into argv, so the CLI can say
 * so instead of silently ignoring it. Anything on a command line is exposed —
 * shell history, the process table — so the only honest response is to refuse
 * and tell the user to revoke it. ClickUp personal tokens start with `pk_`;
 * Atlassian (Jira) API tokens start with `ATATT`.
 *
 * @returns {string|null} a refusal message, or null when argv looks clean
 */
export function detectTokenMisuse(args) {
  const revoke =
    "If that was a real token it is now in your shell history and the process table: " +
    "revoke it (ClickUp: Settings → Apps → API Token; Jira: id.atlassian.com → Security → " +
    "API tokens) and generate a new one. The token is only ever accepted at gh's hidden " +
    "prompt — re-run with --set-token and nothing after it.";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = TOKEN_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
    if (flag && arg !== flag) {
      return `${flag} takes no value — a token must never appear on the command line. ${revoke}`;
    }
    if (/(^|=)pk_[A-Za-z0-9]/.test(arg) || /(^|=)ATATT[A-Za-z0-9]/.test(arg)) {
      return `The argument '${arg.slice(0, 8)}…' looks like an API token. ${revoke}`;
    }
    if (flag && args[i + 1] && !args[i + 1].startsWith("--")) {
      return `${flag} takes no value, but '${args[i + 1].slice(0, 8)}…' followed it. ${revoke}`;
    }
  }
  return null;
}
