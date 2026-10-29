import { afterEach, describe, expect, it, vi } from "vitest";

const ON_ORGANIZATION = "org-on";
const OFF_ORGANIZATION = "org-off";

vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(
    async (organizationId: string) => organizationId === "org-on"
  ),
}));
vi.mock(
  "@/app/agent-sessions/service/attribution/attribution-backfill",
  () => ({
    runAttributionBackfill: vi.fn(async () => ({ completed: true })),
  })
);
vi.mock(
  "@/app/agent-sessions/service/attribution/attribution-comparison",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/agent-sessions/service/attribution/attribution-comparison")
    >()),
    buildAttributionComparisonReport: vi.fn(async () => ({
      global: { links: {} },
    })),
  })
);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: vi.fn(),
}));

import { runAttributionBackfill } from "@/app/agent-sessions/service/attribution/attribution-backfill";
import { buildAttributionComparisonReport } from "@/app/agent-sessions/service/attribution/attribution-comparison";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { main as runBackfillScript } from "../attribution-backfill";
import { main as runComparisonScript } from "../attribution-comparison-report";

const originalArgv = process.argv;

describe("attribution scripts refuse an organization the flag is off for (ISS-12552)", () => {
  afterEach(() => {
    process.argv = originalArgv;
  });

  it("backfills an organization the flag is on for and refuses one it is off for, before any query", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = [
      "node",
      "attribution-backfill.ts",
      "--org",
      OFF_ORGANIZATION,
    ];
    await expect(runBackfillScript()).rejects.toThrow(OFF_ORGANIZATION);
    expect(runAttributionBackfill).not.toHaveBeenCalled();

    process.argv = [
      "node",
      "attribution-backfill.ts",
      "--org",
      ON_ORGANIZATION,
    ];
    await runBackfillScript();
    expect(runAttributionBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ON_ORGANIZATION })
    );
  });

  it("refuses a backfill with no organization, without reading the flag", async () => {
    process.argv = ["node", "attribution-backfill.ts"];

    await expect(runBackfillScript()).rejects.toThrow("--org");
    expect(isAttributionEvidenceEnabledForOrganization).not.toHaveBeenCalled();
    expect(runAttributionBackfill).not.toHaveBeenCalled();
  });

  it("reports only when the flag is on for every named organization", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const reportArgs = ["--out", "report.json"];
    process.argv = [
      "node",
      "attribution-comparison-report.ts",
      ...reportArgs,
      "--org",
      ON_ORGANIZATION,
      "--org",
      OFF_ORGANIZATION,
    ];
    await expect(runComparisonScript()).rejects.toThrow(OFF_ORGANIZATION);
    expect(buildAttributionComparisonReport).not.toHaveBeenCalled();

    process.argv = [
      "node",
      "attribution-comparison-report.ts",
      ...reportArgs,
      "--org",
      ON_ORGANIZATION,
    ];
    await runComparisonScript();
    expect(buildAttributionComparisonReport).toHaveBeenCalledWith(
      expect.objectContaining({ organizationIds: [ON_ORGANIZATION] })
    );
  });

  it("refuses a report with no organization, without reading the flag", async () => {
    process.argv = [
      "node",
      "attribution-comparison-report.ts",
      "--out",
      "report.json",
    ];

    await expect(runComparisonScript()).rejects.toThrow("--org");
    expect(isAttributionEvidenceEnabledForOrganization).not.toHaveBeenCalled();
    expect(buildAttributionComparisonReport).not.toHaveBeenCalled();
  });
});
