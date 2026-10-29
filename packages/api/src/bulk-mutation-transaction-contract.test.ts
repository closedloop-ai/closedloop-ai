/**
 * ISS-9465 — the two shared contracts the transaction identity added: the
 * permanent audit vocabulary, and the optional `transactionId` on a v2 batch
 * response.
 *
 * Every action and object type below is spelled as a LITERAL rather than
 * imported from the const it guards. A fixture built from the constant agrees
 * with the constant's own mistake, and these values are hashed into an
 * append-only chain — the docstring's "Add, never rename" is not a style note,
 * it is a statement that a typo here can never be corrected, only supplemented.
 */
import { describe, expect, it } from "vitest";
import { AuditAction, AuditObjectType } from "./types/audit.ts";
import { batchMutationResponseSchema } from "./types/batch-mutation-result.ts";

describe("audit vocabulary", () => {
  it("spells the members ISS-9465 minted exactly as the ledger stores them", () => {
    expect(AuditAction.DocumentPriorityChanged).toBe(
      "document.priority_changed"
    );
    expect(AuditAction.ArtifactProjectChanged).toBe("artifact.project_changed");
    expect(AuditAction.ArtifactTagApplied).toBe("artifact.tag_applied");
    expect(AuditAction.ArtifactTagRemoved).toBe("artifact.tag_removed");
    expect(AuditAction.AgentSessionAssigned).toBe("agent_session.assigned");
    expect(AuditObjectType.Artifact).toBe("artifact");
    expect(AuditObjectType.AgentSession).toBe("agent_session");
  });

  it("keeps every action's object half equal to a real object type", () => {
    // The `<object>.<verb>` convention is what lets a reader join an action to
    // the record it describes. A member whose prefix names no object type is a
    // permanent inconsistency, so the whole set is checked rather than the new
    // half: the rule binds the members that already shipped too.
    const objectTypes = new Set<string>(Object.values(AuditObjectType));
    for (const action of Object.values(AuditAction)) {
      expect(objectTypes).toContain(action.split(".")[0]);
    }
  });
});

describe("v2 batch response, read by a version-skewed client", () => {
  const applied = { id: "artifact-1", status: 200 };

  it("accepts a body from a server that predates the field", () => {
    const parsed = batchMutationResponseSchema.parse({ results: [applied] });

    expect(parsed.transactionId).toBeUndefined();
    expect(parsed.results).toHaveLength(1);
  });

  it("reads the field when the server sends it", () => {
    const parsed = batchMutationResponseSchema.parse({
      results: [applied],
      transactionId: "7e2f3a1c-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
    });

    expect(parsed.transactionId).toBe("7e2f3a1c-4b5d-4e6f-8a9b-0c1d2e3f4a5b");
  });

  it("ignores a field a NEWER server added, rather than rejecting the body", () => {
    const parsed = batchMutationResponseSchema.parse({
      results: [applied],
      transactionId: "7e2f3a1c-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
      invalidationHint: { scope: "documents" },
    });

    expect(parsed.results).toHaveLength(1);
    expect(parsed.transactionId).toBe("7e2f3a1c-4b5d-4e6f-8a9b-0c1d2e3f4a5b");
  });
});
