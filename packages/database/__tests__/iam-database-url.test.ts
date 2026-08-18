import { describe, expect, it } from "vitest";
import { readIamAuthConfig } from "../scripts/iam-database-url";

/**
 * ISS-5983 moved this env read out of `migrate.ts` so the build-time migrate and
 * the `apps/api` runtime ensure route share one definition of "the IAM
 * connection is configured". Both callers branch on `null`, so the boundary
 * between "configured" and "not configured" is the contract worth pinning.
 */

const COMPLETE_ENV = {
  AWS_ROLE_ARN: "arn:aws:iam::1:role/vercel",
  AWS_REGION: "us-east-1",
  PGHOST: "stage.rds.amazonaws.com",
  PGUSER: "vercel_iam",
  PGDATABASE: "closedloop",
} satisfies NodeJS.ProcessEnv;

describe("readIamAuthConfig", () => {
  it("defaults the port when none is set", () => {
    expect(readIamAuthConfig({ ...COMPLETE_ENV })).toEqual({
      roleArn: COMPLETE_ENV.AWS_ROLE_ARN,
      region: COMPLETE_ENV.AWS_REGION,
      host: COMPLETE_ENV.PGHOST,
      port: "5432",
      user: COMPLETE_ENV.PGUSER,
      database: COMPLETE_ENV.PGDATABASE,
    });
  });

  it("honors an explicit port", () => {
    expect(readIamAuthConfig({ ...COMPLETE_ENV, PGPORT: "6543" })?.port).toBe(
      "6543"
    );
  });

  for (const missing of Object.keys(COMPLETE_ENV)) {
    it(`returns null when ${missing} is missing`, () => {
      const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV };
      Reflect.deleteProperty(env, missing);

      expect(readIamAuthConfig(env)).toBeNull();
    });
  }

  it("treats an empty value as missing rather than connecting to nothing", () => {
    expect(readIamAuthConfig({ ...COMPLETE_ENV, PGHOST: "" })).toBeNull();
  });
});
