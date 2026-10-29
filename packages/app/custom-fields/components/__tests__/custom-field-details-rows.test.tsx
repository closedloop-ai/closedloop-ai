import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { customFieldKeys } from "@repo/app/custom-fields/hooks/use-custom-fields";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import type { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTITY_ID,
  makeField,
  makeOption,
  makeUser,
  makeValue,
} from "../../lib/__tests__/custom-field-details-fixtures";
import { useCustomFieldDetailsRows } from "../custom-field-details-rows";

/** ISS-12302 / PLN-2173 M2: the custom-field rows a Details host draws. */

const get = vi.fn();
const put = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get, put }),
}));

const ITEM_LABEL = "Session one";
const TEXT = makeField("text", CustomFieldType.Text, { name: "Risk" });
const LOW = makeOption("enum", "low", "Low");
const ENUM = makeField("enum", CustomFieldType.Enum, {
  enumOptions: [LOW],
  name: "Severity",
});
const BRANCH_ONLY = makeField("branch-only", CustomFieldType.Text, {
  entityTypes: [CustomFieldEntityType.Branch],
});
const PEOPLE = makeField("people", CustomFieldType.People, { name: "Owners" });
const REFERENCE = makeField("ref", CustomFieldType.Reference, {
  name: "Spec",
});
/** A type a newer server knows and this build does not (`CustomFieldEditor.None`). */
const FUTURE = makeField("future", "FUTURE" as CustomFieldType, {
  name: "Future",
});

const VALUES = [
  makeValue(TEXT, { textValue: "high" }),
  makeValue(BRANCH_ONLY, { textValue: "not mine" }),
];

function routeGet(definitions: CustomFieldWithOptions[]) {
  get.mockImplementation((path: string) => {
    if (path === "/custom-fields") {
      return Promise.resolve(definitions);
    }
    if (path === "/users") {
      return Promise.resolve([makeUser("ada", "Ada")]);
    }
    if (path.startsWith(`/custom-fields/${REFERENCE.id}/reference-targets`)) {
      return Promise.resolve({ hasMore: false, targets: [] });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

function renderRows(
  readValues:
    | ((entityId: string) => Promise<CustomFieldValueDetail[]>)
    | undefined,
  queryClient: QueryClient = createTestQueryClient()
) {
  return renderHook(
    () =>
      useCustomFieldDetailsRows({
        entityId: ENTITY_ID,
        entityType: CustomFieldEntityType.Session,
        itemLabel: ITEM_LABEL,
        readValues,
      }),
    { wrapper: createWrapperWithClient(queryClient) }
  );
}

function RowsHarness({
  readValues,
}: {
  readValues: (entityId: string) => Promise<CustomFieldValueDetail[]>;
}) {
  const rows = useCustomFieldDetailsRows({
    entityId: ENTITY_ID,
    entityType: CustomFieldEntityType.Session,
    itemLabel: ITEM_LABEL,
    readValues,
  });
  return (
    <>
      {rows.map((row) =>
        row.value.kind === "self-saving" ? (
          <div data-row={row.id} key={row.id}>
            {row.value.render(row.edit.mode === "self-saving")}
          </div>
        ) : null
      )}
    </>
  );
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
});

describe("useCustomFieldDetailsRows", () => {
  it("returns no rows and requests nothing without a reader, even with cached data", () => {
    routeGet([TEXT, ENUM]);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(customFieldKeys.list({}), [TEXT, ENUM]);
    queryClient.setQueryData(
      customFieldKeys.values(CustomFieldEntityType.Session, ENTITY_ID),
      VALUES
    );

    const { result } = renderRows(undefined, queryClient);

    expect(result.current).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("draws the applicable fields in definition order, each with its own value", async () => {
    routeGet([ENUM, BRANCH_ONLY, TEXT]);
    const readValues = vi.fn().mockResolvedValue(VALUES);

    const { result } = renderRows(readValues);

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(readValues).toHaveBeenCalledWith(ENTITY_ID);
    expect(
      result.current.map((row) => [
        row.id,
        row.label,
        row.edit.mode,
        row.value.kind === "self-saving" && row.value.empty,
      ])
    ).toEqual([
      [ENUM.id, "Severity", "self-saving", true],
      [TEXT.id, "Risk", "self-saving", false],
    ]);
  });

  it("gives only the multi-value fields the row's width", async () => {
    const labels = makeField("labels", CustomFieldType.MultiEnum, {
      name: "Labels",
    });
    const specs = makeField("specs", CustomFieldType.ReferenceMulti, {
      name: "Specs",
    });
    routeGet([TEXT, ENUM, labels, PEOPLE, REFERENCE, specs]);

    const { result } = renderRows(vi.fn().mockResolvedValue(VALUES));

    await waitFor(() => expect(result.current).toHaveLength(6));
    expect(
      result.current.map((row) => [
        row.id,
        row.value.kind === "self-saving" && row.value.fill,
      ])
    ).toEqual([
      [TEXT.id, false],
      [ENUM.id, false],
      [labels.id, true],
      [PEOPLE.id, true],
      [REFERENCE.id, false],
      [specs.id, true],
    ]);
  });

  it("makes a type with no editor read-only, with no reason", async () => {
    routeGet([FUTURE, TEXT]);

    const { result } = renderRows(vi.fn().mockResolvedValue(VALUES));

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((row) => row.edit)).toEqual([
      { mode: "read-only" },
      { mode: "self-saving" },
    ]);
  });

  it("returns no rows while the values read is loading", async () => {
    routeGet([TEXT]);
    const queryClient = createTestQueryClient();

    const { result } = renderRows(
      () => new Promise(() => undefined),
      queryClient
    );

    await waitFor(() =>
      expect(queryClient.getQueryState(customFieldKeys.list({}))?.status).toBe(
        "success"
      )
    );
    expect(result.current).toEqual([]);
  });

  it("returns no rows when the values read fails", async () => {
    routeGet([TEXT]);
    const queryClient = createTestQueryClient();

    const { result } = renderRows(
      vi.fn().mockRejectedValue(new Error("500")),
      queryClient
    );

    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          customFieldKeys.values(CustomFieldEntityType.Session, ENTITY_ID)
        )?.status
      ).toBe("error")
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(customFieldKeys.list({}))?.status).toBe(
        "success"
      )
    );
    expect(result.current).toEqual([]);
  });

  it("returns no rows when the definitions read fails", async () => {
    get.mockRejectedValue(new Error("500"));
    const queryClient = createTestQueryClient();

    const { result } = renderRows(
      vi.fn().mockResolvedValue(VALUES),
      queryClient
    );

    await waitFor(() =>
      expect(queryClient.getQueryState(customFieldKeys.list({}))?.status).toBe(
        "error"
      )
    );
    expect(result.current).toEqual([]);
  });

  it("reads the org users only when a PEOPLE field applies", async () => {
    routeGet([TEXT, ENUM]);
    const withoutPeople = renderRows(vi.fn().mockResolvedValue(VALUES));
    await waitFor(() => expect(withoutPeople.result.current).toHaveLength(2));
    expect(get).not.toHaveBeenCalledWith("/users");

    routeGet([PEOPLE]);
    const withPeople = renderRows(vi.fn().mockResolvedValue([]));
    await waitFor(() => expect(withPeople.result.current).toHaveLength(1));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/users"));
  });
});

describe("Details custom-field editors", () => {
  it("edits a TEXT field with the typed editor and an ENUM with the grid cell", async () => {
    routeGet([TEXT, ENUM]);
    render(<RowsHarness readValues={vi.fn().mockResolvedValue(VALUES)} />, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    expect(await screen.findByRole("textbox", { name: "Risk" })).toHaveValue(
      "high"
    );
    expect(
      screen.getByRole("button", { name: `Edit Severity for ${ITEM_LABEL}` })
    ).toBeInTheDocument();
  });

  it("gives the typed editor the Details save behavior: an untouched blur writes nothing", async () => {
    routeGet([TEXT]);
    const queryClient = createTestQueryClient();
    render(<RowsHarness readValues={vi.fn().mockResolvedValue(VALUES)} />, {
      wrapper: createWrapperWithClient(queryClient),
    });
    const input = await screen.findByRole("textbox", { name: "Risk" });

    act(() => input.focus());
    act(() => input.blur());

    // A write registers its mutation synchronously, before its PUT is sent.
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("attributes a scalar Details save to the detail surface", async () => {
    routeGet([TEXT]);
    put.mockResolvedValue({});
    render(<RowsHarness readValues={vi.fn().mockResolvedValue(VALUES)} />, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    const input = await screen.findByRole("textbox", { name: "Risk" });

    fireEvent.change(input, { target: { value: "critical" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `/agent-sessions/${ENTITY_ID}/custom-field-values/${TEXT.id}`,
        {
          value: "critical",
          surface: ArtifactStatusEditSurface.Detail,
        }
      )
    );
  });

  it("searches reference targets for this field, excluding the entity itself", async () => {
    routeGet([REFERENCE]);
    render(<RowsHarness readValues={vi.fn().mockResolvedValue([])} />, {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: `Edit Spec for ${ITEM_LABEL}` })
    );

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        `/custom-fields/${REFERENCE.id}/reference-targets?query=&excludeEntityId=${ENTITY_ID}`
      )
    );
  });
});
