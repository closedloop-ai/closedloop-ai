import { describe, expect, it } from "vitest";
import { deriveContentInstallStates } from "../content-install-state";
import { PackInstallState } from "../install-state";
import { type PackContentEntry, PackContentKind } from "../pack-view";

/**
 * FEA-4071 — per-component desktop install-state derivation.
 *
 * The Contents tab asks "which of this pack's components are installed on THIS
 * machine?". `deriveContentInstallStates` answers it from the machine's real
 * installed-component set (the desktop `getPackDetail` skills[]), honestly:
 * installed → Installed, absent → NotInstalled, and — critically — when the
 * machine's state is UNKNOWN (web, version skew) it fabricates nothing. It only
 * speaks to kinds the installed set actually enumerates (`resolvableKinds`);
 * every other kind stays UNKNOWN rather than being derived from an inventory
 * that never listed it.
 */

const CONTENTS: readonly PackContentEntry[] = [
  { name: "Code Review", kind: PackContentKind.Skill },
  { name: "Plan Builder", kind: PackContentKind.Command },
  { name: "Deploy Hook", kind: PackContentKind.Hook },
];

// Kinds the desktop skill inventory covers on THIS pack, per test intent. The
// fixture above spans skill/command/hook; a test that wants all three resolved
// declares all three, mirroring an inventory that enumerated every kind.
const ALL_FIXTURE_KINDS: readonly PackContentKind[] = [
  PackContentKind.Skill,
  PackContentKind.Command,
  PackContentKind.Hook,
];

describe("deriveContentInstallStates (FEA-4071)", () => {
  it("marks a component Installed when the machine reports it installed", () => {
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: ["Code Review"],
      packInstalled: true,
      resolvableKinds: ALL_FIXTURE_KINDS,
    });

    expect(result[0].installState).toBe(PackInstallState.Installed);
  });

  it("marks a component NotInstalled when absent from an installed pack's set", () => {
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: ["Code Review"],
      packInstalled: true,
      resolvableKinds: ALL_FIXTURE_KINDS,
    });

    // Plan Builder / Deploy Hook are bundled but not on this machine — the
    // member sees the gap, not a silent "the pack is installed so all is well".
    expect(result[1].installState).toBe(PackInstallState.NotInstalled);
    expect(result[2].installState).toBe(PackInstallState.NotInstalled);
  });

  it("marks every component NotInstalled when the pack is not installed at all", () => {
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: [],
      packInstalled: false,
      resolvableKinds: ALL_FIXTURE_KINDS,
    });

    expect(result.map((entry) => entry.installState)).toEqual([
      PackInstallState.NotInstalled,
      PackInstallState.NotInstalled,
      PackInstallState.NotInstalled,
    ]);
  });

  it("forces NotInstalled when the pack is not installed, even on a name match", () => {
    // Honesty backstop: a stale/cross-pack name in the installed set must never
    // paint a component Installed under a pack that isn't on the machine.
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: ["Code Review"],
      packInstalled: false,
      resolvableKinds: ALL_FIXTURE_KINDS,
    });

    expect(result[0].installState).toBe(PackInstallState.NotInstalled);
  });

  it("matches names case- and whitespace-insensitively", () => {
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: ["  code review  ", "PLAN BUILDER"],
      packInstalled: true,
      resolvableKinds: ALL_FIXTURE_KINDS,
    });

    expect(result[0].installState).toBe(PackInstallState.Installed);
    expect(result[1].installState).toBe(PackInstallState.Installed);
    expect(result[2].installState).toBe(PackInstallState.NotInstalled);
  });

  it("leaves contents UNTOUCHED (no installState) when the machine is unknown", () => {
    const result = deriveContentInstallStates(CONTENTS, { known: false });

    // Web / version-skewed desktop: it can't see the machine, so it must not
    // assert a per-component fact — no `installState` on any row.
    for (const entry of result) {
      expect(entry.installState).toBeUndefined();
    }
  });

  it("leaves a non-resolvable kind UNKNOWN instead of mislabelling it NotInstalled", () => {
    // The desktop detail read enumerates only installed SKILLS, so it can only
    // speak to skill-kind entries. A command/hook the read never listed must
    // stay UNKNOWN (no indicator), not read a fabricated "not installed".
    const result = deriveContentInstallStates(CONTENTS, {
      known: true,
      installedComponentNames: ["Code Review"],
      packInstalled: true,
      resolvableKinds: [PackContentKind.Skill],
    });

    expect(result[0].installState).toBe(PackInstallState.Installed);
    // Command + Hook are outside the resolvable set → left untouched.
    expect(result[1].installState).toBeUndefined();
    expect(result[2].installState).toBeUndefined();
  });

  it("does not paint a non-resolvable kind Installed on a cross-kind name collision", () => {
    // A command sharing a skill's name must NOT read Installed off the skill
    // inventory — its kind isn't resolvable, so it stays UNKNOWN.
    const collision: readonly PackContentEntry[] = [
      { name: "Duplicate", kind: PackContentKind.Skill },
      { name: "Duplicate", kind: PackContentKind.Command },
    ];
    const result = deriveContentInstallStates(collision, {
      known: true,
      installedComponentNames: ["Duplicate"],
      packInstalled: true,
      resolvableKinds: [PackContentKind.Skill],
    });

    expect(result[0].installState).toBe(PackInstallState.Installed);
    expect(result[1].installState).toBeUndefined();
  });

  it("does not mutate the input contents array", () => {
    const input: PackContentEntry[] = [
      { name: "Code Review", kind: PackContentKind.Skill },
    ];
    deriveContentInstallStates(input, {
      known: true,
      installedComponentNames: ["Code Review"],
      packInstalled: true,
      resolvableKinds: [PackContentKind.Skill],
    });

    expect(input[0].installState).toBeUndefined();
  });
});
