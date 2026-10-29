/**
 * ISS-7210 — the "Number format" radios are hand-listed, so Duration is not
 * offered until this flag turns it on (ISS-4779 closed-by-default UI policy).
 * Pins: off, the four pre-existing formats are untouched and Duration is
 * absent; on, Duration is offered alongside them, and selecting it swaps the
 * "Decimal precision" select for a plain-language helper line instead of
 * leaving a precision control the server ignores for durations.
 */
import { NumberFormat } from "@repo/api/src/types/custom-field";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { NumberFormatConfig } from "../number-format-config";

const NONE_RE = /^None$/;
const CURRENCY_RE = /^Currency$/;
const PERCENTAGE_RE = /^Percentage$/;
const CUSTOM_RE = /^Custom$/;
const DURATION_RE = /^Duration$/;
const DECIMAL_PRECISION_RE = /Decimal precision/i;
const BARE_NUMBER_SECONDS_RE = /bare number is read as seconds/i;

type FormValues = {
  numberFormat: string;
  precision: number;
  currencyCode: string;
  customLabel: string;
  customLabelPosition: string;
};

function ConfigHarness() {
  const form = useForm<FormValues>({
    defaultValues: {
      numberFormat: NumberFormat.None,
      precision: 0,
      currencyCode: "",
      customLabel: "",
      customLabelPosition: "PREFIX",
    },
  });
  return <NumberFormatConfig control={form.control} />;
}

function renderConfig(enabledFlags: readonly string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ConfigHarness />
    </FeatureFlagAdapterProvider>
  );
}

describe("NumberFormatConfig — Duration format is gated", () => {
  it("offers the four existing formats and not Duration with the flag off", () => {
    renderConfig([]);

    expect(screen.getByRole("radio", { name: NONE_RE })).toBeTruthy();
    expect(screen.getByRole("radio", { name: CURRENCY_RE })).toBeTruthy();
    expect(screen.getByRole("radio", { name: PERCENTAGE_RE })).toBeTruthy();
    expect(screen.getByRole("radio", { name: CUSTOM_RE })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: DURATION_RE })).toBeNull();
  });

  it("offers Duration with the flag on", () => {
    renderConfig([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]);

    expect(screen.getByRole("radio", { name: DURATION_RE })).toBeTruthy();
    expect(screen.getByRole("radio", { name: NONE_RE })).toBeTruthy();
  });

  it("stays closed when no flag provider is mounted at all", () => {
    render(<ConfigHarness />);

    expect(screen.queryByRole("radio", { name: DURATION_RE })).toBeNull();
  });

  it("hides decimal precision and shows the span helper once Duration is selected", () => {
    renderConfig([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]);

    expect(
      screen.getByRole("combobox", { name: DECIMAL_PRECISION_RE })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: DURATION_RE }));

    expect(
      screen.queryByRole("combobox", { name: DECIMAL_PRECISION_RE })
    ).toBeNull();
    expect(screen.getByText(BARE_NUMBER_SECONDS_RE)).toBeTruthy();
  });
});
