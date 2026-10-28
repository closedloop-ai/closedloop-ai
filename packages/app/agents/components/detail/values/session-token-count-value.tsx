"use client";

import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";

/**
 * PLN-2169 M2: ONE token counter, label-free. The Properties Tokens row mounts
 * four of these; the Details tab (M3) mounts one per row.
 *
 * Whether the session recorded any usage is decided ONCE by the caller, on the
 * summed quadruple (`hasRecordedTokenUsage`, ISS-5637), and passed in: a
 * per-counter zero inside a session that consumed real tokens is a MEASURED
 * zero and renders `0`, while every counter of a session with no token-usage
 * rows renders the empty affordance. Deciding it per counter here would make
 * every zero read as unknown, swapping one lie for the opposite one.
 *
 * A `null`/absent counter is the ISS-5565 per-counter degradation: a
 * version-skewed producer that omitted one counter dashes that counter alone.
 * The dash is the SAME `GridEmptyValue` the rest of the panel and the Sessions
 * list use, not a second em-dash literal that could drift from it, and it
 * carries no `title`: the row names its missing counters once, in a sentence.
 */
export function SessionTokenCountValue({
  usageRecorded,
  value,
}: Readonly<{
  usageRecorded: boolean;
  value: number | null | undefined;
}>) {
  if (!usageRecorded || value == null) {
    return <GridEmptyValue />;
  }
  return value.toLocaleString();
}
