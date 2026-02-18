import { Children, isValidElement, type ReactNode } from "react";

/** Recursively extract text content from React children (safe alternative to String(children)) */
export function getTextContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getTextContent).join("");
  }
  if (isValidElement(node)) {
    return getTextContent(
      Children.toArray((node.props as { children?: ReactNode }).children)
    );
  }
  return "";
}
