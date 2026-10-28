import { screen, within } from "@testing-library/react";

export const ROWS_LIST_NAME = "Session spans, outermost first";
export const EMPTY_WINDOW = /No spans fall inside this window\./;
export const ACTIVITY_HEADING = "What it did";
export const FINDINGS_HEADING = "Findings";

/** The `<section>` a preview-trace heading titles, so its rows can be read in scope. */
export function previewTraceSection(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (section === null) {
    throw new Error(`Heading "${title}" is not inside a section`);
  }
  return section;
}

/** The value a `PreviewTraceDetailRow` prints beside `label`, read inside `scope`. */
export function previewTraceDetailValue(
  scope: HTMLElement,
  label: string
): string {
  const labelNode = within(scope).getByText(label, { exact: true });
  return labelNode.nextElementSibling?.textContent ?? "";
}
