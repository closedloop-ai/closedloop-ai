import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import type { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { PageHeading } from "@repo/app/shared/components/page-heading";
import { Link } from "@repo/navigation/link";
import { ArrowLeftIcon, GitBranchIcon } from "lucide-react";
import { DESKTOP_LOCAL_READ_REASON_COPY } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopLocalReadReason } from "../../shared-agent-sessions/desktop-app-core-provider";

/**
 * A canonical UUID, any version — the shape of a cloud Branch artifact id
 * (`Artifact.id` is `@default(uuid(7)) @db.Uuid`). Anchored + case-insensitive.
 */
const CLOUD_ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route's page heading for every branch state that is not a loaded branch,
 * matching the shared `BranchDetailLoading` / `BranchDetailNotFound` states —
 * the loaded detail owns the page's `<h1>`, and it sits below this early return.
 */
const BRANCH_PAGE_HEADING = "Branch";

/**
 * Does `id` name a branch in the CLOUD workspace rather than one this device's
 * SQLite store can address?
 *
 * The two sources mint different ids (see `useDesktopBranchesConsumption`): the
 * local source addresses branches by an `encodeBranchId` composite, which always
 * carries the `::` delimiter — the `"local"` sentinel stands in for a null repo,
 * so even a repo-less branch keeps it. A cloud id is a bare Artifact UUID, which
 * can never contain that delimiter, so the two vocabularies are disjoint by
 * construction and this shape check cannot mistake one for the other.
 *
 * Deliberately POSITIVE rather than "does not round-trip through
 * `decodeBranchId`". `decodeBranchId` accepts a delimiter-less id as a legacy
 * repo-less branch NAME, so the local source will happily look one up and
 * legitimately find nothing — that is a genuinely missing local branch, and
 * calling it a workspace branch would state a residency we have no evidence for.
 * Only an artifact id is evidence that the branch lives in the workspace.
 */
export function isCloudBranchArtifactId(id: string): boolean {
  return CLOUD_ARTIFACT_ID_PATTERN.test(id);
}

/**
 * ISS-6972 follow-up: what a cloud branch detail shows once the read source has
 * moved to this device (offline, signed out, or sync off).
 *
 * The open id was minted by the cloud projection, so the local source cannot
 * address it and answers 404 — which the shared page renders as "Branch not
 * found", telling the user a branch they were reading a second earlier does not
 * exist. Nothing about which source is read changes here (offline IS local);
 * only what the user is told. The reason sentence is the same one the
 * read-source badge gives, so one app never offers two explanations for one
 * situation.
 */
export function BranchDetailWorkspaceOnlyState({
  backHref,
  backLabel,
}: {
  backHref: string;
  backLabel: BranchBackLabel;
}) {
  const localReadReason = useDesktopLocalReadReason();
  const reason = localReadReason
    ? `${DESKTOP_LOCAL_READ_REASON_COPY[localReadReason]} `
    : "";
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <PageHeading>{BRANCH_PAGE_HEADING}</PageHeading>
      <div className="w-full">
        <EmptyState
          className="py-16"
          description={`${reason}Showing the data stored on this device, which doesn't include this branch.`}
          icon={GitBranchIcon}
          title="This branch is in your workspace"
        />
        <div className="mt-4 flex justify-center">
          <Link className="sd3-back" href={backHref}>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Back to {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
