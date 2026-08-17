"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { BlocksIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { PacksContext } from "../lib/packs-context";
import { PacksLoadFailed } from "./packs-load-failed";

// FEA-4087 Slice 1: the top-level Packs page spine. One route, one job, but the
// job flexes by who's looking. An admin-capable context renders the manage-first
// admin treatment; everyone else renders the member by-source treatment. Both
// surfaces (web App-Router page + desktop nav view) mount this same component
// seeded from `PacksContext`, so the split stays in lockstep and is
// capability-driven, never a page-level `isAdmin` boolean.
//
// The admin/member bodies arrive as slots. Slice 1 wires the existing functional
// dashboards through them; the sibling slices (FEA-4088 admin manage-first,
// FEA-4089 member by-source) replace each slot with the realized treatment
// without touching this spine.

// The centered content column the spine's own whole-page states (skeleton,
// error, empty) share, so those states read the same across admin/member and
// web/desktop. The populated treatment owns its own container width (the
// realized AdminView/MemberView (FEA-4088/4089) size themselves), so the spine
// renders the active slot directly rather than boxing it into this column.
const CONTENT_COLUMN_CLASS = "mx-auto flex w-full max-w-5xl flex-col p-6";

type PacksPageProps = {
  readonly context: PacksContext;
  /** Manage-first treatment, rendered when the context can manage distribution. */
  readonly adminView: ReactNode;
  /** By-source treatment, rendered for everyone else. */
  readonly memberView: ReactNode;
  /**
   * Page-level status. A region owning its own load/error is the norm (each
   * treatment does that internally); these cover the whole-page states the
   * spine is responsible for: a first paint before anything is known, a
   * page-wide fetch failure, and an org with nothing distributed and nothing
   * available.
   */
  readonly isLoading?: boolean;
  readonly isError?: boolean;
  readonly isEmpty?: boolean;
  /**
   * The failure behind `isError`, when the surface has one. Threaded straight
   * into {@link PacksLoadFailed} so a client-side deadline reads as "we stopped
   * waiting" rather than blaming the user's connection for a timeout we set
   * (ISS-5013). Omit it and the spine can only ever render the generic
   * failed-read treatment.
   */
  readonly error?: unknown;
  readonly onRetry?: () => void;
};

const PageSkeleton = () => (
  <div className={CONTENT_COLUMN_CLASS} data-testid="packs-page-skeleton">
    <div className="flex flex-col gap-10">
      {[0, 1].map((region) => (
        <div className="flex flex-col gap-4" key={region}>
          <Skeleton className="h-8 w-48" />
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((row) => (
              <Skeleton className="h-11 w-full" key={row} />
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const PacksPage = ({
  context,
  adminView,
  memberView,
  isLoading = false,
  isError = false,
  isEmpty = false,
  error,
  onRetry,
}: PacksPageProps) => {
  if (isLoading) {
    return <PageSkeleton />;
  }

  if (isError) {
    return (
      <div className={CONTENT_COLUMN_CLASS}>
        <PacksLoadFailed error={error} onRetry={onRetry} />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className={CONTENT_COLUMN_CLASS}>
        <EmptyState
          description="Nothing has been distributed to your org yet, and there's nothing in the catalog to install."
          icon={BlocksIcon}
          title="No packs yet"
        />
      </div>
    );
  }

  return (
    <>{context.capabilities.manageDistribution ? adminView : memberView}</>
  );
};
