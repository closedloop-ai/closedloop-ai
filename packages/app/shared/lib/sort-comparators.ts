import type { DocumentStatus } from "@repo/api/src/types/document";
import { STATUS_DISPLAY_ORDER } from "./status-grouping";

const STATUS_SORT_ORDER = new Map<string, number>(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index])
);

const UNKNOWN_STATUS_ORDER = STATUS_DISPLAY_ORDER.length;

export function compareStatusValues(
  a: DocumentStatus | string | null | undefined,
  b: DocumentStatus | string | null | undefined
): number {
  if (!(a || b)) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  const aOrder = STATUS_SORT_ORDER.get(a) ?? UNKNOWN_STATUS_ORDER;
  const bOrder = STATUS_SORT_ORDER.get(b) ?? UNKNOWN_STATUS_ORDER;
  return aOrder - bOrder;
}

export function compareSlugValues(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  if (!(a || b)) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export const NAME_SORT_OPTIONS = [
  { key: "title", label: "Name" },
  { key: "status", label: "Status" },
  { key: "slug", label: "ID" },
] as const;
