/**
 * @file member-install-dispatch-copy.test.ts
 * @description Behavioral coverage for the ISS-5125 dispatch-outcome copy. The
 * contract under test is an HONESTY contract, not a string-matching one: a
 * dispatch result must never be reported as a completed install, an ambiguous
 * outcome must never be offered as a retry (the install may already be running,
 * and a second dispatch would duplicate it), and a version-skewed API returning
 * a state or reason this build does not know must degrade to an honest failure
 * rather than to silence or a success claim.
 */

import {
  MemberPackInstallDispatchReason,
  MemberPackInstallDispatchState,
} from "@repo/api/src/types/member-pack-install";
import { describe, expect, it } from "vitest";
import {
  MemberInstallDispatchTone,
  memberInstallDispatchCopy,
} from "../member-install-dispatch-copy";

const MACHINE = "ci-runner-3";

describe("memberInstallDispatchCopy", () => {
  it("reports a clean dispatch as STARTED, never as installed", () => {
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.Dispatched,
      MACHINE
    );
    expect(copy.message).toBe(`Install started on ${MACHINE}.`);
    expect(copy.tone).toBe(MemberInstallDispatchTone.Success);
    expect(copy.message.toLowerCase()).not.toContain("installed on");
  });

  it("does NOT offer a retry for the ambiguous pending outcome", () => {
    // The API keeps this non-terminal precisely because the relay may already
    // have emitted the command. Re-offering the button is how a member is
    // invited to run the same install twice.
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.Pending,
      MACHINE
    );
    expect(copy.retryable).toBe(false);
    expect(copy.tone).toBe(MemberInstallDispatchTone.Pending);
    expect(copy.message).toContain("couldn't confirm");
  });

  it("says nothing was installed when the target was offline, and allows a retry", () => {
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.TargetOffline,
      MACHINE
    );
    expect(copy.message).toContain(`${MACHINE} is offline`);
    expect(copy.message).toContain("nothing was installed");
    expect(copy.tone).toBe(MemberInstallDispatchTone.Danger);
    expect(copy.retryable).toBe(true);
  });

  it("names the too-old-desktop cause instead of a generic failure", () => {
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.Failed,
      MACHINE,
      MemberPackInstallDispatchReason.OperationNotSupported
    );
    expect(copy.message).toContain("too old");
    expect(copy.retryable).toBe(true);
  });

  it("names the command-signing cause and points at the desktop app", () => {
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.Failed,
      MACHINE,
      MemberPackInstallDispatchReason.SigningRequired
    );
    expect(copy.message).toContain("signed commands");
    expect(copy.message).toContain("desktop app");
  });

  it("falls back to an honest generic failure for a reason this build doesn't know", () => {
    // Version skew: a newer API adds a reason code. The client must still say
    // something true, never render an empty or `undefined` sentence.
    const copy = memberInstallDispatchCopy(
      MemberPackInstallDispatchState.Failed,
      MACHINE,
      "a_reason_from_a_newer_api"
    );
    expect(copy.message).toContain(MACHINE);
    expect(copy.message).toContain("Nothing was installed");
    expect(copy.tone).toBe(MemberInstallDispatchTone.Danger);
  });

  it("falls back to UNCONFIRMED — never a success, never a retry — for an unknown dispatch state", () => {
    const copy = memberInstallDispatchCopy(
      "some-future-state" as MemberPackInstallDispatchState,
      MACHINE
    );
    // An unrecognised state came from a NEWER server, which is likelier to have
    // ACCEPTED the dispatch than to have invented a new refusal. Offering Retry
    // would invite a duplicate install of the same pack onto the same node.
    expect(copy.tone).toBe(MemberInstallDispatchTone.Pending);
    expect(copy.retryable).toBe(false);
    expect(copy.message).toContain(MACHINE);
    expect(copy.message).not.toContain("Nothing was installed");
  });

  it("gives every wire state a non-empty sentence that names the machine", () => {
    // The dispatch layer only knows whether the node TOOK the command, so each
    // outcome owes the member a concrete sentence about THAT machine. A state
    // added to the wire contract without copy would surface here as a blank.
    for (const state of Object.values(MemberPackInstallDispatchState)) {
      const { message } = memberInstallDispatchCopy(state, MACHINE);
      expect(message.length).toBeGreaterThan(0);
      expect(message).toContain(MACHINE);
    }
  });
});
