import { describe, expect, it } from "vitest";
import { internalOidcConfigFromEnv } from "../internal-oidc";

const REALTIME = "REALTIME_INTERNAL_OIDC";
const DOC_SYNC = "DOC_SYNC_INTERNAL_OIDC";

function envFor(prefix: string, team: string): Record<string, string> {
  return {
    [`${prefix}_ISSUER`]: `https://oidc.vercel.com/${team}`,
    [`${prefix}_AUDIENCE`]: `${team}-internal`,
    [`${prefix}_OWNER_ID`]: `team_${team}`,
    [`${prefix}_PROJECT_ID`]: `prj_${team}`,
    [`${prefix}_ENVIRONMENT`]: "production",
  };
}

function messagesOf(
  env: Readonly<Record<string, unknown>>,
  prefix: string
): string[] {
  const parsed = internalOidcConfigFromEnv(env, prefix);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("internalOidcConfigFromEnv", () => {
  it("reads each prefix's own keys, independently of the other's", () => {
    const env = { ...envFor(REALTIME, "realtime"), ...envFor(DOC_SYNC, "doc") };

    expect(internalOidcConfigFromEnv(env, REALTIME).data).toEqual({
      issuer: "https://oidc.vercel.com/realtime",
      audience: "realtime-internal",
      ownerId: "team_realtime",
      projectId: "prj_realtime",
      environment: "production",
    });
    expect(internalOidcConfigFromEnv(env, DOC_SYNC).data).toEqual({
      issuer: "https://oidc.vercel.com/doc",
      audience: "doc-internal",
      ownerId: "team_doc",
      projectId: "prj_doc",
      environment: "production",
    });
    expect(
      internalOidcConfigFromEnv(envFor(REALTIME, "realtime"), DOC_SYNC).success
    ).toBe(false);
  });

  it("reproduces realtime's exact messages for missing keys", () => {
    expect(messagesOf({}, REALTIME)).toEqual([
      "REALTIME_INTERNAL_OIDC_ISSUER is required and must not be blank",
      "REALTIME_INTERNAL_OIDC_AUDIENCE is required and must not be blank",
      "REALTIME_INTERNAL_OIDC_OWNER_ID is required and must not be blank",
      "REALTIME_INTERNAL_OIDC_PROJECT_ID is required and must not be blank",
      "REALTIME_INTERNAL_OIDC_ENVIRONMENT is required and must not be blank",
    ]);
  });

  it("reproduces realtime's exact messages for invalid values", () => {
    expect(
      messagesOf(
        {
          ...envFor(REALTIME, "realtime"),
          REALTIME_INTERNAL_OIDC_ISSUER: "https://oidc.vercel.com/realtime/",
          REALTIME_INTERNAL_OIDC_AUDIENCE: "https://vercel.com/realtime",
          REALTIME_INTERNAL_OIDC_ENVIRONMENT: "development",
          ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/task",
        },
        REALTIME
      )
    ).toEqual([
      "REALTIME_INTERNAL_OIDC_ISSUER must be an https URL with no trailing slash, as the token's iss",
      "REALTIME_INTERNAL_OIDC_AUDIENCE must not be Vercel's default audience",
      "REALTIME_INTERNAL_OIDC_ENVIRONMENT must not be development on ECS",
    ]);
  });

  it("names the other prefix's keys in its messages", () => {
    expect(messagesOf({}, DOC_SYNC)[0]).toBe(
      "DOC_SYNC_INTERNAL_OIDC_ISSUER is required and must not be blank"
    );
  });

  it("accepts development off ECS", () => {
    expect(
      internalOidcConfigFromEnv(
        {
          ...envFor(DOC_SYNC, "doc"),
          DOC_SYNC_INTERNAL_OIDC_ENVIRONMENT: "development",
        },
        DOC_SYNC
      ).success
    ).toBe(true);
  });
});
