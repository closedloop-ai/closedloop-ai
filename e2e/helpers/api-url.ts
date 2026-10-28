/**
 * Resolve the API server base URL.
 *
 * In CI preview runs, API_BASE_URL should point at the stable git-branch alias
 * for the API preview. We intentionally do not derive an API hostname from a
 * deployment-hash app URL because app and api preview hashes can differ.
 *
 * Locally, the API runs on port 3002.
 */
import { localTrustedApiBaseUrl } from "../playwright-projects";
import { isClerkFreeRun } from "./clerk-free";

const LOCAL_APP_ORIGIN = "http://localhost:3000";
const LOCAL_API_ORIGIN = "http://localhost:3002";
const APP_PREVIEW_ALIAS_REGEX = /^app-(stage|prod)-git-/;
const APP_STAGE_ORIGIN = "https://app.stage.example";
const API_STAGE_ORIGIN = "https://api.stage.example";
const APP_PROD_ORIGIN = "https://app.closedloop.ai";
const API_PROD_ORIGIN = "https://api.closedloop.ai";
const APP_PREFIX_REGEX = /^app-/;
const TRAILING_SLASHES_REGEX = /\/+$/;

function stripTrailingSlashes(url: string): string {
  return url.replace(TRAILING_SLASHES_REGEX, "");
}

export function getApiBaseUrl(): string {
  // ISS-10335: a Clerk-free project reads `api-local`, and it does so BEFORE the
  // `API_BASE_URL` branch below. That order is the point — the containerized
  // runner exports `API_BASE_URL=http://localhost:3002` for the whole process,
  // so an override-first read would send every Clerk-free spec to the
  // Clerk-gated api, which answers 401 to the inert placeholder bearer. The
  // per-lane host has its own override, `E2E_LOCAL_TRUSTED_API_BASE_URL`.
  if (isClerkFreeRun()) {
    return stripTrailingSlashes(localTrustedApiBaseUrl());
  }

  if (process.env.API_BASE_URL) {
    return stripTrailingSlashes(process.env.API_BASE_URL);
  }

  const baseUrl = stripTrailingSlashes(
    process.env.BASE_URL ?? LOCAL_APP_ORIGIN
  );

  if (baseUrl === LOCAL_APP_ORIGIN) {
    return LOCAL_API_ORIGIN;
  }

  if (baseUrl === APP_STAGE_ORIGIN) {
    return API_STAGE_ORIGIN;
  }

  if (baseUrl === APP_PROD_ORIGIN) {
    return API_PROD_ORIGIN;
  }

  const url = new URL(baseUrl);

  if (
    url.hostname.includes(".preview.") &&
    APP_PREVIEW_ALIAS_REGEX.test(url.hostname)
  ) {
    return `${url.protocol}//${url.hostname.replace(APP_PREFIX_REGEX, "api-")}`;
  }

  throw new Error(
    `Could not resolve API base URL from BASE_URL=${baseUrl}. ` +
      "Set API_BASE_URL explicitly for deployment-hash previews."
  );
}
