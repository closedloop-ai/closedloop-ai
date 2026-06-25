import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@closedloop-ai/design-system/components/ui/tabs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsData } from "../../../shared/diagnostics-contract";
import { BackfillTab } from "./backfill-tab";
import { EnrichmentTab } from "./enrichment-tab";
import { LogsPanel } from "./LogsPanel";
import { LinksTab } from "./links-tab";
import { ReposTab } from "./repos-tab";

const AUTO_REFRESH_MS = 5000;

function DiagnosticsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[200px] w-full" />
      <Skeleton className="h-[150px] w-full" />
    </div>
  );
}

function renderTabContent(
  loading: boolean,
  data: DiagnosticsData | null,
  tab: string
): React.ReactNode {
  if (loading && !data) {
    return <DiagnosticsSkeleton />;
  }
  if (!data) {
    return null;
  }
  switch (tab) {
    case "enrichment":
      return (
        <EnrichmentTab
          enrichmentQueue={data.enrichmentQueue}
          pendingArtifacts={data.pendingArtifacts}
          stalledArtifacts={data.stalledArtifacts}
        />
      );
    case "repos":
      return <ReposTab repos={data.repos} />;
    case "backfill":
      return <BackfillTab backfill={data.backfill} />;
    case "links":
      return (
        <LinksTab linkStats={data.linkStats} linkTotals={data.linkTotals} />
      );
    default:
      return null;
  }
}

export function DiagnosticsView({
  isActive = true,
}: Readonly<{ isActive?: boolean }>) {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await window.desktopApi.db.getDiagnostics();
      setData(result);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load diagnostics"
      );
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // One load whenever the panel becomes visible, independent of auto-refresh,
  // so a paused panel still shows fresh data on (re)activation.
  useEffect(() => {
    if (!isActive) {
      return;
    }
    load().catch(() => {});
  }, [isActive, load]);

  // Poll only while the panel is visible and auto-refresh is on. A recursive
  // setTimeout (scheduled after each load settles) replaces setInterval so a
  // slow load can never overlap the next request or fire it out of order.
  useEffect(() => {
    if (!(isActive && autoRefresh)) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      timer = setTimeout(async () => {
        await load();
        if (!cancelled) {
          tick();
        }
      }, AUTO_REFRESH_MS);
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isActive, autoRefresh, load]);

  const handleRefresh = useCallback(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[var(--foreground)] text-lg">
          Diagnostics
        </h2>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setAutoRefresh((v) => !v)}
            size="sm"
            variant="outline"
          >
            {autoRefresh ? "Pause" : "Resume"}
          </Button>
          <Button
            disabled={loading}
            onClick={handleRefresh}
            size="sm"
            variant="outline"
          >
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="enrichment">
        <TabsList>
          <TabsTrigger value="enrichment">Enrichment</TabsTrigger>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="backfill">Backfill</TabsTrigger>
          <TabsTrigger value="links">Links</TabsTrigger>
          <TabsTrigger value="logs">Gateway Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="enrichment">
          {renderTabContent(loading, data, "enrichment")}
        </TabsContent>

        <TabsContent value="repos">
          {renderTabContent(loading, data, "repos")}
        </TabsContent>

        <TabsContent value="backfill">
          {renderTabContent(loading, data, "backfill")}
        </TabsContent>

        <TabsContent value="links">
          {renderTabContent(loading, data, "links")}
        </TabsContent>

        <TabsContent value="logs">
          <LogsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
