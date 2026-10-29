import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  ENTITY_ID,
  makeField,
  makeValue,
} from "../../lib/__tests__/custom-field-details-fixtures";
import { TextFieldEditor } from "../custom-field-scalar-value-editors";

/**
 * ISS-12302: `inlineCommit` with two saves of one field in flight, through the
 * real `useUpdateCustomFieldValue`, whose per-call `mutate` callbacks fire only
 * for the latest call.
 */

const put = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ put }),
}));

const TEXT = makeField("text", CustomFieldType.Text);

function input() {
  return screen.getByRole("textbox", { name: "Risk" });
}

function typeAndBlur(text: string) {
  act(() => input().focus());
  fireEvent.change(input(), { target: { value: text } });
  act(() => input().blur());
}

beforeEach(() => {
  put.mockReset();
});

describe("TextFieldEditor with inlineCommit, two saves in flight", () => {
  it("puts back the first save, not the original value, when the second is refused after the first confirms", async () => {
    const first = deferred();
    const second = deferred();
    put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <TextFieldEditor
        entityId={ENTITY_ID}
        entityType={CustomFieldEntityType.Session}
        fieldId={TEXT.id}
        fieldName="Risk"
        inlineCommit
        value={makeValue(TEXT, { textValue: "low" })}
      />,
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    typeAndBlur("high");
    typeAndBlur("higher");
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve({});
      await first.promise;
    });
    await act(async () => {
      second.reject(new Error("400"));
      await second.promise.catch(() => undefined);
    });

    await waitFor(() => expect(input()).toHaveValue("high"));
  });
});
