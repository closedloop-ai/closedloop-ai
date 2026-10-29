import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAppVisualHostEnv } from "@/__tests__/helpers/app-visual-host-env";
import {
  isRootLayoutFailureValidationRequest,
  ROOT_LAYOUT_FAILURE_VALIDATION_HEADER,
  ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE,
} from "../root-layout-failure-validation";

const LOCAL_TRUSTED_REFUSED = /local_trusted refused/;

const requesting = new Headers({
  [ROOT_LAYOUT_FAILURE_VALIDATION_HEADER]:
    ROOT_LAYOUT_FAILURE_VALIDATION_HEADER_VALUE,
});

describe("isRootLayoutFailureValidationRequest (ISS-10078)", () => {
  beforeEach(() => {
    stubAppVisualHostEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens on the e2e host when the request asks", () => {
    expect(isRootLayoutFailureValidationRequest("true", requesting)).toBe(true);
  });

  it("ignores the header wherever the gate is not set", () => {
    expect(isRootLayoutFailureValidationRequest(undefined, requesting)).toBe(
      false
    );
    expect(isRootLayoutFailureValidationRequest("false", requesting)).toBe(
      false
    );
  });

  it("ignores the header under Clerk auth, the mode every deployment runs", () => {
    stubAppVisualHostEnv({ AUTH_MODE: undefined });

    expect(isRootLayoutFailureValidationRequest("true", requesting)).toBe(
      false
    );
  });

  it("fails closed through the auth guard in a production process or on a Vercel deploy", () => {
    stubAppVisualHostEnv({ NODE_ENV: "production" });
    expect(() =>
      isRootLayoutFailureValidationRequest("true", requesting)
    ).toThrow(LOCAL_TRUSTED_REFUSED);

    stubAppVisualHostEnv({ VERCEL_ENV: "preview" });
    expect(() =>
      isRootLayoutFailureValidationRequest("true", requesting)
    ).toThrow(LOCAL_TRUSTED_REFUSED);
  });

  it("stays closed on the e2e host for a request that does not ask", () => {
    expect(isRootLayoutFailureValidationRequest("true", new Headers())).toBe(
      false
    );
    expect(
      isRootLayoutFailureValidationRequest(
        "true",
        new Headers({ [ROOT_LAYOUT_FAILURE_VALIDATION_HEADER]: "true" })
      )
    ).toBe(false);
  });
});
