import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getAppEnvironment } from "../environment";

const ENV_KEY = "NEXT_PUBLIC_APP_ENVIRONMENT";
const URL_KEY = "NEXT_PUBLIC_APP_URL";
const VERCEL_ENV_KEY = "NEXT_PUBLIC_VERCEL_ENV";

describe("getAppEnvironment", () => {
  let originalEnv: string | undefined;
  let originalUrl: string | undefined;
  let originalVercelEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    originalUrl = process.env[URL_KEY];
    originalVercelEnv = process.env[VERCEL_ENV_KEY];
    process.env[ENV_KEY] = undefined;
    process.env[URL_KEY] = undefined;
    process.env[VERCEL_ENV_KEY] = undefined;
  });

  afterEach(() => {
    process.env[ENV_KEY] = originalEnv;
    process.env[URL_KEY] = originalUrl;
    process.env[VERCEL_ENV_KEY] = originalVercelEnv;
  });

  test("explicit NEXT_PUBLIC_APP_ENVIRONMENT=production resolves to prod", () => {
    process.env[ENV_KEY] = "production";
    process.env[URL_KEY] = "https://app-preview.example.com";
    expect(getAppEnvironment()).toBe("prod");
  });

  test("explicit stage resolves to stage", () => {
    process.env[ENV_KEY] = "stage";
    expect(getAppEnvironment()).toBe("stage");
  });

  test("explicit development resolves to local", () => {
    process.env[ENV_KEY] = "development";
    expect(getAppEnvironment()).toBe("local");
  });

  test("localhost URL resolves to local without the explicit env var", () => {
    process.env[URL_KEY] = "http://localhost:3000";
    expect(getAppEnvironment()).toBe("local");
  });

  test("production host resolves to prod without the explicit env var", () => {
    process.env[URL_KEY] = "https://app.closedloop.ai";
    expect(getAppEnvironment()).toBe("prod");
  });

  test("preview/e2e URL without env markers resolves to stage, NOT prod (AC-014)", () => {
    // A preview deployment whose host is neither localhost nor the prod host
    // must never be tagged prod — that would pollute env:prod RUM data.
    process.env[URL_KEY] =
      "https://app-stage-git-symphony-pln-818.preview.closedloop-stage.ai";
    expect(getAppEnvironment()).toBe("stage");
  });

  test("unknown/empty URL with no env var resolves to stage, not prod", () => {
    expect(getAppEnvironment()).toBe("stage");
  });

  test("a host that merely contains the prod host as a substring is not prod", () => {
    // e.g. an attacker-style or preview host like app.closedloop.ai.evil.com
    // would `.includes("app.closedloop.ai")` but not `//app.closedloop.ai`.
    process.env[URL_KEY] = "https://app.closedloop.ai.preview.example.com";
    expect(getAppEnvironment()).toBe("stage");
  });

  test("VERCEL_ENV=preview resolves to preview", () => {
    process.env[VERCEL_ENV_KEY] = "preview";
    expect(getAppEnvironment()).toBe("preview");
  });

  test("VERCEL_ENV=preview wins over a mis-scoped NEXT_PUBLIC_APP_ENVIRONMENT=production (FEA-1466)", () => {
    // The whole point of keying off VERCEL_ENV: a preview deployment must never
    // be tagged env:prod, even if NEXT_PUBLIC_APP_ENVIRONMENT is scoped to
    // "production" across all Vercel environments.
    process.env[VERCEL_ENV_KEY] = "preview";
    process.env[ENV_KEY] = "production";
    process.env[URL_KEY] = "https://app.closedloop.ai";
    expect(getAppEnvironment()).toBe("preview");
  });

  test("VERCEL_ENV=development resolves to local", () => {
    process.env[VERCEL_ENV_KEY] = "development";
    expect(getAppEnvironment()).toBe("local");
  });

  test("VERCEL_ENV=production with explicit production resolves to prod", () => {
    // Real prod: app-prod project deploys to a Vercel production target.
    process.env[VERCEL_ENV_KEY] = "production";
    process.env[ENV_KEY] = "production";
    expect(getAppEnvironment()).toBe("prod");
  });

  test("VERCEL_ENV=production with prod host (no explicit env) resolves to prod", () => {
    process.env[VERCEL_ENV_KEY] = "production";
    process.env[URL_KEY] = "https://app.closedloop.ai";
    expect(getAppEnvironment()).toBe("prod");
  });

  test("VERCEL_ENV=production for stage (production target, non-prod host) resolves to stage", () => {
    // Stage also deploys to a Vercel production target; it is split from real
    // prod by the explicit env var / host heuristic, not by VERCEL_ENV.
    process.env[VERCEL_ENV_KEY] = "production";
    process.env[ENV_KEY] = "stage";
    process.env[URL_KEY] = "https://app-stage.closedloop-stage.ai";
    expect(getAppEnvironment()).toBe("stage");
  });
});
