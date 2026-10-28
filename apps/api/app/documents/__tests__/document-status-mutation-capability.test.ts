/**
 * ISS-9559: the permission half of the status-mutation capability.
 *
 * ISS-9433 shipped the subtype half — which statuses an artifact's subtype
 * accepts. It answered from the subtype alone, so a read-scoped `sk_live_*` key
 * was handed a list of statuses it "may" set by two routes that would 403 it.
 * These pin the caller's own grant, and the omission a producer that cannot
 * resolve one must preserve.
 *
 * Scope literals here are written out by hand rather than read back from
 * `DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES`: a test that sources its
 * expectation from the table it polices stays green when the table changes.
 */
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { describe, expect, it } from "vitest";
import { createTestAuthContext } from "../../../__tests__/utils/auth-helpers";
import {
  buildDocumentStatusMutation,
  DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES,
  documentStatusMutationPermissionsForAuth,
} from "../document-status-mutation-capability";

describe("documentStatusMutationPermissionsForAuth", () => {
  it("refuses both status writes for an api key that holds only read", () => {
    const permissions = documentStatusMutationPermissionsForAuth(
      createTestAuthContext({
        authMethod: "api_key",
        apiKeyScopes: [ApiKeyScope.Read],
      })
    );

    expect(permissions).toEqual({ single: false, bulk: false });
  });

  it("allows both for the same caller once it holds write", () => {
    const permissions = documentStatusMutationPermissionsForAuth(
      createTestAuthContext({
        authMethod: "api_key",
        apiKeyScopes: [ApiKeyScope.Read, ApiKeyScope.Write],
      })
    );

    expect(permissions).toEqual({ single: true, bulk: true });
  });

  it("refuses both when an api key resolves no scopes at all", () => {
    const permissions = documentStatusMutationPermissionsForAuth(
      createTestAuthContext({ authMethod: "api_key", apiKeyScopes: [] })
    );

    expect(permissions).toEqual({ single: false, bulk: false });
  });

  it("allows both for a browser session, which carries no api-key scopes", () => {
    const permissions = documentStatusMutationPermissionsForAuth(
      createTestAuthContext({ authMethod: "session" })
    );

    expect(permissions).toEqual({ single: true, bulk: true });
  });
});

describe("buildDocumentStatusMutation", () => {
  it("omits the permissions key entirely when no caller was resolved", () => {
    const capability = buildDocumentStatusMutation(DocumentType.Feature);

    expect("permissions" in capability).toBe(false);
  });

  it("carries the resolved permissions when a caller was", () => {
    const capability = buildDocumentStatusMutation(DocumentType.Feature, {
      [DocumentStatusMutationOperation.Single]: false,
      [DocumentStatusMutationOperation.Bulk]: false,
    });

    expect(capability.permissions).toEqual({ single: false, bulk: false });
    expect(capability.allowedStatuses).toContain(IssueStatus.Done);
  });

  it("demands write for both operations", () => {
    expect(DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES).toEqual({
      single: ["write"],
      bulk: ["write"],
    });
  });
});
