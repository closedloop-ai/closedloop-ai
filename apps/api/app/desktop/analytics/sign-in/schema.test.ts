import { describe, expect, it } from "vitest";
import {
  signInAnalyticsRegistrationSchema,
  signInAnalyticsReportSchema,
} from "./schema";

const registration = {
  codeChallenge: "A".repeat(43),
  flowId: "11111111-1111-4111-8111-111111111111",
};
describe("sign-in analytics validation", () => {
  it("accepts the additive registration contract", () =>
    expect(
      signInAnalyticsRegistrationSchema.safeParse(registration).success
    ).toBe(true));
  it.each(["", "arbitrary-id", "11111111-1111-7111-8111-111111111111"])(
    "rejects invalid flow %s",
    (flowId) =>
      expect(
        signInAnalyticsRegistrationSchema.safeParse({ ...registration, flowId })
          .success
      ).toBe(false)
  );
  it.each(["", "x", "=".repeat(43)])(
    "rejects malformed challenge %s",
    (codeChallenge) =>
      expect(
        signInAnalyticsRegistrationSchema.safeParse({
          ...registration,
          codeChallenge,
        }).success
      ).toBe(false)
  );
  it("rejects client identity and creation assertions", () => {
    expect(
      signInAnalyticsReportSchema.safeParse({
        codeChallenge: registration.codeChallenge,
        userId: "user_other",
      }).success
    ).toBe(false);
    expect(
      signInAnalyticsReportSchema.safeParse({
        codeChallenge: registration.codeChallenge,
        account_created: true,
      }).success
    ).toBe(false);
  });
});
