/**
 * @file severity-badge.tsx
 * @description FEA-3848 (PRD-556 M2) — the canonical severity→Badge-variant map
 * for audit findings, so the list group header, the row, and the detail drawer
 * all style a given severity identically (no drift).
 */
import type { BadgeProps } from "@closedloop-ai/design-system/components/ui/badge";
import { AuditSeverity } from "./audit-finding-model";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** The Badge variant for a given severity. Exhaustive over {@link AuditSeverity}. */
export function severityBadgeVariant(severity: AuditSeverity): BadgeVariant {
  switch (severity) {
    case AuditSeverity.Blocking:
      return "destructive";
    case AuditSeverity.High:
      return "error";
    case AuditSeverity.Medium:
      return "warning";
    case AuditSeverity.Low:
      return "info";
    case AuditSeverity.Unclassified:
      return "muted";
    default:
      return assertNever(severity);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled audit severity: ${String(value)}`);
}
