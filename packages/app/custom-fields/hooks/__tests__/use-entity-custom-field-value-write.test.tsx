import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  ENTITY_ID,
  makeField,
  makeOption,
  makeValue,
} from "../../lib/__tests__/custom-field-details-fixtures";
import { useUpdateCustomFieldValue } from "../use-custom-fields";
import { useEntityCustomFieldValueWrite } from "../use-entity-custom-field-value-write";
import { useEntityCustomFieldValues } from "../use-entity-custom-field-values";

/** ISS-12302 / PLN-2173 M2: the Details tab's optimistic, ordered value write. */

const put = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ put }),
}));

const RED = makeOption("multi", "red", "Red");
const BLUE = makeOption("multi", "blue", "Blue");
const GREEN = makeOption("multi", "green", "Green");
const MULTI = makeField("multi", CustomFieldType.MultiEnum, {
  enumOptions: [RED, BLUE, GREEN],
});
const TEXT = makeField("text", CustomFieldType.Text);
const VALUE_PATH = `/agent-sessions/${ENTITY_ID}/custom-field-values/${MULTI.id}`;
const LOOKUPS = { people: [], referenceTargets: [] };
const STORED = [makeValue(MULTI, { multiEnumValues: [RED] })];

/** The first read answers `STORED`; later reads answer `laterRead`, by default never. */
function renderWrite(
  laterRead: () => Promise<CustomFieldValueDetail[]> = () =>
    new Promise(() => undefined)
) {
  const readValues = vi
    .fn<(entityId: string) => Promise<CustomFieldValueDetail[]>>()
    .mockResolvedValueOnce(STORED)
    .mockImplementation(laterRead);
  const hook = renderHook(
    () => ({
      values: useEntityCustomFieldValues({
        entityId: ENTITY_ID,
        entityType: CustomFieldEntityType.Session,
        readValues,
      }),
      typed: useUpdateCustomFieldValue(
        CustomFieldEntityType.Session,
        ENTITY_ID
      ),
      write: useEntityCustomFieldValueWrite(
        CustomFieldEntityType.Session,
        ENTITY_ID
      ),
    }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  return { ...hook, readValues };
}

function shownOptions(
  result: ReturnType<typeof renderWrite>["result"]
): string[] | undefined {
  return result.current.values.data
    ?.find((value) => value.customFieldId === MULTI.id)
    ?.multiEnumValues.map((option) => option.id);
}

beforeEach(() => {
  put.mockReset();
});

describe("useEntityCustomFieldValueWrite", () => {
  it("shows the choice before the PUT settles, then PUTs it", async () => {
    const pending = deferred();
    put.mockReturnValue(pending.promise);
    const { result } = renderWrite();
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    act(() => {
      result.current.write(MULTI, ["red", "blue"], LOOKUPS);
    });

    await waitFor(() => expect(shownOptions(result)).toEqual(["red", "blue"]));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(VALUE_PATH, { value: ["red", "blue"] })
    );
  });

  it("puts the confirmed value back on refusal and rejects to the caller", async () => {
    const refused = deferred();
    put.mockReturnValue(refused.promise);
    const { result, readValues } = renderWrite();
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let write: Promise<unknown> = Promise.resolve();
    act(() => {
      write = result.current.write(MULTI, ["red", "blue"], LOOKUPS);
    });
    await waitFor(() => expect(shownOptions(result)).toEqual(["red", "blue"]));
    refused.reject(new Error("400"));

    await expect(write).rejects.toThrow("400");
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));
    // Settled: the values are read again.
    await waitFor(() => expect(readValues).toHaveBeenCalledTimes(2));
  });

  it("does not undo a later choice when an earlier write is refused", async () => {
    const first = deferred();
    const second = deferred();
    put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderWrite();
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let writes: Promise<unknown>[] = [];
    act(() => {
      writes = [
        result.current.write(MULTI, [], LOOKUPS),
        result.current.write(MULTI, ["blue"], LOOKUPS),
      ];
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    first.reject(new Error("400"));
    await expect(writes[0]).rejects.toThrow("400");
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    second.resolve({});
    await writes[1];

    await waitFor(() => expect(shownOptions(result)).toEqual(["blue"]));
  });

  it("commits in click order, one PUT at a time", async () => {
    const first = deferred();
    put.mockReturnValueOnce(first.promise).mockResolvedValueOnce({});
    const { result } = renderWrite();
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let writes: Promise<unknown>[] = [];
    act(() => {
      writes = [
        result.current.write(MULTI, ["red", "blue"], LOOKUPS),
        result.current.write(MULTI, ["blue"], LOOKUPS),
      ];
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    expect(put).toHaveBeenLastCalledWith(VALUE_PATH, {
      value: ["red", "blue"],
    });

    first.resolve({});
    await Promise.all(writes);

    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(VALUE_PATH, { value: ["blue"] });
  });

  it("puts back the last confirmed write when a later one is refused", async () => {
    const second = deferred();
    put.mockResolvedValueOnce({}).mockReturnValueOnce(second.promise);
    const { result } = renderWrite();
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let writes: Promise<unknown>[] = [];
    act(() => {
      writes = [
        result.current.write(MULTI, ["red", "blue"], LOOKUPS),
        result.current.write(MULTI, ["blue"], LOOKUPS),
      ];
    });
    await writes[0];
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(shownOptions(result)).toEqual(["blue"]));
    second.reject(new Error("400"));

    await expect(writes[1]).rejects.toThrow("400");
    await waitFor(() => expect(shownOptions(result)).toEqual(["red", "blue"]));
  });

  it("reads the values again only once no write is queued", async () => {
    let server = STORED;
    const first = deferred();
    const second = deferred();
    put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, readValues } = renderWrite(() => Promise.resolve(server));
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let writes: Promise<unknown>[] = [];
    act(() => {
      writes = [
        result.current.write(MULTI, ["red", "blue"], LOOKUPS),
        result.current.write(MULTI, ["red", "blue", "green"], LOOKUPS),
      ];
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    server = [makeValue(MULTI, { multiEnumValues: [RED, BLUE] })];
    first.resolve({});
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));

    // A read here would answer without the queued green and replace it.
    expect(readValues).toHaveBeenCalledTimes(1);
    expect(shownOptions(result)).toEqual(["red", "blue", "green"]);

    server = [makeValue(MULTI, { multiEnumValues: [RED, BLUE, GREEN] })];
    second.resolve({});
    await Promise.all(writes);

    await waitFor(() => expect(readValues).toHaveBeenCalledTimes(2));
    expect(shownOptions(result)).toEqual(["red", "blue", "green"]);
  });

  it("does not read the values again when a typed save settles while a menu write is queued", async () => {
    const menuWrite = deferred();
    put.mockImplementation((path: string) =>
      path === VALUE_PATH ? menuWrite.promise : Promise.resolve({})
    );
    const { result, readValues } = renderWrite(() => Promise.resolve(STORED));
    await waitFor(() => expect(shownOptions(result)).toEqual(["red"]));

    let write: Promise<unknown> = Promise.resolve();
    act(() => {
      write = result.current.write(MULTI, ["red", "blue"], LOOKUPS);
    });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(VALUE_PATH, { value: ["red", "blue"] })
    );
    await act(() =>
      result.current.typed.mutateAsync({ fieldId: TEXT.id, value: "high" })
    );

    // A read here would answer without the queued blue and replace it.
    expect(readValues).toHaveBeenCalledTimes(1);
    expect(shownOptions(result)).toEqual(["red", "blue"]);

    menuWrite.resolve({});
    await write;

    await waitFor(() => expect(readValues).toHaveBeenCalledTimes(2));
  });

  it("PUTs each queued write to the entity it was made on after the hook moves to another", async () => {
    const first = deferred();
    put.mockReturnValueOnce(first.promise).mockResolvedValueOnce({});
    const { result, rerender } = renderHook(
      ({ entityId }: { entityId: string }) =>
        useEntityCustomFieldValueWrite(CustomFieldEntityType.Session, entityId),
      {
        initialProps: { entityId: ENTITY_ID },
        wrapper: createWrapperWithClient(createTestQueryClient()),
      }
    );

    let writes: Promise<unknown>[] = [];
    act(() => {
      writes = [
        result.current(MULTI, ["red"], LOOKUPS),
        result.current(MULTI, ["blue"], LOOKUPS),
      ];
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    rerender({ entityId: "other-session" });
    first.resolve({});
    await Promise.all(writes);

    expect(put.mock.calls.map(([path]) => path)).toEqual([
      VALUE_PATH,
      VALUE_PATH,
    ]);
  });
});
