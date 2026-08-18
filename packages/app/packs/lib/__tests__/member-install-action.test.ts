/**
 * @file member-install-action.test.ts
 * @description Behavioral coverage for the ISS-5125 member install ACTION rule
 * table. This is the decision the per-machine block's affordance is built on, so
 * it is asserted state-by-state over the WHOLE `PackInstallState` union rather
 * than on the two happy states: the failure mode this guards against is a future
 * state silently inheriting an install button (or silently losing one). Pure
 * functions, no render, no timing.
 */

import { describe, expect, it } from "vitest";
import { PackInstallState } from "../install-state";
import {
  MEMBER_INSTALL_ACTION_LABEL,
  MemberInstallAction,
  memberInstallActionAriaLabel,
  memberInstallActionFor,
  memberInstallBlockedReason,
} from "../member-install-action";

const MACHINE = "parkers-mbp";

describe("memberInstallActionFor", () => {
  it("offers Install only where the pack is absent", () => {
    expect(memberInstallActionFor(PackInstallState.NotInstalled)).toBe(
      MemberInstallAction.Install
    );
  });

  it("offers Retry after a failed install, not a fresh Install", () => {
    expect(memberInstallActionFor(PackInstallState.Failed)).toBe(
      MemberInstallAction.Retry
    );
  });

  // The states that must NOT get a button, each for its own reason. An update
  // or uninstall control here would be a button with no member-scoped route
  // behind it; offline/unsupported/in-flight are cases where dispatching could
  // not land or would duplicate a run.
  it.each([
    PackInstallState.Installed,
    PackInstallState.Updatable,
    PackInstallState.Converting,
    PackInstallState.Offline,
    PackInstallState.Unsupported,
  ])("offers no action for %s", (state) => {
    expect(memberInstallActionFor(state)).toBeNull();
  });

  it("covers every install state, so a new one cannot default into an action", () => {
    for (const state of Object.values(PackInstallState)) {
      const action = memberInstallActionFor(state);
      expect(
        action === null || Object.values(MemberInstallAction).includes(action)
      ).toBe(true);
    }
  });

  it("fails closed on an unknown wire state cast past the type", () => {
    expect(
      memberInstallActionFor("something-new" as PackInstallState)
    ).toBeNull();
  });
});

describe("memberInstallBlockedReason", () => {
  it("names the machine when it is offline, so the row is not a silent gap", () => {
    expect(
      memberInstallBlockedReason(PackInstallState.Offline, MACHINE)
    ).toContain(MACHINE);
  });

  it("explains an unsupported harness rather than showing nothing", () => {
    expect(
      memberInstallBlockedReason(PackInstallState.Unsupported, MACHINE)
    ).toBe("This pack can't run on this harness.");
  });

  it("explains an in-flight install rather than offering a second dispatch", () => {
    expect(
      memberInstallBlockedReason(PackInstallState.Converting, MACHINE)
    ).toBe("An install is already running here.");
  });

  // Settled states need no excuse: the status line already reads truthfully, and
  // a "you can't uninstall from here" line under every installed row would be
  // noise about something the member did not ask for.
  it.each([
    PackInstallState.Installed,
    PackInstallState.Updatable,
    PackInstallState.NotInstalled,
    PackInstallState.Failed,
  ])("adds no explanation for %s", (state) => {
    expect(memberInstallBlockedReason(state, MACHINE)).toBeNull();
  });
});

describe("memberInstallActionAriaLabel", () => {
  it("carries the pack, machine, and harness the one-word label omits", () => {
    expect(
      memberInstallActionAriaLabel({
        action: MemberInstallAction.Install,
        packName: "release-captain",
        computeTargetName: MACHINE,
        harnessLabel: "Codex",
      })
    ).toBe(`Install release-captain on ${MACHINE} for Codex`);
  });

  it("uses the action's own verb, so a retry does not announce as an install", () => {
    expect(
      memberInstallActionAriaLabel({
        action: MemberInstallAction.Retry,
        packName: "release-captain",
        computeTargetName: MACHINE,
        harnessLabel: "Claude",
      })
    ).toBe(
      `${MEMBER_INSTALL_ACTION_LABEL[MemberInstallAction.Retry]} release-captain on ${MACHINE} for Claude`
    );
  });
});
