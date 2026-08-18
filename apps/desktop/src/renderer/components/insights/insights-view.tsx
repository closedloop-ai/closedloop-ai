import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
} from "@closedloop-ai/design-system/components/ui/card";
import { BarChart3 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { PageShell } from "../layout/page-shell";
import {
  INSIGHTS_PAGE_DESCRIPTION,
  INSIGHTS_PAGE_TITLE,
} from "./insights-view-constants";

const LazyDesktopInsightsBoundedView = lazy(() =>
  import("./desktop-insights-bounded-view").then((module) => ({
    default: module.DesktopInsightsBoundedView,
  }))
);

/** Desktop wrapper for shared local agent-session analytics. */
export function InsightsView() {
  const [insightsLoaded, setInsightsLoaded] = useState(false);

  if (!insightsLoaded) {
    return (
      <PageShell
        description={INSIGHTS_PAGE_DESCRIPTION}
        title={INSIGHTS_PAGE_TITLE}
      >
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="font-medium text-[var(--foreground)] text-base">
                Local session history
              </h2>
              <p className="max-w-2xl text-[var(--muted-foreground)] text-sm">
                Load aggregate metrics for your synced sessions when you need
                them.
              </p>
            </div>
            <Button onClick={() => setInsightsLoaded(true)} type="button">
              <BarChart3 className="mr-2 h-4 w-4" />
              Load insights
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <Suspense fallback={<InsightsLoadingState />}>
      <LazyDesktopInsightsBoundedView />
    </Suspense>
  );
}

function InsightsLoadingState() {
  return (
    <PageShell
      description={INSIGHTS_PAGE_DESCRIPTION}
      title={INSIGHTS_PAGE_TITLE}
    >
      <Card className="rounded-xl border-border/80 bg-card shadow-sm">
        <CardContent className="p-5 text-[var(--muted-foreground)] text-sm">
          Loading insights...
        </CardContent>
      </Card>
    </PageShell>
  );
}
