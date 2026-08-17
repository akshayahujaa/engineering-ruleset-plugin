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
      // execFileSync would otherwise let gh's own "gh: Not Found (HTTP 404)"
      // reach the terminal ahead of the message we build from it.
      stdio: ["pipe", "pipe", "pipe"],
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

/** Accepts an explicit `owner/repo`, so a target need not be cloned or cd'd into. */
export function parseSlug(slug) {
  const match = String(slug).trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new GitHubError(`--repo expects 'owner/name', got '${slug}'.`);
  return { owner: match[1], repo: match[2] };
}

export function createClient({ cwd = process.cwd(), repo: slug } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const useGh = ghCliAvailable();

  if (!useGh && !token) {
    throw new GitHubError(
      "No GitHub credentials. Either run `gh auth login`, or set GITHUB_TOKEN to a token with the 'repo' scope.",
    );
  }

  const request = (method, path, body) =>
    useGh ? requestViaGh(method, path, body) : requestViaToken(method, path, body, token);

  const { owner, repo } = slug ? parseSlug(slug) : resolveRepo(cwd);
  const base = `repos/${owner}/${repo}`;

  return {
    owner,
    repo,
    authMode: useGh ? "gh cli" : "token",

    /** The login the current credentials belong to, for naming it in access errors. */
    async viewer() {
      try {
        return (await request("GET", "user"))?.login ?? null;
      } catch {
        return null;
      }
    },

    /** Everything the compiler needs to know about the target repository. */
    async context() {
      const info = await request("GET", base);
      return {
        ownerType: info.owner.type,
        ownerLogin: info.owner.login,
        defaultBranch: info.default_branch,
        visibility: info.visibility,
        isAdmin: Boolean(info.permissions?.admin),
        permissions: info.permissions ?? {},
      };
    },

    /**
     * Resolves `org/team-slug` to the id the rulesets API expects, plus the
     * facts callers need about it: `members_count` decides whether a team
     * review is satisfiable at all, and the API-derived `slug` is what later
     * membership calls must use.
     */
    async teamInfo(team) {
      const [org, slug] = String(team).split("/");
      const info = await request("GET", `orgs/${org}/teams/${encodeURIComponent(slug)}`);
      return { id: info.id, slug: info.slug, membersCount: info.members_count ?? 0 };
    },

    /**
     * Invitations are account-scoped, not repo-scoped: a repo you cannot see
     * still has a visible pending invitation, which is what makes the 404 case
     * recoverable.
     */
    listInvitations: () => request("GET", "user/repository_invitations"),

    /** Accepting changes the user's account state; callers must get consent first. */
    acceptInvitation: (id) => request("PATCH", `user/repository_invitations/${id}`),

    /** Returns the file's decoded content and blob sha, or null when absent. */
    async getFile(filePath) {
      try {
        const info = await request("GET", `${base}/contents/${filePath}`);
        return { sha: info.sha, content: Buffer.from(info.content ?? "", "base64").toString("utf8") };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    /** Creating or updating a file needs the prior sha, or GitHub rejects the write. */
    putFile(filePath, content, message, sha) {
      return request("PUT", `${base}/contents/${filePath}`, {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
      });
    },

    /**
     * Sets a repository Actions secret by handing the terminal to `gh`, which
     * prompts with hidden input, encrypts the value locally against the
     * repository's public key, and uploads it.
     *
     * The value never enters this process: not argv, not env, not a pipe.
     * There is deliberately no variant accepting the token as an argument —
     * that would put it in shell history and the process table.
     */
    setSecretInteractive(name) {
      if (!useGh) {
        throw new GitHubError(
          "Setting a secret interactively needs the gh CLI. Run `gh auth login` first.",
        );
      }
      // Enforced here, not only in callers: with a piped stdin gh does not
      // prompt — it silently reads the secret VALUE from the pipe, which is
      // exactly the hidden-input guarantee this method exists to provide.
      if (!process.stdin.isTTY) {
        throw new GitHubError(
          "Refusing to set a secret without a terminal: gh would read the value from stdin instead of prompting.",
        );
      }
      execFileSync("gh", ["secret", "set", name, "--repo", `${owner}/${repo}`], {
        stdio: "inherit",
      });
    },

    /**
     * Collaborators who could approve a pull request.
     *
     * Only push-capable accounts count: an approval from someone without write
     * access does not satisfy `required_approving_review_count`. Paginated,
     * because "is a review requirement satisfiable" must not hinge on the
     * first page.
     */
    async pushCapableCollaborators() {
      const logins = [];
      for (let page = 1; ; page += 1) {
        const batch = await request("GET", `${base}/collaborators?per_page=100&page=${page}`);
        logins.push(...batch.filter((c) => c.permissions?.push).map((c) => c.login));
        if (batch.length < 100) return logins;
      }
    },

    /** Creates an org team. Requires org-admin rights on the token. */
    createTeam(org, name, description) {
      return request("POST", `orgs/${org}/teams`, {
        name,
        description: description ?? "Reviewers for repositories managed by engineering-ruleset-plugin",
        privacy: "closed",
      });
    },

    /** Adds (or confirms) a user's membership of a team. */
    addTeamMember(org, slug, username) {
      return request("PUT", `orgs/${org}/teams/${slug}/memberships/${username}`, { role: "member" });
    },

    /** Deletes a file via the Contents API; needs the current blob sha. */
    deleteFile(filePath, message, sha) {
      return request("DELETE", `${base}/contents/${filePath}`, { message, sha });
    },

    /** Whether a repository Actions variable exists. */
    async hasVariable(name) {
      try {
        await request("GET", `${base}/actions/variables/${name}`);
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },

    /**
     * Sets a repository Actions variable. Variables are for NON-sensitive
     * values only (a base URL, an email) — anything secret goes through
     * setSecretInteractive, never here.
     */
    async setVariable(name, value) {
      try {
        await request("POST", `${base}/actions/variables`, { name, value });
      } catch (error) {
        // 409: the variable already exists — update it instead.
        if (error.status === 409) {
          await request("PATCH", `${base}/actions/variables/${name}`, { name, value });
        } else {
          throw error;
        }
      }
    },

    /**
     * Whether a secret exists. The API never returns a secret's value, so this
     * can confirm the token is configured without ever reading it.
     */
    async hasSecret(name) {
      try {
        await request("GET", `${base}/actions/secrets/${name}`);
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },

    /** Paginated: a repo with >100 branches must not misreport one as missing. */
    listBranches: async () => {
      const names = [];
      for (let page = 1; ; page += 1) {
        const batch = await request("GET", `${base}/branches?per_page=100&page=${page}`);
        names.push(...batch.map((b) => b.name));
        if (batch.length < 100) return names;
      }
    },

    refSha: async (branch) => (await request("GET", `${base}/git/ref/heads/${branch}`)).object.sha,

    createRef: (ref, sha) => request("POST", `${base}/git/refs`, { ref, sha }),

    /**
     * Flips enforcement on an existing ruleset.
     *
     * Sends the whole ruleset rather than just the changed field: whether PUT
     * merges or replaces is not worth betting a repository's rules on, and a
     * whitelist is correct under either. Response-only fields are dropped
     * because GitHub rejects a payload carrying them.
     */
    setEnforcement: (ruleset, enforcement) =>
      request("PUT", `${base}/rulesets/${ruleset.id}`, {
        name: ruleset.name,
        target: ruleset.target,
        enforcement,
        bypass_actors: ruleset.bypass_actors ?? [],
        conditions: ruleset.conditions,
        rules: ruleset.rules,
      }),

    /**
     * Listing omits each ruleset's rules, so callers needing them must get()
     * by id. `includes_parents=false` keeps org-level rulesets out: they are
     * not managed here, would pollute drift detection, and cannot be updated
     * through the repo endpoint anyway.
     */
    listRulesets: () => request("GET", `${base}/rulesets?per_page=100&includes_parents=false`),

    /** Rules and conditions are needed to tell which ruleset blocks a creation. */
    async fullRulesets() {
      const summaries = await request("GET", `${base}/rulesets?per_page=100&includes_parents=false`);
      return Promise.all(summaries.map((r) => request("GET", `${base}/rulesets/${r.id}`)));
    },
    getRuleset: (id) => request("GET", `${base}/rulesets/${id}`),
    createRuleset: (payload) => request("POST", `${base}/rulesets`, payload),
    updateRuleset: (id, payload) => request("PUT", `${base}/rulesets/${id}`, payload),
  };
}
