import type { ReactNode } from "react";

/**
 * Flatten a react-markdown heading's children to plain text, so a heading id can
 * be slugged from what the reader actually shows.
 *
 * The FLATTENING is generic and lives here; the SLUG is not, and stays in
 * `apps/desktop` beside the parity test that pins it to the bundle generator.
 */
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
