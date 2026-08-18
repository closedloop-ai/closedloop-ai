import { describe, expect, it } from "vitest";
import {
  buildOrgPolicyUpdateInput,
  ORG_POLICY_FIELD_STATE_BADGES,
  ORG_POLICY_SAVE_OUTCOME_ALERTS,
  OrgPolicyField,
  OrgPolicyFieldState,
  OrgPolicySaveOutcome,
  readOrgPolicyField,
  resolveOrgPolicyFieldState,
  resolveOrgPolicySaveOutcome,
} from "../org-policy-toggle-state";

const ORGANIZATION_ID = "org-1";

const IDLE_SAVE = {
  isPending: false,
  isError: false,
  isRereading: false,
  requested: undefined,
  echoed: undefined,
  current: undefined,
};

describe("resolveOrgPolicyFieldState", () => {
  it("maps an explicit true to Enabled", () => {
    expect(resolveOrgPolicyFieldState(true)).toBe(OrgPolicyFieldState.Enabled);
  });

  it("maps an explicit false to Disabled", () => {
    expect(resolveOrgPolicyFieldState(false)).toBe(
      OrgPolicyFieldState.Disabled
    );
  });

  it("maps an absent field to Unavailable rather than Disabled", () => {
    // The old/stripped-field shape: a previous-generation API omits the field
    // entirely. Collapsing that to `false` would misreport a privacy gate.
    expect(resolveOrgPolicyFieldState(undefined)).toBe(
      OrgPolicyFieldState.Unavailable
    );
  });
});

describe("readOrgPolicyField", () => {
  it("reads the new optional-field shape for each policy field", () => {
    const organization = {
      searchIncludeTranscripts: true,
      sessionSyncPolicyEnabled: false,
    };
    expect(
      readOrgPolicyField(organization, OrgPolicyField.SearchIncludeTranscripts)
    ).toBe(true);
    expect(
      readOrgPolicyField(organization, OrgPolicyField.SessionSyncPolicyEnabled)
    ).toBe(false);
  });

  it("preserves omission for the old stripped-field shape", () => {
    expect(
      readOrgPolicyField({}, OrgPolicyField.SessionSyncPolicyEnabled)
    ).toBeUndefined();
  });

  it("returns undefined when there is no source object at all", () => {
    expect(
      readOrgPolicyField(undefined, OrgPolicyField.SearchIncludeTranscripts)
    ).toBeUndefined();
  });
});

describe("resolveOrgPolicySaveOutcome", () => {
  it("is Idle before any save has been issued", () => {
    expect(resolveOrgPolicySaveOutcome(IDLE_SAVE)).toBe(
      OrgPolicySaveOutcome.Idle
    );
  });

  it("is Saving while the mutation is in flight", () => {
    expect(resolveOrgPolicySaveOutcome({ ...IDLE_SAVE, isPending: true })).toBe(
      OrgPolicySaveOutcome.Saving
    );
  });

  it("is RequestFailed when the mutation errored", () => {
    expect(resolveOrgPolicySaveOutcome({ ...IDLE_SAVE, isError: true })).toBe(
      OrgPolicySaveOutcome.RequestFailed
    );
  });

  it("is Applied when the response echoes the requested value", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        requested: true,
        echoed: true,
      })
    ).toBe(OrgPolicySaveOutcome.Applied);
  });

  it("is NotConfirmed when a previous API strips the field from the echo", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        requested: true,
        echoed: undefined,
      })
    ).toBe(OrgPolicySaveOutcome.NotConfirmed);
  });

  it("is NotConfirmed when the echoed value disagrees with the request", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        requested: true,
        echoed: false,
      })
    ).toBe(OrgPolicySaveOutcome.NotConfirmed);
  });

  it("treats a turn-OFF request stripped from the echo as NotConfirmed too", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        requested: false,
        echoed: undefined,
      })
    ).toBe(OrgPolicySaveOutcome.NotConfirmed);
  });

  it("accepts a follow-up read that agrees with the request as confirmation", () => {
    // A stale replica can answer the write without the field even though the
    // write landed; the refetched org is the authority that clears it.
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        requested: true,
        echoed: undefined,
        current: true,
      })
    ).toBe(OrgPolicySaveOutcome.Applied);
  });

  it("stays Saving while the follow-up read is still in flight", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        isRereading: true,
        requested: true,
        echoed: undefined,
        current: false,
      })
    ).toBe(OrgPolicySaveOutcome.Saving);
  });

  it("is NotConfirmed once the follow-up read lands and still disagrees", () => {
    expect(
      resolveOrgPolicySaveOutcome({
        ...IDLE_SAVE,
        isRereading: false,
        requested: true,
        echoed: undefined,
        current: false,
      })
    ).toBe(OrgPolicySaveOutcome.NotConfirmed);
  });
});

describe("buildOrgPolicyUpdateInput", () => {
  it("writes only the transcript-search field", () => {
    expect(
      buildOrgPolicyUpdateInput(
        ORGANIZATION_ID,
        OrgPolicyField.SearchIncludeTranscripts,
        true
      )
    ).toEqual({ id: ORGANIZATION_ID, searchIncludeTranscripts: true });
  });

  it("writes only the session-sync policy field", () => {
    expect(
      buildOrgPolicyUpdateInput(
        ORGANIZATION_ID,
        OrgPolicyField.SessionSyncPolicyEnabled,
        false
      )
    ).toEqual({ id: ORGANIZATION_ID, sessionSyncPolicyEnabled: false });
  });
});

describe("canonical presentation maps", () => {
  it("styles a badge only for the Unavailable state", () => {
    // Outline, not warning: amber is reserved for the NotConfirmed save alert
    // (an action that may not have taken), so the status chip stays a neutral
    // label rather than spending the tab's loudest accent on a non-action.
    expect(
      ORG_POLICY_FIELD_STATE_BADGES[OrgPolicyFieldState.Unavailable]
    ).toEqual({ label: "Status unknown", variant: "outline" });
    expect(
      ORG_POLICY_FIELD_STATE_BADGES[OrgPolicyFieldState.Enabled]
    ).toBeNull();
    expect(
      ORG_POLICY_FIELD_STATE_BADGES[OrgPolicyFieldState.Disabled]
    ).toBeNull();
  });

  it("carries a message for both failure outcomes and none for the rest", () => {
    // A request that blew up is an error; a 200 we cannot vouch for is a
    // warning. Same card, different truths, so different weights.
    expect(
      ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.RequestFailed]
    ).toMatchObject({ variant: "error" });
    expect(
      ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.NotConfirmed]
    ).toMatchObject({ variant: "warning" });
    expect(
      ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.Idle]
    ).toBeNull();
    expect(
      ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.Saving]
    ).toBeNull();
    expect(
      ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.Applied]
    ).toBeNull();
  });
});
