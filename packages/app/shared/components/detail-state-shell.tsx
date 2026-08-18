"use client";

import { ApiError } from "@repo/app/shared/api/api-error";
import { PageHeading } from "@repo/app/shared/components/page-heading";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import type { LucideIcon } from "lucide-react";
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared loading / not-found / provider-error building blocks for the entity
 * detail views in `@repo/app` (agent-component, session, branch). Extracted so
 * the three detail slices compose one honest state model instead of pasting the
 * same shell, skeleton, back link, and 404-vs-transient classifier a third time
 * (FEA-3987 review).
 *
 * The state model is deliberately three-way and honest:
 * - LOADING — a still-pending first read, rendered as an accessible skeleton.
 * - NOT-FOUND — a settled 404: the entity genuinely doesn't exist.
 * - PROVIDER-ERROR — a settled non-404 (gateway down, worker died, 5xx): the
 *   entity may still exist, so we must never report it as missing.
 */

export const DetailErrorKind = {
  NotPresent: "not-present",
  ProviderError: "provider-error",
} as const;
export type DetailErrorKind =
  (typeof DetailErrorKind)[keyof typeof DetailErrorKind];

/**
 * Classify a detail read failure. A 404 (the missing, deleted, or never-synced
 * id both the HTTP and desktop local-DB sources reject with) is NotPresent, a
 * genuine "not found". Anything else is a transient ProviderError we must not
 * report as a missing entity. A missing/undefined error defaults to NotPresent
 * so an empty settled read still resolves to the not-found copy.
 */
export function classifyDetailError(error: unknown): DetailErrorKind {
  if (error instanceof ApiError && error.isNotFound()) {
    return DetailErrorKind.NotPresent;
  }
  if (error === undefined || error === null) {
    return DetailErrorKind.NotPresent;
  }
  return DetailErrorKind.ProviderError;
}

/**
 * Accessible loading skeleton for a detail body. Announced to screen readers as
 * a busy status with a visually-hidden label; the visual slab is hidden from the
 * a11y tree so it does not read as content. `className` sizes the slab to the
 * surface's real content column so the skeleton holds the shape of what's coming
 * instead of flashing a full-width block that then snaps inward.
 */
export function DetailLoadingSkeleton({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <output aria-busy="true" aria-label={label} className="contents">
      <Skeleton aria-hidden className={cn("w-full", className)} />
    </output>
  );
}

/**
 * The "Back to …" link shared by the not-found / provider-error states. `label`
 * is both the visible text and the accessible name.
 */
export function DetailBackLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link className="sd3-back" href={href}>
      <ArrowLeftIcon aria-hidden className="size-3.5" />
      {label}
    </Link>
  );
}

/**
 * The shared EmptyState body for a not-found / provider-error detail state:
 * icon + title + description + a "Back to …" link. The `title` renders through
 * the shared `EmptyState` primitive.
 */
export function DetailEmptyState({
  backHref,
  backLabel,
  title,
  description,
  icon = AlertCircleIcon,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  description: string;
  icon?: LucideIcon;
}) {
  return (
    <EmptyState
      action={<DetailBackLink href={backHref} label={backLabel} />}
      className="py-16"
      description={description}
      icon={icon}
      title={title}
    />
  );
}

/**
 * Wraps detail state content so it lands where the real body lands. Pass the
 * surface's own body wrapper classes (e.g. the centered `max-w-*` column) so the
 * skeleton and empty states share the loaded layout's inset and width.
 *
 * `heading` names the page for the states that are not a loaded entity. A
 * detail route opts out of the app shell's own page `h1` because the LOADED body owns
 * one — but that heading sits below the loading and error early-returns, so
 * without this the route ships zero headings on first load and on every failed
 * read (ISS-5008 review). Omit it only on a surface whose shell still renders
 * its own heading.
 */
export function DetailStateShell({
  className,
  heading,
  children,
}: {
  className?: string;
  heading?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {heading === undefined ? null : <PageHeading>{heading}</PageHeading>}
      {children}
    </div>
  );
}
