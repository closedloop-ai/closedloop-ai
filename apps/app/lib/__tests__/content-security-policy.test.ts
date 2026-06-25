import { describe, expect, test } from "vitest";
import { shouldEnableContentSecurityPolicy } from "../content-security-policy";

describe("shouldEnableContentSecurityPolicy", () => {
  test("enabled on a production deployment (real prod or stage)", () => {
    expect(shouldEnableContentSecurityPolicy("true", "production")).toBe(true);
  });

  test("enabled when VERCEL_ENV is unset (e.g. local with CSP on)", () => {
    expect(shouldEnableContentSecurityPolicy("true", undefined)).toBe(true);
  });

  test("disabled on a preview deployment even when CSP_ENABLED=true (FEA-1466)", () => {
    expect(shouldEnableContentSecurityPolicy("true", "preview")).toBe(false);
  });

  test("disabled when CSP_ENABLED is not 'true'", () => {
    expect(shouldEnableContentSecurityPolicy("false", "production")).toBe(
      false
    );
    expect(shouldEnableContentSecurityPolicy(undefined, "production")).toBe(
      false
    );
  });
});
