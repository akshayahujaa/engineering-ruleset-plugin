/**
 * The Trivy gate's decision logic.
 *
 * This is the part that decides whether a pull request can merge, so it is
 * tested directly rather than through a rendered workflow. Importing the asset
 * must not start it talking to GitHub — the guarded main() is what allows this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  withinScope,
  isBlocking,
  partition,
  tally,
  bySeverity,
  renderComment,
  SEVERITY_ORDER,
} from "../assets/trivy-report.mjs";

/** A report carrying one of each finding class, shaped as Trivy emits them. */
const REPORT = {
  Results: [
    {
      Target: "package-lock.json",
      Vulnerabilities: [
        {
          Severity: "CRITICAL",
          VulnerabilityID: "CVE-2024-0001",
          Title: "prototype pollution",
          PkgName: "lodash",
          PkgPath: "package-lock.json",
          InstalledVersion: "4.17.20",
          FixedVersion: "4.17.21",
        },
        {
          Severity: "CRITICAL",
          VulnerabilityID: "CVE-2024-0002",
          Title: "no fix yet",
          PkgName: "leftpad",
          PkgPath: "package-lock.json",
          InstalledVersion: "1.0.0",
          FixedVersion: "",
        },
        { Severity: "HIGH", VulnerabilityID: "CVE-2024-0003", PkgName: "axios", PkgPath: "package-lock.json", FixedVersion: "1.7.4" },
      ],
    },
    {
      Target: "src/config/db.ts",
      Secrets: [{ Severity: "CRITICAL", RuleID: "aws-access-key-id", Title: "AWS access key", StartLine: 14 }],
    },
    {
      Target: "Dockerfile",
      Misconfigurations: [
        { Severity: "HIGH", ID: "DS002", Title: "runs as root", Resolution: "add a USER directive", CauseMetadata: { StartLine: 3 } },
      ],
    },
  ],
};

// --- classification --------------------------------------------------------------

test("all three finding classes are flattened into one shape", () => {
  const found = classify(REPORT);
  assert.equal(found.length, 5);
  assert.deepEqual([...new Set(found.map((f) => f.kind))], ["vulnerability", "secret", "misconfiguration"]);

  const secret = found.find((f) => f.kind === "secret");
  assert.deepEqual(
    { file: secret.file, line: secret.line, severity: secret.severity },
    { file: "src/config/db.ts", line: 14, severity: "CRITICAL" },
  );
});

test("a dependency finding belongs to the file Trivy scanned, not the package", () => {
  // This is what makes changed-file scope meaningful: a lockfile is a file the
  // pull request either touched or did not.
  const vuln = classify(REPORT).find((f) => f.id === "CVE-2024-0001");
  assert.equal(vuln.file, "package-lock.json");
  assert.equal(vuln.line, null, "a resolved package has no line");
});

test("a misconfiguration carries its remedy, so the comment can say what to do", () => {
  const misconfig = classify(REPORT).find((f) => f.kind === "misconfiguration");
  assert.equal(misconfig.fix, "add a USER directive");
  assert.equal(misconfig.line, 3);
});

test("an empty or malformed report classifies to nothing rather than throwing", () => {
  assert.deepEqual(classify({}), []);
  assert.deepEqual(classify(null), []);
  assert.deepEqual(classify({ Results: [{ Target: "x" }] }), []);
});

test("a secret with no severity is treated as CRITICAL, not UNKNOWN", () => {
  // Trivy usually rates secrets CRITICAL; defaulting the other way would let a
  // hardcoded credential through the default threshold.
  const [found] = classify({ Results: [{ Target: "a.ts", Secrets: [{ RuleID: "generic" }] }] });
  assert.equal(found.severity, "CRITICAL");
});

// --- scope ------------------------------------------------------------------------

test("changed-files scope counts only files the pull request touched", () => {
  const secret = classify(REPORT).find((f) => f.kind === "secret");
  assert.equal(withinScope(secret, ["src/config/db.ts"], "changed-files"), true);
  assert.equal(withinScope(secret, ["README.md"], "changed-files"), false);
});

test("repository scope counts everything, changed or not", () => {
  const secret = classify(REPORT).find((f) => f.kind === "secret");
  assert.equal(withinScope(secret, [], "repository"), true);
});

test("a leading ./ does not make two spellings of one path look different", () => {
  const finding = { file: "./src/a.ts" };
  assert.equal(withinScope(finding, ["src/a.ts"], "changed-files"), true);
});

// --- the threshold ----------------------------------------------------------------

const OPTS = {
  blockOn: ["CRITICAL"],
  blockScope: "changed-files",
  ignoreUnfixed: true,
  changedFiles: ["package-lock.json", "src/config/db.ts", "Dockerfile"],
};

test("CRITICAL blocks and HIGH does not, at the default threshold", () => {
  const found = classify(REPORT);
  const blocked = found.filter((f) => isBlocking(f, OPTS)).map((f) => f.id);

  assert.deepEqual(blocked, ["CVE-2024-0001", "aws-access-key-id"]);
});

test("a CRITICAL vulnerability with no released fix is reported, never blocking", () => {
  // Nothing the author could do would clear this gate, which is the whole
  // argument for ignoreUnfixed.
  const unfixed = classify(REPORT).find((f) => f.id === "CVE-2024-0002");
  assert.equal(isBlocking(unfixed, OPTS), false);
  assert.equal(isBlocking(unfixed, { ...OPTS, ignoreUnfixed: false }), true, "off, it blocks again");
});

test("ignoreUnfixed never excuses a secret or a misconfiguration", () => {
  // Both are fixable in the author's own code, so "no fix available" cannot apply.
  const secret = { kind: "secret", severity: "CRITICAL", file: "a.ts", fix: "" };
  const misconfig = { kind: "misconfiguration", severity: "CRITICAL", file: "a.ts", fix: "" };
  const opts = { ...OPTS, changedFiles: ["a.ts"] };

  assert.equal(isBlocking(secret, opts), true);
  assert.equal(isBlocking(misconfig, opts), true);
});

test("widening blockOn to HIGH blocks the misconfiguration too", () => {
  const found = classify(REPORT);
  const blocked = found.filter((f) => isBlocking(f, { ...OPTS, blockOn: ["CRITICAL", "HIGH"] }));
  assert.deepEqual(blocked.map((f) => f.id).sort(), ["CVE-2024-0001", "CVE-2024-0003", "DS002", "aws-access-key-id"]);
});

test("a finding outside the changed files never blocks, whatever its severity", () => {
  const found = classify(REPORT);
  const blocked = found.filter((f) => isBlocking(f, { ...OPTS, changedFiles: ["README.md"] }));
  assert.deepEqual(blocked, [], "adopting the check cannot block an unrelated pull request");
});

test("partition puts everything somewhere, and never twice", () => {
  const found = classify(REPORT);
  const { blocking, reported } = partition(found, OPTS);

  assert.equal(blocking.length + reported.length, found.length);
  assert.equal(new Set([...blocking, ...reported]).size, found.length);
});

// --- presentation -----------------------------------------------------------------

test("severity ordering runs worst first", () => {
  const sorted = [{ severity: "LOW", file: "a" }, { severity: "CRITICAL", file: "b" }, { severity: "HIGH", file: "c" }]
    .sort(bySeverity)
    .map((f) => f.severity);
  assert.deepEqual(sorted, ["CRITICAL", "HIGH", "LOW"]);
  assert.deepEqual(SEVERITY_ORDER.at(-1), "CRITICAL");
});

test("the tally counts per severity, worst first, omitting zeroes", () => {
  assert.equal(tally(classify(REPORT)), "CRITICAL 3, HIGH 2");
  assert.equal(tally([]), "");
});

test("a blocked comment names every blocking finding, where it is, and the fix", () => {
  const parts = partition(classify(REPORT), OPTS);
  const body = renderComment(parts, OPTS);

  assert.match(body, /merge blocked/);
  assert.match(body, /src\/config\/db\.ts:14/, "the file and line");
  assert.match(body, /CVE-2024-0001/, "the identifier");
  assert.match(body, /4\.17\.21/, "the fixed version to move to");
  assert.match(body, /rotate the credential/, "what to do about the secret");
  // 5 findings, 2 of them blocking, so 3 are summarised rather than hidden.
  assert.match(body, /3 further finding\(s\)/, "non-blocking ones summarised, not hidden");
});

test("a passing comment says what was scanned rather than going silent", () => {
  const parts = partition(classify(REPORT), { ...OPTS, changedFiles: ["README.md"] });
  const body = renderComment(parts, { ...OPTS, changedFiles: ["README.md"] });

  assert.match(body, /passed/);
  assert.doesNotMatch(body, /merge blocked/);
  assert.match(body, /5 further finding\(s\)/, "pre-existing findings stay visible");
});

test("the comment states the threshold and scope it applied", () => {
  const body = renderComment({ blocking: [], reported: [] }, OPTS);
  assert.match(body, /blocks on CRITICAL/);
  assert.match(body, /files changed in this pull request/);
  assert.match(body, /no released fix are reported, not blocked/);
});

test("repository scope says so, so nobody misreads why a merge stopped", () => {
  const body = renderComment({ blocking: [], reported: [] }, { ...OPTS, blockScope: "repository" });
  assert.match(body, /the whole repository/);
});
