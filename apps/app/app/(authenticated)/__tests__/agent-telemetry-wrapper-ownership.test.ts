import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUTHENTICATED_DIR = join(import.meta.dirname, "..");
const ORG_DASHBOARD_PAGE = join(
  AUTHENTICATED_DIR,
  "[orgSlug]",
  "dashboard",
  "page.tsx"
);
const ORG_MONITORING_PAGE = join(
  AUTHENTICATED_DIR,
  "[orgSlug]",
  "loops",
  "monitoring",
  "page.tsx"
);
const NON_ORG_MONITORING_PAGE = join(
  AUTHENTICATED_DIR,
  "loops",
  "monitoring",
  "page.tsx"
);

const FLAG_IMPORT_RE = /DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY/;
const HEADER_IMPORT_RE = /Header/;
const ORG_SLUG_RE = /useOrgSlug/;
const ANALYTICS_CAPTURE_RE = /analytics\.capture\("agent_sessions_/;
const ORG_ANALYTICS_ENABLED_RE = /analyticsBreakdownsEnabled/;
const ORG_FILTERS_ENABLED_RE = /organizationFiltersEnabled/;
const ARTIFACT_COLUMN_RE = /extraColumnLabel="Artifact"/;
const SOURCE_ARTIFACT_ROUTE_RE =
  /buildScopedDocumentPath|getRoutePrefixForType/;
const PACKAGE_BODY_RE = /AgentTelemetry(?:Dashboard|Analytics)/;
// The org dashboard delegates its body to the shared Insights overview
// dashboard (FEA-2148), wrapped in the web Insights data-source provider — the
// page itself only owns flag/Header/orgSlug/href chrome.
const ORG_DASHBOARD_BODY_RE = /InsightsOverviewDashboard/;
const ORG_DASHBOARD_PROVIDER_RE = /WebInsightsDataSourceProvider/;
const ORG_SESSION_HREF_RE = /`\/\$\{orgSlug\}\/sessions\/\$\{session\.id\}`/;
const ORG_MONITORING_HREF_RE = /`\/\$\{orgSlug\}\/loops\/monitoring/;
const NON_ORG_SESSION_HREF_RE = /`\/sessions\/\$\{session\.id\}`/;

describe("agent telemetry route wrapper ownership", () => {
  it("keeps the org dashboard as a feature-flagged Header wrapper", () => {
    const source = readFileSync(ORG_DASHBOARD_PAGE, "utf8");

    expect(source).toMatch(FLAG_IMPORT_RE);
    expect(source).toMatch(HEADER_IMPORT_RE);
    expect(source).toMatch(ORG_SLUG_RE);
    expect(source).toMatch(ORG_DASHBOARD_BODY_RE);
    expect(source).toMatch(ORG_DASHBOARD_PROVIDER_RE);
    expect(source).toMatch(ORG_SESSION_HREF_RE);
  });

  it("keeps org monitoring analytics, Artifact, source routes, and analytics capture app-owned", () => {
    const source = readFileSync(ORG_MONITORING_PAGE, "utf8");

    expect(source).toMatch(FLAG_IMPORT_RE);
    expect(source).toMatch(HEADER_IMPORT_RE);
    expect(source).toMatch(ORG_SLUG_RE);
    expect(source).toMatch(ANALYTICS_CAPTURE_RE);
    expect(source).toMatch(ORG_ANALYTICS_ENABLED_RE);
    expect(source).toMatch(ORG_FILTERS_ENABLED_RE);
    expect(source).toMatch(ARTIFACT_COLUMN_RE);
    expect(source).toMatch(SOURCE_ARTIFACT_ROUTE_RE);
    expect(source).toMatch(ORG_MONITORING_HREF_RE);
    expect(source).toMatch(ORG_SESSION_HREF_RE);
  });

  it("keeps non-org monitoring without analytics breakdowns or Artifact source routes", () => {
    const source = readFileSync(NON_ORG_MONITORING_PAGE, "utf8");

    expect(source).toMatch(FLAG_IMPORT_RE);
    expect(source).toMatch(HEADER_IMPORT_RE);
    expect(source).toMatch(ANALYTICS_CAPTURE_RE);
    expect(source).toMatch(PACKAGE_BODY_RE);
    expect(source).toMatch(ORG_FILTERS_ENABLED_RE);
    expect(source).not.toMatch(ORG_ANALYTICS_ENABLED_RE);
    expect(source).not.toMatch(ARTIFACT_COLUMN_RE);
    expect(source).not.toMatch(SOURCE_ARTIFACT_ROUTE_RE);
    expect(source).toMatch(NON_ORG_SESSION_HREF_RE);
    expect(source).toContain("`/loops/monitoring");
  });
});
