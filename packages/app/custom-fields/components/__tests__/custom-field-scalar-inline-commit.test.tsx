import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  makeField,
  makeValue,
} from "../../lib/__tests__/custom-field-details-fixtures";
import {
  DateFieldEditor,
  DurationFieldEditor,
  NumberFieldEditor,
  TextFieldEditor,
} from "../custom-field-scalar-value-editors";

/**
 * ISS-12302 / PLN-2173 M2: `inlineCommit` gives the Issue page's typed editors
 * the Details tab's save behavior; without it they behave as before.
 */

const mutate = vi.fn();
const mutateAsync = vi.fn<(variables: unknown) => Promise<unknown>>();
let pendingWrites: ReturnType<typeof deferred>[] = [];

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({ mutate, mutateAsync }),
}));

vi.mock("@repo/design-system/components/ui/date-picker-popover", () => ({
  DatePickerPopover: ({
    onSelect,
    value,
  }: {
    onSelect: (date: Date | null) => void;
    value: Date | null;
  }) => (
    <>
      <button
        data-testid="date-picker"
        data-value={value?.toISOString() ?? ""}
        onClick={() => onSelect(new Date("2026-03-15T00:00:00.000Z"))}
        type="button"
      >
        pick
      </button>
      <button onClick={() => onSelect(null)} type="button">
        clear
      </button>
    </>
  ),
}));

const ENTITY = {
  entityId: "session-1",
  entityType: CustomFieldEntityType.Session,
} as const;

const TEXT = makeField("text", CustomFieldType.Text);
const NUMBER = makeField("number", CustomFieldType.Number);
const DURATION = makeField("duration", CustomFieldType.Number);
const DATE = makeField("date", CustomFieldType.Date);

type TypedCase = {
  invalid?: string;
  name: string;
  render: (inlineCommit?: boolean) => void;
  restored?: string;
  saved: string;
  typed: string;
  written: unknown;
};

const TYPED_CASES: TypedCase[] = [
  {
    name: "TextFieldEditor",
    render: (inlineCommit) =>
      render(
        <TextFieldEditor
          {...ENTITY}
          fieldId={TEXT.id}
          fieldName="Risk"
          inlineCommit={inlineCommit}
          value={makeValue(TEXT, { textValue: "low" })}
        />
      ),
    saved: "low",
    typed: "high",
    written: "high",
  },
  {
    invalid: "12abc",
    name: "NumberFieldEditor",
    render: (inlineCommit) =>
      render(
        <NumberFieldEditor
          {...ENTITY}
          customLabel={null}
          customLabelPosition={null}
          fieldId={NUMBER.id}
          fieldName="Risk"
          inlineCommit={inlineCommit}
          numberFormat={null}
          precision={null}
          value={makeValue(NUMBER, { numberValue: 5 })}
        />
      ),
    restored: "5.00",
    saved: "5",
    typed: "7",
    written: 7,
  },
  {
    invalid: "junk",
    name: "DurationFieldEditor",
    render: (inlineCommit) =>
      render(
        <DurationFieldEditor
          {...ENTITY}
          fieldId={DURATION.id}
          fieldName="Risk"
          inlineCommit={inlineCommit}
          value={makeValue(DURATION, { numberValue: 3_600_000 })}
        />
      ),
    saved: "1h",
    typed: "2h",
    written: 7_200_000,
  },
];

const VALIDATION_CASES = TYPED_CASES.filter(
  (typedCase): typedCase is TypedCase & { invalid: string } =>
    typedCase.invalid !== undefined
);

function input() {
  return screen.getByRole("textbox", { name: "Risk" });
}

/** A real focus, so the editors' own `blur()` reaches `onBlur` in jsdom. */
function focusInput() {
  act(() => input().focus());
}

function typeInto(text: string) {
  focusInput();
  fireEvent.change(input(), { target: { value: text } });
}

async function settleLastWrite(outcome: "confirm" | "refuse") {
  const write = pendingWrites.at(-1);
  if (!write) {
    throw new Error("no write is in flight");
  }
  await act(async () => {
    if (outcome === "confirm") {
      write.resolve({});
    } else {
      write.reject(new Error("400"));
    }
    await write.promise.catch(() => undefined);
  });
}

beforeEach(() => {
  mutate.mockReset();
  mutateAsync.mockReset();
  pendingWrites = [];
  mutateAsync.mockImplementation(() => {
    const write = deferred();
    pendingWrites.push(write);
    return write.promise;
  });
});

describe.each(TYPED_CASES)("$name with inlineCommit", (typedCase) => {
  it("saves on blur", () => {
    typedCase.render(true);
    typeInto(typedCase.typed);
    fireEvent.blur(input());

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.lastCall?.[0]).toEqual({
      fieldId: expect.any(String),
      value: typedCase.written,
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("saves on Enter exactly as blur does, once", () => {
    typedCase.render(true);
    typeInto(typedCase.typed);
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(input()).not.toHaveFocus();

    fireEvent.blur(input());

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.lastCall?.[0]).toMatchObject({
      value: typedCase.written,
    });
  });

  it("restores the last saved value on Escape, and the blur after writes nothing", () => {
    typedCase.render(true);
    typeInto(typedCase.typed);
    fireEvent.keyDown(input(), { key: "Escape" });

    expect(input()).not.toHaveFocus();

    focusInput();

    expect(mutate).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(input()).toHaveValue(typedCase.saved);
  });

  it("writes nothing on a blur with no typing", () => {
    typedCase.render(true);
    focusInput();
    act(() => input().blur());

    expect(mutate).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("puts the last saved value back when the write is refused", async () => {
    typedCase.render(true);
    typeInto(typedCase.typed);
    act(() => input().blur());
    await settleLastWrite("refuse");
    focusInput();

    expect(input()).toHaveValue(typedCase.saved);
  });

  it("puts back the last confirmed save, not the first value, when a later write is refused", async () => {
    typedCase.render(true);
    typeInto(typedCase.typed);
    act(() => input().blur());
    await settleLastWrite("confirm");
    // Not `saved`: the NUMBER and DURATION editors show the read's value again
    // on blur, so retyping it is no change and writes nothing.
    typeInto("");
    act(() => input().blur());

    expect(mutateAsync).toHaveBeenCalledTimes(2);

    await settleLastWrite("refuse");
    focusInput();

    expect(input()).toHaveValue(typedCase.typed);
  });

  it("sends null when the field is emptied", () => {
    typedCase.render(true);
    typeInto("");
    fireEvent.blur(input());

    expect(mutateAsync.mock.lastCall?.[0]).toMatchObject({ value: null });
  });
});

describe.each(TYPED_CASES)("$name without inlineCommit", (typedCase) => {
  it("keeps writing on an untouched blur, with no settle callbacks", () => {
    typedCase.render();
    focusInput();
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(mutate).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();

    act(() => input().blur());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.lastCall).toHaveLength(1);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe.each(VALIDATION_CASES)(
  "$name validation without inlineCommit",
  (typedCase) => {
    it("lets Escape leave an invalid field without writing", () => {
      typedCase.render();
      typeInto(typedCase.invalid);
      act(() => input().blur());
      expect(screen.getByRole("alert")).toBeVisible();
      act(() => input().focus());

      fireEvent.keyDown(input(), { key: "Escape" });

      expect(input()).not.toHaveFocus();
      expect(input()).toHaveValue(typedCase.restored ?? typedCase.saved);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
      expect(mutateAsync).not.toHaveBeenCalled();
    });
  }
);

describe("DateFieldEditor with inlineCommit", () => {
  const saved = "2026-01-02T00:00:00.000Z";
  const renderDate = () =>
    render(
      <DateFieldEditor
        {...ENTITY}
        fieldId={DATE.id}
        initialValue={new Date(saved)}
        inlineCommit
      />
    );

  it("saves the picked date, and puts the saved one back when refused", async () => {
    renderDate();
    fireEvent.click(screen.getByTestId("date-picker"));

    expect(mutateAsync.mock.lastCall?.[0]).toEqual({
      fieldId: DATE.id,
      value: "2026-03-15T00:00:00.000Z",
    });
    expect(screen.getByTestId("date-picker")).toHaveAttribute(
      "data-value",
      "2026-03-15T00:00:00.000Z"
    );

    await settleLastWrite("refuse");

    expect(screen.getByTestId("date-picker")).toHaveAttribute(
      "data-value",
      saved
    );
  });

  it("clears with null", () => {
    renderDate();
    fireEvent.click(screen.getByRole("button", { name: "clear" }));

    expect(mutateAsync.mock.lastCall?.[0]).toEqual({
      fieldId: DATE.id,
      value: null,
    });
  });
});
