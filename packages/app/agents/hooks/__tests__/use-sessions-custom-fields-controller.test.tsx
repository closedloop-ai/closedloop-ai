import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  createAgentSessionListItemFixture,
  createSessionTableRowFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import { everySessionHasCustomFieldProjection } from "@repo/app/agents/lib/session-custom-field-operands";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsCustomFieldsController } from "../use-sessions-custom-fields-controller";

const mocks = vi.hoisted(() => ({
  createField: vi.fn(),
  searchReferenceTargets: vi.fn(),
  updateField: vi.fn(),
  updateValue: vi.fn(),
  useCustomFields: vi.fn(),
}));

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutateAsync: mocks.createField }),
  useCustomFieldReferenceTargetSearch: () => mocks.searchReferenceTargets,
  useCustomFields: (options: unknown) => mocks.useCustomFields(options),
  useUpdateCustomField: () => ({ mutateAsync: mocks.updateField }),
  useUpdateCustomFieldValueForEntityType: () => ({
    mutateAsync: mocks.updateValue,
  }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const SESSION_FIELD = buildField("session-field", [
  CustomFieldEntityType.Session,
]);
const DOCUMENT_FIELD = buildField("document-field", [
  CustomFieldEntityType.Document,
]);
const HIDDEN_SESSION_FIELD = {
  ...buildField("hidden-session-field", [CustomFieldEntityType.Session]),
  showInTable: false,
};
const ITEM = createAgentSessionListItemFixture({
  id: "session-1",
  customFields: [],
});

describe("useSessionsCustomFieldsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createField.mockResolvedValue(SESSION_FIELD);
    mocks.searchReferenceTargets.mockResolvedValue({
      targets: [],
      hasMore: false,
    });
    mocks.updateField.mockResolvedValue(DOCUMENT_FIELD);
    mocks.updateValue.mockResolvedValue(undefined);
    mocks.useCustomFields.mockReturnValue({
      data: [SESSION_FIELD, DOCUMENT_FIELD, HIDDEN_SESSION_FIELD],
      isSuccess: true,
    });
  });

  it("separates Session fields from fields available for explicit attachment", async () => {
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM]),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    expect(result.current?.fields).toEqual([
      SESSION_FIELD,
      HIDDEN_SESSION_FIELD,
    ]);
    expect(result.current?.availableFields).toEqual([
      DOCUMENT_FIELD,
      HIDDEN_SESSION_FIELD,
    ]);
    expect(result.current?.valuesBySessionId.get(ITEM.id)).toEqual([]);

    await act(async () => {
      await result.current?.onAddExistingField?.(DOCUMENT_FIELD.id);
    });

    expect(mocks.updateField).toHaveBeenCalledWith({
      id: DOCUMENT_FIELD.id,
      entityTypes: [
        CustomFieldEntityType.Document,
        CustomFieldEntityType.Session,
      ],
      showInTable: true,
    });

    await act(async () => {
      await result.current?.onAddExistingField?.(HIDDEN_SESSION_FIELD.id);
    });
    expect(mocks.updateField).toHaveBeenLastCalledWith({
      id: HIDDEN_SESSION_FIELD.id,
      entityTypes: [CustomFieldEntityType.Session],
      showInTable: true,
    });
  });

  it("writes the edited Session and refreshes both Sessions list read shapes", async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM]),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await act(async () => {
      await result.current?.onValueChange?.(
        { id: ITEM.id } as never,
        SESSION_FIELD,
        "ready"
      );
    });

    expect(mocks.updateValue).toHaveBeenCalledWith({
      entityId: ITEM.id,
      fieldId: SESSION_FIELD.id,
      value: "ready",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: agentSessionKeys.lists(),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: agentSessionKeys.pageDataRoot(),
    });
  });

  it("commits two rapid value edits in click order, not arrival order", async () => {
    // codex review cid 3884184666. The first write is made to resolve LAST, so
    // a handler that fired both concurrently would let the second land first —
    // the ordering this test exists to forbid. Resolution is driven by the test
    // body, never by a sleep.
    const settled: string[] = [];
    let releaseFirst: (() => void) | undefined;
    mocks.updateValue.mockImplementation(({ value }: { value: string }) => {
      if (value === "first") {
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            settled.push("first");
            resolve();
          };
        });
      }
      settled.push(value);
      return Promise.resolve();
    });

    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    let both: Promise<unknown> | undefined;
    await act(async () => {
      const first = result.current?.onValueChange?.(
        { id: ITEM.id } as never,
        SESSION_FIELD,
        "first"
      );
      const second = result.current?.onValueChange?.(
        { id: ITEM.id } as never,
        SESSION_FIELD,
        "second"
      );
      both = Promise.all([first, second]);
      // Drain the microtasks the chain hops through so the FIRST write is
      // genuinely in flight. `both` is deliberately not awaited here — it
      // cannot settle until the test releases the first write below.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The second write has NOT been issued: it is queued behind the first, and
    // the first is still open. Asserted as a call count on the production mock
    // rather than as elapsed time.
    expect(mocks.updateValue).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst?.();
      await both;
    });

    expect(settled).toEqual(["first", "second"]);
  });

  it("keeps writing after one edit fails", async () => {
    // The chain stores the SETTLED promise, so a rejected write must not wedge
    // every later edit for the life of the mount.
    mocks.updateValue.mockRejectedValueOnce(new Error("write rejected"));

    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await act(async () => {
      await expect(
        result.current?.onValueChange?.(
          { id: ITEM.id } as never,
          SESSION_FIELD,
          "doomed"
        )
      ).rejects.toThrow("write rejected");
    });

    await act(async () => {
      await result.current?.onValueChange?.(
        { id: ITEM.id } as never,
        SESSION_FIELD,
        "recovered"
      );
    });

    expect(mocks.updateValue).toHaveBeenLastCalledWith({
      entityId: ITEM.id,
      fieldId: SESSION_FIELD.id,
      value: "recovered",
    });
  });

  it("withholds the controller when a version-skewed row omitted values", () => {
    const itemWithoutProjection: AgentSessionListItem =
      createAgentSessionListItemFixture({ id: "session-old" });
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([itemWithoutProjection]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenCalledWith({ enabled: false });
  });

  it("withholds the controller when any populated row omitted the projection", () => {
    const itemWithoutProjection: AgentSessionListItem =
      createAgentSessionListItemFixture({ id: "session-local" });
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM, itemWithoutProjection]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenCalledWith({ enabled: false });
  });

  it("refuses a value write for a row whose producer omitted the operand", async () => {
    const itemWithoutProjection: AgentSessionListItem =
      createAgentSessionListItemFixture({ id: "session-local" });
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM, itemWithoutProjection]),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    await act(async () => {
      await result.current?.onValueChange?.(
        createSessionTableRowFixture({ id: itemWithoutProjection.id }),
        SESSION_FIELD,
        "refused"
      );
    });

    expect(result.current).toBeUndefined();
    expect(mocks.updateValue).not.toHaveBeenCalled();
  });

  it("ISS-12455: fires no field query when the caller disables it, even with a well-formed row", () => {
    // `ITEM` alone would make `valuesAvailable` true (it carries `customFields`)
    // — the case the explicit `enabled: false` option exists to override, for a
    // caller (the Desktop host, local mode) that must never query this endpoint.
    const { result } = renderHook(
      () => useSessionsCustomFieldsController([ITEM], { enabled: false }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("everySessionHasCustomFieldProjection", () => {
  it("requires the projection on every populated row", () => {
    const itemWithoutProjection: AgentSessionListItem =
      createAgentSessionListItemFixture({ id: "session-local" });

    expect(everySessionHasCustomFieldProjection([])).toBe(true);
    expect(everySessionHasCustomFieldProjection([ITEM])).toBe(true);
    expect(
      everySessionHasCustomFieldProjection([ITEM, itemWithoutProjection])
    ).toBe(false);
  });
});

function buildField(
  id: string,
  entityTypes: CustomFieldEntityType[]
): CustomFieldWithOptions {
  const timestamp = new Date("2026-08-28T00:00:00.000Z");
  return {
    id,
    organizationId: "org-1",
    name: id,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes,
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}
