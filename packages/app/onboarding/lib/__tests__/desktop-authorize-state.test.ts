import { describe, expect, it } from "vitest";
import { DesktopAuthorizeParamError } from "../desktop-authorize-params";
import {
  getAuthorizeMintErrorCopy,
  getAuthorizeParamErrorCopy,
} from "../desktop-authorize-state";

describe("getAuthorizeParamErrorCopy", () => {
  it("maps an invalid redirect URI to non-retryable copy", () => {
    const copy = getAuthorizeParamErrorCopy(
      DesktopAuthorizeParamError.InvalidRedirectUri
    );

    expect(copy.title).toBe("Invalid device link");
    expect(copy.retryable).toBe(false);
  });

  it("maps missing params to non-retryable copy", () => {
    const copy = getAuthorizeParamErrorCopy(
      DesktopAuthorizeParamError.MissingParams
    );

    expect(copy.title).toBe("Incomplete device link");
    expect(copy.retryable).toBe(false);
  });
});

describe("getAuthorizeMintErrorCopy", () => {
  it.each([
    [401, "Session expired"],
    [403, "Request blocked"],
    [400, "Invalid device request"],
  ] as const)("maps status %s to non-retryable %s", (status, title) => {
    const copy = getAuthorizeMintErrorCopy(status);

    expect(copy.title).toBe(title);
    expect(copy.retryable).toBe(false);
  });

  it.each([
    undefined,
    500,
    503,
  ])("maps a missing/5xx status (%s) to generic retryable copy", (status) => {
    const copy = getAuthorizeMintErrorCopy(status);

    expect(copy.title).toBe("Something went wrong");
    expect(copy.retryable).toBe(true);
  });
});
