/**
 * ISS-12552: a SESSION row's `sessionEvidence` passes through
 * `list-artifact-links` field for field. Absent or unreadable evidence stays
 * absent, and keys a newer API adds survive.
 */
import { LinkType } from "@repo/api/src/types/artifact.js";
import {
  ATTRIBUTION_CONTRACT_VERSION,
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListArtifactLinks } from "../tools/list-artifact-links.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const SESSION_EVIDENCE = {
  contractVersion: ATTRIBUTION_CONTRACT_VERSION,
  policyVersion: 1,
  extractorVersion: 1,
  relationshipKind: AttributionRelationshipKind.Revision,
  operations: [
    {
      operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880991",
      relationshipKind: AttributionRelationshipKind.Revision,
      operationKind: OperationKind.UpdateFields,
      outcome: OperationEvidenceOutcome.Committed,
      durableResult: { changedFields: ["fileName"] },
    },
  ],
};

function sessionLink(extra: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    linkType: LinkType.RelatesTo,
    createdAt: "2026-10-16T00:00:00.000Z",
    source: { id: "ses-id", type: "SESSION", name: "Session", slug: "SES-1" },
    target: { id: "doc-id", type: "DOCUMENT", name: "Plan", slug: "PLN-1" },
    ...extra,
  };
}

async function list(link: Record<string, unknown>) {
  const handler = createToolHarness(registerListArtifactLinks, {
    get: vi.fn().mockResolvedValue([link]),
  } as unknown as ApiClient);
  const payload = parseToolPayload(await handler({ artifactId: "PLN-1" })) as {
    items: Record<string, unknown>[];
  };
  return payload.items[0] ?? {};
}

describe("list-artifact-links sessionEvidence (ISS-12552)", () => {
  it("returns a SESSION row's evidence exactly as the API sent it", async () => {
    expect(
      (await list(sessionLink({ sessionEvidence: SESSION_EVIDENCE })))
        .sessionEvidence
    ).toEqual(SESSION_EVIDENCE);
  });

  it("keeps keys a newer API adds", async () => {
    const newer = { ...SESSION_EVIDENCE, futureField: "kept" };

    expect(
      (await list(sessionLink({ sessionEvidence: newer }))).sessionEvidence
    ).toEqual(newer);
  });

  it("leaves absent or unreadable evidence absent", async () => {
    for (const link of [
      sessionLink(),
      sessionLink({ sessionEvidence: { relationshipKind: 7 } }),
    ]) {
      expect("sessionEvidence" in (await list(link))).toBe(false);
    }
  });
});
