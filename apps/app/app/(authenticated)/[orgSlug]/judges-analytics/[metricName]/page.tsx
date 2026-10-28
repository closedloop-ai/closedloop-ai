"use client";

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { useJudgeDetail } from "@repo/app/judges-analytics/hooks/use-judges-analytics";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { ArrowLeftIcon } from "lucide-react";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CharacteristicsPanel } from "./components/characteristics-panel";
import { PromptSection } from "./components/prompt-section";
import { ScoreComparisonSection } from "./components/score-comparison-section";

function JudgeDetailContent() {
  const params = useRouteParams();
  const searchParams = useSearchParamsValue();
  const metricName =
    typeof params.metricName === "string" ? params.metricName : "";
  const promptName = decodeMetricNameParam(metricName);
  const reportTypeParam = searchParams.get("reportType");
  let reportType: EvaluationReportType = EvaluationReportType.Plan;
  if (reportTypeParam === EvaluationReportType.Code) {
    reportType = EvaluationReportType.Code;
  } else if (reportTypeParam === EvaluationReportType.Prd) {
    reportType = EvaluationReportType.Prd;
  }
  const { data, isLoading, isError, error } = useJudgeDetail(
    promptName,
    reportType
  );

  if (isLoading) {
    return <JudgeDetailBodySkeleton />;
  }

  if (isError || !data) {
    return (
      <Alert variant="error">
        <AlertTitle>
          {isError ? "Error loading judge detail" : "Judge not found"}
        </AlertTitle>
        <AlertDescription>
          {error?.message || "The requested judge could not be found."}
        </AlertDescription>
      </Alert>
    );
  }

  const { judge } = data;

  return (
    <>
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">
          {judge.displayName}
        </h1>
        <p className="text-muted-foreground text-sm">
          {judge.scoreCount} total scores across {judge.promptVersions.length}{" "}
          version
          {judge.promptVersions.length === 1 ? "" : "s"}
        </p>
      </div>

      <CharacteristicsPanel judge={judge} />
      <PromptSection judge={judge} />
      <ScoreComparisonSection
        key={`${reportType}-${promptName}`}
        promptName={promptName}
        reportType={reportType}
      />
    </>
  );
}

/**
 * ISS-5037: the judge-detail body's resolving state — also what the Labs
 * container gate holds while the flag is unresolved, so the two windows look
 * identical instead of the page blanking and then popping in.
 */
function JudgeDetailBodySkeleton() {
  return (
    <div
      aria-label="Loading judge detail"
      aria-live="polite"
      className="flex flex-col gap-6"
      role="status"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * ISS-5037 (ISS-4779 closed-by-default), whitlockk review on PR #4341: the judge
 * DETAIL route is a Labs destination too. It does not inherit the parent
 * route's gate — Next.js segments are gated independently — so a direct
 * `/judges-analytics/<metric>` URL was still mounting `useJudgeDetail` (and
 * firing its request) with Labs off. It carries the same container gate.
 *
 * The back link is the route's chrome and stays OUTSIDE the gate: a detail that
 * cannot render must still leave the user a way out, and keeping it out of the
 * gate means the page never opens as a blank region.
 */
export default function JudgeDetailPage() {
  const orgSlug = useOrgSlug();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <Link
        className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        href={`/${orgSlug}/judges-analytics`}
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back to Judges Analytics
      </Link>
      <FeatureFlagRouteGate
        flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}
        pending={<JudgeDetailBodySkeleton />}
      >
        <JudgeDetailContent />
      </FeatureFlagRouteGate>
    </div>
  );
}

/**
 * ISS-8534: the `[metricName]` segment, decoded so it can never throw during
 * render.
 *
 * `decodeURIComponent` raises `URIError` on a malformed escape (`%`, `%zz`, a
 * truncated `%E0%A4`), and this is a `"use client"` component, so the bare call
 * took the whole page to the error boundary — past the route's own error alert,
 * which is the correct answer for a nonsense URL. Falling back to the raw
 * segment is the same contract `normalizeAgentSlug`
 * (`packages/app/agents/lib/agent-slug-label.ts`) states for the sibling route:
 * `useJudgeDetail` then fails its lookup and the existing alert renders.
 *
 * The decode itself is kept, not dropped. This is a SINGLE decode, unlike the
 * API side, where ISS-6908 removed a second one: the web adapter returns Next's
 * client route param percent-ENCODED (`useParams()` via
 * `apps/app/lib/navigation/next-adapter.tsx`), so dropping this would change
 * what a validly-escaped name resolves to.
 *
 * Not dead code, though nothing reaches it through a document navigation today:
 * Next answers a malformed path segment with its own `400` before this renders.
 * The guard holds the COMPONENT boundary, where a route param is just a string —
 * `useRouteParams` is a port with a second (desktop) adapter that decodes
 * segments itself, and the framework's edge behaviour is not this file's to
 * assume.
 */
function decodeMetricNameParam(metricName: string): string {
  try {
    return decodeURIComponent(metricName);
  } catch {
    return metricName;
  }
}
