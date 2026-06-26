import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  customFieldKeys,
  useCreateCustomField,
  useDeleteCustomField,
  useUpdateCustomField,
  useUpdateCustomFieldValue,
} from "../use-custom-fields";

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// ---------------------------------------------------------------------------
// customFieldKeys
// ---------------------------------------------------------------------------

describe("customFieldKeys", () => {
  test("all returns stable base key", () => {
    expect(customFieldKeys.all).toEqual(["custom-fields"]);
  });

  test("lists() returns list namespace key", () => {
    expect(customFieldKeys.lists()).toEqual(["custom-fields", "list"]);
  });

  test("list(filters) includes filters in key and is unique per filter set", () => {
    const keyA = customFieldKeys.list({ name: "priority" });
    const keyB = customFieldKeys.list({ name: "severity" });

    expect(keyA).toEqual(["custom-fields", "list", { name: "priority" }]);
    expect(keyB).toEqual(["custom-fields", "list", { name: "severity" }]);
    expect(keyA).not.toEqual(keyB);
  });

  test("detail(id) includes id and is unique per id", () => {
    const keyA = customFieldKeys.detail("field-1");
    const keyB = customFieldKeys.detail("field-2");

    expect(keyA).toEqual(["custom-fields", "detail", "field-1"]);
    expect(keyB).toEqual(["custom-fields", "detail", "field-2"]);
    expect(keyA).not.toEqual(keyB);
  });

  test("enumOptions(fieldId) is nested under detail key", () => {
    const key = customFieldKeys.enumOptions("field-1");
    const detailKey = customFieldKeys.detail("field-1");

    expect(key).toEqual([...detailKey, "enum-options"]);
  });

  test("settings(entityType, entityId) produces unique keys per entity type and id", () => {
    const keyProject = customFieldKeys.settings(
      CustomFieldEntityType.Project,
      "proj-1"
    );
    const keyDifferentId = customFieldKeys.settings(
      CustomFieldEntityType.Project,
      "proj-2"
    );

    expect(keyProject).toEqual([
      "custom-fields",
      "settings",
      CustomFieldEntityType.Project,
      "proj-1",
    ]);
    expect(keyProject).not.toEqual(keyDifferentId);
  });
});

// ---------------------------------------------------------------------------
// useDeleteCustomField
// ---------------------------------------------------------------------------

describe("useDeleteCustomField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls DELETE endpoint with the field id", async () => {
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

    const { result } = renderHook(() => useDeleteCustomField(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("field-123");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/custom-fields/field-123"
    );
  });

  test("onSuccess invalidates customFieldKeys.all to clear all custom-field caches", async () => {
    mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteCustomField(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate("field-123");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: customFieldKeys.all })
    );
  });

  test("surfaces error via isError when DELETE fails", async () => {
    const mockError = new Error("Not found");
    mockApiClient.delete.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useDeleteCustomField(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("field-404");

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});

// ---------------------------------------------------------------------------
// useUpdateCustomField
// ---------------------------------------------------------------------------

describe("useUpdateCustomField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls PUT endpoint with id in URL and remaining fields in body", async () => {
    const updated = {
      id: "field-123",
      organizationId: "org-1",
      name: "Severity",
      description: null,
      fieldType: CustomFieldType.Text,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      precision: null,
      numberFormat: null,
      currencyCode: null,
      customLabel: null,
      customLabelPosition: null,
      isGlobalToOrg: false,
      enumOptions: [],
    };
    mockApiClient.put.mockResolvedValueOnce(updated);

    const { result } = renderHook(() => useUpdateCustomField(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "field-123", name: "Severity" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/custom-fields/field-123", {
      name: "Severity",
    });
  });

  test("surfaces error via isError when PUT fails", async () => {
    const mockError = new Error("Validation failed");
    mockApiClient.put.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useUpdateCustomField(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "field-123", name: "Bad" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});

// ---------------------------------------------------------------------------
// useUpdateCustomFieldValue — entity detail key invalidation
// ---------------------------------------------------------------------------

describe("useUpdateCustomFieldValue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls PUT on the project entity endpoint when entityType is Project", async () => {
    mockApiClient.put.mockResolvedValueOnce({});

    const { result } = renderHook(
      () => useUpdateCustomFieldValue(CustomFieldEntityType.Project, "proj-1"),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ fieldId: "field-123", value: "high" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.put).toHaveBeenCalledWith("/projects/proj-1", {
      customFields: { "field-123": "high" },
    });
  });

  test("onSuccess invalidates projectKeys.detail and not customField list keys when entityType is Project", async () => {
    mockApiClient.put.mockResolvedValueOnce({});

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useUpdateCustomFieldValue(CustomFieldEntityType.Project, "proj-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    result.current.mutate({ fieldId: "field-123", value: 42 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectKeys.detail("proj-1") })
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: customFieldKeys.lists() })
    );
  });

  test("onSuccess invalidates documentKeys.detail when entityType is Document (feature-typed)", async () => {
    mockApiClient.put.mockResolvedValueOnce({});

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useUpdateCustomFieldValue(CustomFieldEntityType.Document, "issue-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    result.current.mutate({ fieldId: "field-789", value: ["opt-a", "opt-b"] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: documentKeys.detail("issue-1") })
    );
  });

  test("onSuccess invalidates documentKeys.detail when entityType is Artifact", async () => {
    mockApiClient.put.mockResolvedValueOnce({});

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useUpdateCustomFieldValue(CustomFieldEntityType.Document, "artifact-1"),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    result.current.mutate({ fieldId: "field-abc", value: "2025-01-15" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: documentKeys.detail("artifact-1") })
    );
  });

  test("surfaces error via isError when PUT fails", async () => {
    const mockError = new Error("Unauthorized");
    mockApiClient.put.mockRejectedValueOnce(mockError);

    const { result } = renderHook(
      () => useUpdateCustomFieldValue(CustomFieldEntityType.Project, "proj-1"),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ fieldId: "field-123", value: "bad" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});

// ---------------------------------------------------------------------------
// useCreateCustomField — error state
// ---------------------------------------------------------------------------

describe("useCreateCustomField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("surfaces error via isError when POST fails", async () => {
    const mockError = new Error("Duplicate name");
    mockApiClient.post.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useCreateCustomField(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      name: "Priority",
      fieldType: CustomFieldType.Text,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});
