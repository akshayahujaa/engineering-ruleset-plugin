/**
 * All GitHub I/O: repository resolution, auth, and the Rulesets REST API.
 *
 * Auth prefers the `gh` CLI, which is usually already authenticated, and falls
 * back to GITHUB_TOKEN / GH_TOKEN.
 */

import { execFileSync } from "node:child_process";

export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

// --- repository resolution ---------------------------------------------------

/**
 * Parses `owner/repo` out of the origin remote, accepting both
 * https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
 */
export function parseRemote(url) {
  const cleaned = String(url).trim().replace(/\.git$/, "");
  const match =
    cleaned.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)$/) ||
    cleaned.match(/^ssh:\/\/[^/]+\/([^/]+)\/([^/]+)$/) ||
    cleaned.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+)$/);

  if (!match) throw new GitHubError(`Cannot parse a GitHub owner/repo out of remote '${url}'.`);
  return { owner: match[1], repo: match[2] };
}

export function resolveRepo(cwd) {
  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  } catch {
    throw new GitHubError(
      "No 'origin' remote found. Run this inside a git repository connected to GitHub.",
    );
  }
  return parseRemote(url);
}

// --- transport ---------------------------------------------------------------

function ghCliAvailable() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function requestViaGh(method, path, body) {
  const args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
  if (body !== undefined) args.push("--input", "-");

  try {
    const stdout = execFileSync("gh", args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    const raw = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const status = Number(raw.match(/HTTP (\d{3})/)?.[1]) || undefined;

    // gh interleaves its own "gh: ..." lines with the API's JSON body, so a
    // plain JSON.parse of the tail fails; fall back to lifting the message out.
    let parsed;
    const start = raw.indexOf("{");
    if (start !== -1) {
      for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
          break;
        } catch {
          /* try the next closing brace */
        }
      }
    }
    const message = parsed?.message ?? raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.trim();

    throw new GitHubError(message || `gh api ${method} ${path} failed`, { status, body: parsed });
  }
}

async function requestViaToken(method, path, body, token) {
  const response = await fetch(`https://api.github.com/${path.replace(/^\//, "")}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new GitHubError(parsed?.message ?? `HTTP ${response.status}`, {
      status: response.status,
      body: parsed,
    });
  }
  return parsed;
}

export function createClient({ cwd = process.cwd() } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const useGh = ghCliAvailable();

  if (!useGh && !token) {
    throw new GitHubError(
      "No GitHub credentials. Either run `gh auth login`, or set GITHUB_TOKEN to a token with the 'repo' scope.",
    );
  }

  const request = (method, path, body) =>
    useGh ? requestViaGh(method, path, body) : requestViaToken(method, path, body, token);

  const { owner, repo } = resolveRepo(cwd);
  const base = `repos/${owner}/${repo}`;

  return {
    owner,
    repo,
    authMode: useGh ? "gh cli" : "token",

    /** Everything the compiler needs to know about the target repository. */
    async context() {
      const info = await request("GET", base);
      return {
        ownerType: info.owner.type,
        ownerLogin: info.owner.login,
        defaultBranch: info.default_branch,
        visibility: info.visibility,
        isAdmin: Boolean(info.permissions?.admin),
      };
    },

    /** Resolves `org/team-slug` to the numeric id the rulesets API expects. */
    async teamId(team) {
      const [org, slug] = String(team).split("/");
      const info = await request("GET", `orgs/${org}/teams/${slug}`);
      return info.id;
    },

    /** Listing omits each ruleset's rules, so callers needing them must get() by id. */
    listRulesets: () => request("GET", `${base}/rulesets`),
    getRuleset: (id) => request("GET", `${base}/rulesets/${id}`),
    createRuleset: (payload) => request("POST", `${base}/rulesets`, payload),
    updateRuleset: (id, payload) => request("PUT", `${base}/rulesets/${id}`, payload),
  };
}
