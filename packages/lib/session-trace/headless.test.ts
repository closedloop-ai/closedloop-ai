import { describe, expect, it } from "vitest";
import { HarnessValues } from "../harness/types.js";
import {
  classifyEntrypoint,
  EntrypointClass,
  isHeadlessEntrypoint,
  isHeadlessSession,
  KNOWN_INTERACTIVE_ENTRYPOINTS,
} from "./headless.js";

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
    // f04610b7 / 8bbdbfab sign its prompts as genuine human turns). It is NOT
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

/**
 * ISS-7260. The classification each case must receive is written HERE as a
 * literal, derived from the golden-dossier reasoning in `headless.ts`'s header
 * and from the parser defaults — deliberately NOT read out of
 * `HEADLESS_ENTRYPOINT_PREFIXES` / `HEADLESS_ENTRYPOINT_TOKENS` /
 * `KNOWN_INTERACTIVE_ENTRYPOINTS`. A fixture that imported those constants would
 * stay green while a member was deleted, which is the one mutation this suite
 * exists to catch.
 */
const ENTRYPOINT_CLASSIFICATIONS: readonly [
  string | null | undefined,
  EntrypointClass,
][] = [
  ["sdk-ts", EntrypointClass.Headless],
  ["sdk-cli", EntrypointClass.Headless],
  ["codex_exec", EntrypointClass.Headless],
  ["claude-codex-exec", EntrypointClass.Headless],
  ["SDK-TS", EntrypointClass.Headless],
  ["cli", EntrypointClass.KnownInteractive],
  ["claude", EntrypointClass.KnownInteractive],
  ["claude-desktop", EntrypointClass.KnownInteractive],
  ["codex", EntrypointClass.KnownInteractive],
  ["codex-tui", EntrypointClass.KnownInteractive],
  ["codex_cli_rs", EntrypointClass.KnownInteractive],
  ["codex_vscode", EntrypointClass.KnownInteractive],
  ["codex_sdk_ts", EntrypointClass.KnownInteractive],
  ["copilot", EntrypointClass.KnownInteractive],
  ["cursor", EntrypointClass.KnownInteractive],
  ["opencode", EntrypointClass.KnownInteractive],
  // codex review: distinct from `codex_vscode`. Claude's parser passes the
  // stated entrypoint through verbatim, so a Claude session running under VS
  // Code arrives as a BARE `vscode` — see `parse-claude-session-shape.test.ts`
  // "keeps an explicit entrypoint". Uncensused, that known interactive value
  // reported as upstream drift on every install with a VS Code session.
  ["vscode", EntrypointClass.KnownInteractive],
  // Observed 2026-08-19 with capitals; the classifier lowercases before it
  // compares, so the census entry is the lowercased spelling.
  ["Codex Desktop", EntrypointClass.KnownInteractive],
  // The ticket's own example of how sharp the edge is: drop the hyphen upstream
  // and 1,285 autonomous sessions stop matching `sdk-`. The value must NOT be
  // headless (that IS the rule) and must NOT read as a decided interactive one.
  ["sdkcli", EntrypointClass.UnrecognizedInteractive],
  ["amp-cli", EntrypointClass.UnrecognizedInteractive],
  [null, EntrypointClass.Absent],
  [undefined, EntrypointClass.Absent],
  ["", EntrypointClass.Absent],
];

describe("ISS-7260: entrypoint classification separates decided from defaulted", () => {
  it.each(ENTRYPOINT_CLASSIFICATIONS)(
    "classifies %s as %s",
    (entrypoint, expected) => {
      expect(classifyEntrypoint(entrypoint)).toBe(expected);
    }
  );

  it.each(ENTRYPOINT_CLASSIFICATIONS)(
    "keeps isHeadlessEntrypoint(%s) exactly the Headless member",
    (entrypoint, expected) => {
      // The boolean is now derived from the classifier, so this is the guard
      // that splitting the false half changed no session's classification.
      expect(isHeadlessEntrypoint(entrypoint)).toBe(
        expected === EntrypointClass.Headless
      );
    }
  );

  it("an unrecognized entrypoint still defaults to interactive, and a headless one does not", () => {
    // Negative and positive on the SAME derivation: an assertion that unknown
    // values are not headless proves nothing unless the rule can still fire.
    expect(isHeadlessSession({ entrypoint: "sdkcli" })).toBe(false);
    expect(isHeadlessSession({ entrypoint: "sdk-cli" })).toBe(true);
  });

  it("the interactive census can never contain a value the headless rules match", () => {
    // Adding `sdk-foo` to the census would not make it interactive — the
    // headless rules win — so the entry would be a lie about what the classifier
    // does. This is the invariant, not a restatement of the members.
    for (const entrypoint of KNOWN_INTERACTIVE_ENTRYPOINTS) {
      expect(classifyEntrypoint(entrypoint)).toBe(
        EntrypointClass.KnownInteractive
      );
    }
  });

  it("every harness's own stamped default is a censused value", () => {
    // Cross-SSOT, not a restatement: `Harness` owns the value each parser writes
    // when the harness states none, and every one of them is a person's session.
    // Omitting one makes the drift report's FIRST line on a normal install a
    // false positive about upstream drift — which is how an operator learns to
    // ignore the real one. A sixth harness fails here rather than shipping that.
    for (const harness of HarnessValues) {
      expect(classifyEntrypoint(harness)).toBe(
        EntrypointClass.KnownInteractive
      );
    }
  });

  it("permissionMode alone still marks a KNOWN interactive entrypoint headless", () => {
    // The live corpus's largest divergence between the two consumers: 218 `cli`
    // sessions carry `bypassPermissions`. The entrypoint is decided-interactive
    // and the SESSION is headless — both facts, and neither may swallow the
    // other.
    expect(classifyEntrypoint("cli")).toBe(EntrypointClass.KnownInteractive);
    expect(
      isHeadlessSession({
        entrypoint: "cli",
        permissionMode: "bypassPermissions",
      })
    ).toBe(true);
  });
});
