#!/usr/bin/env node
/**
 * A stand-in for the `gh` CLI, so the whole command can be driven end to end
 * without touching GitHub.
 *
 * Responses come from the JSON file named by FAKE_GH_FIXTURE, keyed
 * `"<METHOD> <path>"`. A path with no entry answers 404 in gh's own wording,
 * which is how the real CLI reports an absent file, team, or secret — so a
 * fixture only has to list what exists.
 *
 * Every request is appended to FAKE_GH_LOG, which is what lets a test assert
 * that an apply really did create a team and add its members.
 */

import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);

// `gh --version` is only ever probed for its exit code, to detect that the
// binary exists at all (independent of whether anyone is logged in). Not
// logged to FAKE_GH_LOG: that file's shape (`{method, path, body}`) is what
// every existing test's `calls` assertions key off, and this call carries
// none of those fields.
if (args[0] === "--version") process.exit(0);

// `gh auth status` is only ever probed for its exit code. FAKE_GH_UNAUTHENTICATED
// simulates an installed-but-logged-out CLI, without touching the real one.
if (args[0] === "auth" && args[1] === "status") {
  process.exit(process.env.FAKE_GH_UNAUTHENTICATED ? 1 : 0);
}

// `gh auth login` is TTY-gated by the caller before this is ever reached in a
// real run (this harness never provides a real TTY), so it should be
// unreachable in practice; a fixed exit code is enough of a stand-in should a
// future test somehow get past that guard.
if (args[0] === "auth" && args[1] === "login") process.exit(0);

if (args[0] !== "api") {
  process.stderr.write(`fake gh: unsupported command '${args.join(" ")}'\n`);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const method = args[args.indexOf("-X") + 1];
const path = args[args.indexOf("-X") + 2];
const body = args.includes("--input") ? readFileSync(0, "utf8") : undefined;

if (process.env.FAKE_GH_LOG) {
  appendFileSync(
    process.env.FAKE_GH_LOG,
    `${JSON.stringify({ method, path, body: body ? JSON.parse(body) : undefined })}\n`,
  );
}

const response = fixture[`${method} ${path}`];

if (response === undefined) {
  process.stderr.write("gh: Not Found (HTTP 404)\n");
  process.exit(1);
}
if (response !== null && typeof response === "object" && response.__status) {
  process.stderr.write(
    `gh: ${response.__message ?? "Error"} (HTTP ${response.__status})\n` +
      JSON.stringify({ message: response.__message ?? "Error" }),
  );
  process.exit(1);
}

process.stdout.write(response === null ? "" : JSON.stringify(response));
