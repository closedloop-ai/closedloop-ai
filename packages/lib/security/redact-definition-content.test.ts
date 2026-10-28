import { usageScopeHashForContent } from "@repo/api/src/agent-component-usage-scope";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  carriesRedactionMarker,
  redactDefinitionBody,
  redactInvocationDefinitionContent,
} from "./redact-definition-content.js";
import { redactSecrets } from "./redact-secrets.js";
import { SYNTHETIC_GITHUB_TOKEN } from "./synthetic-secrets.test-helpers.js";

describe("ISS-4965: redactInvocationDefinitionContent", () => {
  it("returns clean content unchanged, with no marker", () => {
    const item = skillItem({ definitionContent: "Review only real bugs." });

    expect(redactInvocationDefinitionContent(item)).toBe(item);
  });

  it("keeps an omitted hash and contract version omitted", () => {
    const redacted = redactInvocationDefinitionContent(
      skillItem({ definitionContent: `TOKEN=${SYNTHETIC_GITHUB_TOKEN}` })
    );

    expect(redacted.definitionContent).toBe("TOKEN=[REDACTED:ghp]");
    expect(Object.hasOwn(redacted, "definitionHash")).toBe(false);
    expect(Object.hasOwn(redacted, "normalizerContractVersion")).toBe(false);
  });
});

describe("ISS-4965: redactDefinitionBody", () => {
  it("keeps the usage digest of the text as written when it redacts", () => {
    const raw = `TOKEN=${SYNTHETIC_GITHUB_TOKEN}`;

    expect(redactDefinitionBody(raw, AgentComponentKind.Skill)).toEqual({
      content: "TOKEN=[REDACTED:ghp]",
      usageScopeHash: usageScopeHashForContent(raw, AgentComponentKind.Skill),
    });
  });

  it("omits the digest for a clean body", () => {
    expect(
      redactDefinitionBody("Review only real bugs.", AgentComponentKind.Skill)
    ).toEqual({
      content: "Review only real bugs.",
    });
  });
});

describe("ISS-4965: carriesRedactionMarker", () => {
  it("recognizes the marker redactSecrets writes and nothing else", () => {
    expect(
      carriesRedactionMarker(redactSecrets(`TOKEN=${SYNTHETIC_GITHUB_TOKEN}`))
    ).toBe(true);
    expect(carriesRedactionMarker("TOKEN=[REDACTED]")).toBe(false);
  });
});

function skillItem(
  overrides: Partial<AgentComponentInvocationSyncItem>
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "code-review",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: null,
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}
