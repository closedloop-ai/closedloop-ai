import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import {
  DATE_RANGE_LABELS,
  DATE_RANGE_SHORT_LABELS,
  DATE_RANGES,
} from "./format-utils";

/**
 * ISS-9225 — the time-window presets every Grid Table v2 list toolbar offers.
 *
 * Built from the shared `DATE_RANGES` vocabulary so Sessions and Branches cannot
 * offer different windows, or the same window under different words, for what is
 * one concept to the reader.
 */
export const TABLE_DATE_RANGE_OPTIONS: readonly TableDateRangeOption[] =
  DATE_RANGES.map((value) => ({
    value,
    label: DATE_RANGE_LABELS[value],
    shortLabel: DATE_RANGE_SHORT_LABELS[value],
  }));
