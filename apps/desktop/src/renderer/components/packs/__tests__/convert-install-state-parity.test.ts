/**
 * @file convert-install-state-parity.test.ts
 * @description Renderer-side parity guard (FEA-4079) pinning the convert
 * engine's execution-boundary state vocabulary against the UI display
 * vocabulary it overlaps.
 *
 * The convert engine runs in the desktop MAIN process, whose `nodenext`
 * resolution cannot import `@repo/app`'s `PackInstallState` (its JSX /
 * design-system deps are unreachable there — see the same constraint on
 * `@repo/app/branches/lib/branch-derivations`). So `ConvertInstallState`'s
 * overlapping members carry the SAME literal wire values by convention rather
 * than by import. This test runs in the RENDERER (jsdom) context where BOTH
 * modules ARE importable, and asserts the literals are equal — so a rename on
 * either side fails here instead of silently drifting the two vocabularies
 * apart at runtime.
 */

import { ConvertInstallState } from "@repo/api/src/types/convert-install";
import { PackInstallState } from "@repo/app/packs/lib/install-state";
import { describe, expect, it } from "vitest";

describe("ConvertInstallState ↔ PackInstallState literal parity", () => {
  it("shares the converting / installed / unsupported wire literals", () => {
    expect(ConvertInstallState.Converting).toBe(PackInstallState.Converting);
    expect(ConvertInstallState.Installed).toBe(PackInstallState.Installed);
    expect(ConvertInstallState.Unsupported).toBe(PackInstallState.Unsupported);
  });
});
