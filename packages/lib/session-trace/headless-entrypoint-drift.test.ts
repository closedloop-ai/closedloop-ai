import { describe, expect, it } from "vitest";
import {
  createUnrecognizedEntrypointReporter,
  MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS,
} from "./headless-entrypoint-drift.js";

describe("ISS-7260: unrecognized entrypoints are reported, not silently defaulted", () => {
  it("reports a value that matches no rule and is in no census", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note("sdkcli");
    expect(line).toContain('"sdkcli"');
    expect(line).toContain("INTERACTIVE by default");
  });

  it("stays silent for a decided value and for a headless one", () => {
    // The positive sibling above is what makes this negative meaningful: the
    // reporter can fire, so silence here is a decision rather than a dead call.
    const reporter = createUnrecognizedEntrypointReporter();
    expect(reporter.note("cli")).toBeUndefined();
    expect(reporter.note("codex_sdk_ts")).toBeUndefined();
    expect(reporter.note("sdk-cli")).toBeUndefined();
    expect(reporter.note("codex_exec")).toBeUndefined();
  });

  it("stays silent for an absent entrypoint", () => {
    // An unstated entrypoint is a parser/harness gap, not harness drift, and
    // every legacy row has one — reporting it would drown the real signal.
    const reporter = createUnrecognizedEntrypointReporter();
    expect(reporter.note(null)).toBeUndefined();
    expect(reporter.note(undefined)).toBeUndefined();
    expect(reporter.note("")).toBeUndefined();
  });

  it("reports each distinct value exactly once, case-insensitively", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    expect(reporter.note("Amp-CLI")).toBeDefined();
    expect(reporter.note("amp-cli")).toBeUndefined();
    expect(reporter.note("AMP-CLI")).toBeUndefined();
    // A different unrecognized value is still reported after the first.
    expect(reporter.note("goose")).toBeDefined();
  });

  it("bounds the retained set and says so once when it overflows", () => {
    const reporter = createUnrecognizedEntrypointReporter({ maxReported: 2 });
    expect(reporter.note("one")).toBeDefined();
    expect(reporter.note("two")).toBeDefined();
    const overflow = reporter.note("three");
    expect(overflow).toContain("past the 2-value cap");
    // Past the cap the reporter is silent — including for the value that
    // triggered the overflow line, which must not be reported twice.
    expect(reporter.note("three")).toBeUndefined();
    expect(reporter.note("four")).toBeUndefined();
    // A value already reported before the cap still does not repeat.
    expect(reporter.note("one")).toBeUndefined();
  });

  it("escapes a harness-controlled value so it cannot forge a second log line", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note("evil\nimported 0 sessions");
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).toContain("\\x0a");
  });

  it("bounds an arbitrarily long value", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note("z".repeat(5000));
    expect(line).toBeDefined();
    expect((line ?? "").length).toBeLessThan(400);
  });

  // whitlockk review: `entrypoint` is harness-controlled and this line lands in the
  // PERSISTENT desktop main.log, so a malformed transcript stamping a credential
  // into the field would durably write it to disk. Escaping and capping do not
  // remove a secret, so these pin the canonical redactor being applied — and the
  // no-match sibling pins that a clean value emits NO marker.
  const GITHUB_TOKEN_BODY = "1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p";

  it("redacts a GitHub token shaped entrypoint instead of logging it", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note(`ghp_${GITHUB_TOKEN_BODY}`);
    expect(line).toBeDefined();
    expect(line).toContain("[REDACTED:ghp]");
    expect(line).not.toContain(GITHUB_TOKEN_BODY);
  });

  it("redacts a Stripe live-key shaped entrypoint instead of logging it", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note(`sk_live_${GITHUB_TOKEN_BODY}`);
    expect(line).toBeDefined();
    expect(line).toContain("[REDACTED:sk_live]");
    expect(line).not.toContain(GITHUB_TOKEN_BODY);
  });

  it("redacts BEFORE lowercasing, so an uppercase-cased family still matches", () => {
    // `AKIA…` is matched at its documented uppercase casing, as are `AIza…`,
    // `SG.…` and the `eyJ` JWT prefix. Lowercasing the value before redacting it
    // — the obvious way to write this, since the dedupe key is lowercased —
    // silently defeats every one of them, so the ordering gets its own case.
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note("AKIAIOSFODNN7EXAMPLE");
    expect(line).toBeDefined();
    expect(line).toContain("[REDACTED:aws_akia]");
    expect(line).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(line).not.toContain("akiaiosfodnn7example");
  });

  it("emits NO redaction marker for a value carrying no secret", () => {
    // The repo contract on redaction helpers: a marker means sensitive content
    // actually matched. Without this, a redactor that replaced everything would
    // pass all three cases above while destroying the drift report's only
    // payload — the value that drifted.
    const reporter = createUnrecognizedEntrypointReporter();
    const line = reporter.note("iss7260-clean-harness");
    expect(line).toBeDefined();
    expect(line).toContain('"iss7260-clean-harness"');
    expect(line).not.toContain("[REDACTED");
  });

  it("defaults the cap rather than leaving it unbounded", () => {
    const reporter = createUnrecognizedEntrypointReporter();
    for (let i = 0; i < MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS; i++) {
      expect(reporter.note(`harness-${i}`)).toBeDefined();
    }
    expect(reporter.note("one-too-many")).toContain(
      `past the ${MAX_REPORTED_UNRECOGNIZED_ENTRYPOINTS}-value cap`
    );
  });
});
