import { z } from "zod";

const LABEL_SOURCE = z.array(z.string()).max(64);
const WHITESPACE = /\s+/g;

export function hasLabelSource(
  element: Element,
  channel: string,
  value: string
): boolean {
  const source = element.getAttribute(`data-analytics-${channel}-source`);
  if (!source) {
    return false;
  }
  try {
    const parsed = LABEL_SOURCE.safeParse(JSON.parse(source));
    return parsed.success && parsed.data.includes(value);
  } catch {
    return false;
  }
}

export function hasReferencedLabelSource(
  control: Element,
  attribute: string,
  value: string
): boolean {
  const ids =
    control.getAttribute(attribute)?.split(WHITESPACE).filter(Boolean) ?? [];
  if (!ids.length) {
    return false;
  }
  const labels: string[] = [];
  for (const id of ids) {
    const element = control.ownerDocument.getElementById(id);
    if (!element) {
      return false;
    }
    const text = normalizeLabel(element.textContent);
    const owners = [
      element,
      ...element.querySelectorAll("[data-analytics-text-source]"),
    ];
    if (
      !owners.some(
        (owner) =>
          normalizeLabel(owner.textContent) === text &&
          hasLabelSource(owner, "text", text)
      )
    ) {
      return false;
    }
    labels.push(text);
  }
  return normalizeLabel(labels.join(" ")) === value;
}

export function normalizeLabel(value: string | null | undefined): string {
  return value?.replace(WHITESPACE, " ").trim() ?? "";
}
