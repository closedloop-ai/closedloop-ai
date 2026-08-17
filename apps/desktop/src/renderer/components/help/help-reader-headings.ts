/**
 * Heading id-stamping helpers for the Help reader (FEA-3844 / PRD-555 M2).
 *
 * `react-markdown` does not add `id`s to rendered headings, so the reader stamps
 * them itself — a search hit's `headingSlug` deep-links to `#<slug>`, and the
 * slug must match the bundle generator's. Extracted from the reader so the id
 * contract is unit-testable without a full DOM render.
 */
import type { ReactNode } from "react";
import { slugifyHeading } from "./help-slug";

/** Flatten a react-markdown heading's children to its plain-text content. */
export function getTextContent(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => getTextContent(child)).join("");
  }
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    children.props &&
    typeof children.props === "object" &&
    "children" in children.props
  ) {
    return getTextContent((children.props as { children: ReactNode }).children);
  }
  return "";
}

/** Props (`id`) to spread onto a rendered heading, slugged from its text. */
export function slugHeadingProps(children: ReactNode): { id: string } {
  return { id: slugifyHeading(getTextContent(children)) };
}
