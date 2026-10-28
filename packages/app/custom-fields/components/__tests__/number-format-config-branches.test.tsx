/**
 * Branch coverage for NumberFormatConfig (ISS-10515): reading the control from
 * form context when no `control` prop is passed, and the fallbacks each
 * sub-control shows when the form holds no value for it.
 */

import { LabelPosition, NumberFormat } from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { NumberFormatConfig } from "../number-format-config";

const CURRENCY_RE = /^Currency$/;
const CUSTOM_RE = /^Custom$/;
const CURRENCY_CODE_RE = /Currency code/i;
const CUSTOM_LABEL_RE = /Custom label/i;
const LABEL_POSITION_RE = /Label position/i;
const DECIMAL_PRECISION_RE = /Decimal precision/i;
const BARE_NUMBER_SECONDS_RE = /bare number is read as seconds/i;

type SparseValues = {
  numberFormat?: string;
  precision?: number;
  currencyCode?: string;
  customLabel?: string;
  customLabelPosition?: string;
};

/** Mounts the config inside a FormProvider and passes no `control` prop. */
function ContextHarness({ defaults }: Readonly<{ defaults: SparseValues }>) {
  const form = useForm<SparseValues>({ defaultValues: defaults });
  return (
    <FormProvider {...form}>
      <NumberFormatConfig<SparseValues> />
      <output data-testid="form-values">{JSON.stringify(form.watch())}</output>
    </FormProvider>
  );
}

function formValues(): SparseValues {
  return JSON.parse(screen.getByTestId("form-values").textContent ?? "{}");
}

describe("NumberFormatConfig without a control prop", () => {
  it("binds to the surrounding form context", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.None }} />);

    fireEvent.click(screen.getByRole("radio", { name: CURRENCY_RE }));

    expect(formValues().numberFormat).toBe(NumberFormat.Currency);
    expect(screen.getByLabelText(CURRENCY_CODE_RE)).toBeTruthy();
  });

  it("falls back to precision 0 when the form holds no precision", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.None }} />);

    fireEvent.click(
      screen.getByRole("combobox", { name: DECIMAL_PRECISION_RE })
    );

    expect(screen.getByRole("option", { name: "0" })).toHaveAttribute(
      "data-state",
      "checked"
    );
  });

  it("shows an empty currency code that the user can fill when none is stored", () => {
    render(
      <ContextHarness defaults={{ numberFormat: NumberFormat.Currency }} />
    );
    const input = screen.getByLabelText(CURRENCY_CODE_RE);
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "GBP" } });

    expect(formValues().currencyCode).toBe("GBP");
  });

  it("falls back to an empty label and a Prefix position for a custom format", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.Custom }} />);
    const input = screen.getByLabelText(CUSTOM_LABEL_RE);
    expect(input).toHaveValue("");
    expect(
      screen.getByRole("combobox", { name: LABEL_POSITION_RE })
    ).toHaveTextContent("Prefix");

    fireEvent.change(input, { target: { value: "pts" } });
    fireEvent.click(screen.getByRole("combobox", { name: LABEL_POSITION_RE }));
    fireEvent.click(screen.getByRole("option", { name: "Suffix" }));

    expect(formValues()).toMatchObject({
      customLabel: "pts",
      customLabelPosition: LabelPosition.Suffix,
    });
  });

  it("stores a picked precision as a number", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.None }} />);

    fireEvent.click(
      screen.getByRole("combobox", { name: DECIMAL_PRECISION_RE })
    );
    fireEvent.click(screen.getByRole("option", { name: "3" }));

    expect(formValues().precision).toBe(3);
  });

  it("keeps the duration helper line off any other format", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.None }} />);

    expect(screen.queryByText(BARE_NUMBER_SECONDS_RE)).toBeNull();
    expect(
      screen.getByRole("combobox", { name: DECIMAL_PRECISION_RE })
    ).toBeTruthy();
  });

  it("hides currency and label inputs for formats that do not use them", () => {
    render(<ContextHarness defaults={{ numberFormat: NumberFormat.Custom }} />);
    expect(screen.queryByLabelText(CURRENCY_CODE_RE)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: CURRENCY_RE }));
    expect(screen.queryByLabelText(CUSTOM_LABEL_RE)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: CUSTOM_RE }));
    expect(screen.getByLabelText(CUSTOM_LABEL_RE)).toBeTruthy();
  });
});
