import { BrowserSessionErrorCode } from "@repo/api/src/types/browser-session";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { SettingsPanelDataState } from "../../../lib/settings-panel-data-state";
import { classifyBrowserSessionRevokeError } from "../browser-session-revoke-outcome";

describe("classifyBrowserSessionRevokeError", () => {
  it("gives the caller's own session its own sentence, not a generic failure", () => {
    const outcome = classifyBrowserSessionRevokeError(
      new ApiError("conflict", 409, {
        code: BrowserSessionErrorCode.CurrentSessionNotRevocable,
      })
    );

    expect(outcome.kind).toBe("coded");
    expect(outcome).toMatchObject({
      code: BrowserSessionErrorCode.CurrentSessionNotRevocable,
    });
  });

  it("tells an already-gone session apart from the current one", () => {
    const notFound = classifyBrowserSessionRevokeError(
      new ApiError("gone", 404, {
        code: BrowserSessionErrorCode.SessionNotFound,
      })
    );
    const current = classifyBrowserSessionRevokeError(
      new ApiError("conflict", 409, {
        code: BrowserSessionErrorCode.CurrentSessionNotRevocable,
      })
    );

    expect(notFound).toMatchObject({
      code: BrowserSessionErrorCode.SessionNotFound,
      kind: "coded",
    });
    // Two coded refusals, two different sentences. Collapsing them would tell a
    // user to sign out of a session that no longer exists.
    expect(notFound).not.toEqual(current);
  });

  it("leaves an unreachable provider as Unavailable, which is not a denial", () => {
    const outcome = classifyBrowserSessionRevokeError(
      new ApiError("provider down", 503, {
        code: BrowserSessionErrorCode.ProviderUnavailable,
      })
    );

    expect(outcome).toEqual({
      kind: "state",
      state: SettingsPanelDataState.Unavailable,
    });
  });

  it("keeps canonical-code precedence over a category override", () => {
    // A 403 stays a refusal whatever code travelled with it. Letting a coded
    // override reach a real authorization answer is how a denial gets demoted
    // into a domain sentence that says nothing about access.
    const outcome = classifyBrowserSessionRevokeError(
      new ApiError("forbidden", 403, {
        code: BrowserSessionErrorCode.SessionNotFound,
      })
    );

    expect(outcome).toEqual({
      kind: "state",
      state: SettingsPanelDataState.Forbidden,
    });
  });

  it("falls back to Failed for an unknown code and for a non-ApiError throw", () => {
    // A version-skewed route answering with a code this build has never heard
    // of must degrade to the generic failure, never to a denial.
    expect(
      classifyBrowserSessionRevokeError(
        new ApiError("weird", 500, { code: "some_future_code" })
      )
    ).toEqual({ kind: "state", state: SettingsPanelDataState.Failed });
    expect(classifyBrowserSessionRevokeError(new Error("offline"))).toEqual({
      kind: "state",
      state: SettingsPanelDataState.Failed,
    });
  });

  it("does not answer from a prototype key supplied as the code", () => {
    // The code is server-supplied. A plain-object lookup on `__proto__` would
    // answer with something that is not a message.
    expect(
      classifyBrowserSessionRevokeError(
        new ApiError("weird", 500, { code: "__proto__" })
      )
    ).toEqual({ kind: "state", state: SettingsPanelDataState.Failed });
  });
});
