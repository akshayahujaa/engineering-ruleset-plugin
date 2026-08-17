import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  loginInteractive,
  noCredentialsMessage,
  ghInstalled,
  hasGitHubCredentials,
} from "../src/github.js";

/**
 * Under the test runner stdin is not a TTY, which is exactly the condition
 * setSecretInteractive must refuse: with a piped stdin `gh secret set` reads
 * the secret VALUE from the pipe instead of prompting. The guard lives in the
 * primitive itself, not only in its callers.
 */
test("setSecretInteractive refuses without a terminal, before ever invoking gh", () => {
  assert.equal(process.stdin.isTTY, undefined, "precondition: the test runner has no TTY stdin");
  const client = createClient({ repo: "acme/widgets" });
  assert.throws(() => client.setSecretInteractive("CLICKUP_TOKEN"), /without a terminal/);
});

/**
 * `gh auth login`'s interactive flow asks questions (protocol, account, auth
 * method) a pipe cannot answer, so it needs the same TTY guard as
 * setSecretInteractive — and for the same reason: the guard must live in the
 * primitive, not only in whatever calls it.
 */
test("loginInteractive refuses without a terminal, before ever invoking gh", () => {
  assert.equal(process.stdin.isTTY, undefined, "precondition: the test runner has no TTY stdin");
  assert.throws(() => loginInteractive(), /without a terminal/);
});

test("noCredentialsMessage points at gh auth login when gh is installed", () => {
  const msg = noCredentialsMessage(true);
  assert.match(msg, /gh auth login/);
  assert.match(msg, /GITHUB_TOKEN/);
  assert.doesNotMatch(msg, /not installed/);
});

test("noCredentialsMessage tells you to install gh when it is missing", () => {
  const msg = noCredentialsMessage(false);
  assert.match(msg, /not installed/);
  assert.match(msg, /cli\.github\.com/);
  assert.match(msg, /GITHUB_TOKEN/, "the token alternative still applies without gh");
});

/**
 * With no `gh` reachable at all, GITHUB_TOKEN alone must still satisfy the
 * credential gate — this OR is what lets a CI runner with no gh CLI installed
 * use the plugin via a plain token. PATH is restricted (rather than mocking)
 * to prove ghAuthenticated() really cannot find a binary to shell out to, not
 * just that it returns false for some other reason.
 */
test("hasGitHubCredentials is satisfied by GITHUB_TOKEN alone, with no gh on PATH", () => {
  const originalPath = process.env.PATH;
  const originalToken = process.env.GITHUB_TOKEN;
  try {
    process.env.PATH = "/nonexistent-path-for-this-test-only";
    assert.equal(ghInstalled(), false, "precondition: gh is unreachable on this PATH");

    delete process.env.GITHUB_TOKEN;
    assert.equal(hasGitHubCredentials(), false, "no gh and no token: nothing to authenticate with");

    process.env.GITHUB_TOKEN = "ghp_faketoken";
    assert.equal(hasGitHubCredentials(), true, "the token alone is enough");
  } finally {
    process.env.PATH = originalPath;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
