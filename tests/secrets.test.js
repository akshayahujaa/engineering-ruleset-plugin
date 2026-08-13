import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/github.js";

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
