import { Skeleton } from "@repo/design-system/components/ui/skeleton";

/**
 * TicketCardSkeleton - Loading placeholder matching the editorial TicketCard style
 */
export function TicketCardSkeleton() {
  return (
    <article className="card-editorial flex h-full flex-col rounded-xl">
      {/* Header section */}
      <div className="p-5 pb-0 sm:p-6">
        {/* Ticket ID skeleton */}
        <div className="mb-3">
          <Skeleton className="h-3 w-14" />
        </div>

        {/* Title skeleton */}
        <div className="mb-3 min-h-[3.5rem] space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>

        {/* Description skeleton */}
        <div className="min-h-[2.5rem] space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>

      {/* Content section */}
      <div className="flex flex-1 flex-col p-5 pt-4 sm:p-6">
        {/* Status Badge skeleton */}
        <div className="mb-auto">
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>

        {/* Button skeleton */}
        <div className="mt-6">
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      </div>
    </article>
  );
}
