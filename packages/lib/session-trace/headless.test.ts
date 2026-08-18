import { describe, expect, it } from "vitest";
import { isHeadlessEntrypoint, isHeadlessSession } from "./headless.js";

describe("FEA-2870: isHeadlessSession", () => {
  it("flags SDK-launched sessions as headless", () => {
    expect(isHeadlessSession({ entrypoint: "sdk-ts" })).toBe(true);
  });

  it("flags bypassPermissions sessions as headless", () => {
    expect(isHeadlessSession({ permissionMode: "bypassPermissions" })).toBe(
      true
    );
  });

  it("treats interactive CLI / default permissions as NOT headless", () => {
    expect(
      isHeadlessSession({ entrypoint: "cli", permissionMode: "default" })
    ).toBe(false);
    expect(isHeadlessSession({ entrypoint: "codex" })).toBe(false);
    expect(
      isHeadlessSession({ entrypoint: "cli", permissionMode: "plan" })
    ).toBe(false);
  });

  it("handles null/undefined signals without throwing", () => {
    expect(isHeadlessSession({})).toBe(false);
    expect(isHeadlessSession({ entrypoint: null, permissionMode: null })).toBe(
      false
    );
  });
});

describe("FEA-3616: SDK/exec autonomous entrypoint family is fully covered", () => {
  // The prior exact-match allow-list recognized ONLY `sdk-ts`, so `sdk-cli` and
  // the whole `exec` family leaked through as human-interactive and their
  // scripted / agent-to-agent `user` prompts inflated humanTurns. All must now
  // classify as headless (`sdk-` prefix OR `exec` token).
  it.each([
    "sdk-ts",
    "sdk-cli",
    "codex_exec",
    "codex-exec",
    "claude-codex-exec",
    "some-exec-runner",
    "SDK-TS", // case-insensitive
  ])("flags autonomous entrypoint %s as headless", (entrypoint) => {
    expect(isHeadlessEntrypoint(entrypoint)).toBe(true);
    expect(isHeadlessSession({ entrypoint })).toBe(true);
  });

  it.each([
    "cli",
    "codex-tui",
    "codex_cli_rs",
    "codex_vscode",
    "codex",
    // FEA-3616 GUARD: `codex_sdk_ts` is the Codex VS Code / Conductor IDE
    // transport — it carries `sdk` but is a HUMAN typing in the IDE (golden
    // 019effc3 / 019f0041 sign its prompts as genuine human turns). It is NOT
    // `sdk-`-prefixed, so it must stay interactive — never demoted to headless.
    "codex_sdk_ts",
  ])("keeps genuine interactive entrypoint %s NOT headless", (entrypoint) => {
    expect(isHeadlessEntrypoint(entrypoint)).toBe(false);
    expect(isHeadlessSession({ entrypoint })).toBe(false);
  });

  it("an interactive entrypoint with bypassPermissions is still headless", () => {
    // Fleet / agent-to-agent workers launch via the normal CLI but skip
    // permission prompts — the automation flag alone marks the run headless.
    expect(
      isHeadlessSession({
        entrypoint: "cli",
        permissionMode: "bypassPermissions",
      })
    ).toBe(true);
  });

  it("isHeadlessEntrypoint tolerates null/undefined", () => {
    expect(isHeadlessEntrypoint(null)).toBe(false);
    expect(isHeadlessEntrypoint(undefined)).toBe(false);
  });
});
