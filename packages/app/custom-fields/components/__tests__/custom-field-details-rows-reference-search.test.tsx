import {
  CustomFieldEntityType,
  type CustomFieldReferenceSearchResponse,
  CustomFieldType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { customFieldKeys } from "@repo/app/custom-fields/hooks/use-custom-fields";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  ENTITY_ID,
  makeField,
  makeTarget,
} from "../../lib/__tests__/custom-field-details-fixtures";
import { useCustomFieldDetailsRows } from "../custom-field-details-rows";
import type { CustomFieldTableValue } from "../custom-field-table-cell";

/**
 * ISS-12302: a reference picker's searches on the Details tab, when an older
 * search answers after a newer one.
 */

const get = vi.fn();
const put = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get, put }),
}));

type CellProps = {
  loadReferenceOptions?: (
    query: string
  ) => Promise<CustomFieldReferenceSearchResponse>;
  onValueChange: (next: CustomFieldTableValue) => Promise<unknown>;
};

let cell: CellProps | undefined;

vi.mock("../custom-field-table-cell", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CustomFieldTableCell: (props: CellProps) => {
    cell = props;
    return null;
  },
}));

const SPECS = makeField("specs", CustomFieldType.ReferenceMulti, {
  name: "Specs",
});
const OLDER_HIT = makeTarget("older-hit", "Older hit");
const NEWER_HIT = makeTarget("newer-hit", "Newer hit");

function RowsHarness() {
  const rows = useCustomFieldDetailsRows({
    entityId: ENTITY_ID,
    entityType: CustomFieldEntityType.Session,
    itemLabel: "Session one",
    readValues: () => Promise.resolve([]),
  });
  return (
    <>
      {rows.map((row) =>
        row.value.kind === "self-saving" ? (
          <div key={row.id}>{row.value.render(true)}</div>
        ) : null
      )}
    </>
  );
}

function loadedCell(): CellProps {
  if (!cell) {
    throw new Error("the reference cell has not rendered");
  }
  return cell;
}

beforeEach(() => {
  cell = undefined;
  get.mockReset();
  put.mockReset();
});

describe("Details reference search", () => {
  it("keeps the newer search's page when an older one answers last, so a pick from it is shown", async () => {
    const older = deferred<CustomFieldReferenceSearchResponse>();
    const newer = deferred<CustomFieldReferenceSearchResponse>();
    get.mockImplementation((path: string) => {
      if (path === "/custom-fields") {
        return Promise.resolve([SPECS]);
      }
      if (path.includes("reference-targets?query=ab&")) {
        return newer.promise;
      }
      if (path.includes("reference-targets?query=a&")) {
        return older.promise;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    put.mockReturnValue(new Promise(() => undefined));
    const queryClient = createTestQueryClient();
    render(<RowsHarness />, { wrapper: createWrapperWithClient(queryClient) });
    await waitFor(() => expect(cell?.loadReferenceOptions).toBeDefined());
    const load = loadedCell().loadReferenceOptions;
    if (!load) {
      throw new Error("the reference cell has no loader");
    }

    const olderLoad = load("a");
    const newerLoad = load("ab");
    await act(async () => {
      newer.resolve({ hasMore: false, targets: [NEWER_HIT] });
      await newerLoad;
    });
    await act(async () => {
      older.resolve({ hasMore: false, targets: [OLDER_HIT] });
      await olderLoad;
    });
    act(() => {
      loadedCell().onValueChange([NEWER_HIT.id]);
    });

    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<CustomFieldValueDetail[]>(
            customFieldKeys.values(CustomFieldEntityType.Session, ENTITY_ID)
          )
          ?.find((value) => value.customFieldId === SPECS.id)
          ?.referenceValues.map((target) => target.id)
      ).toEqual([NEWER_HIT.id])
    );
  });
});
