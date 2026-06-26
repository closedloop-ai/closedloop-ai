import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@closedloop-ai/design-system/components/ui/select";
import {
  Table as DsTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@closedloop-ai/design-system/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@closedloop-ai/design-system/components/ui/tabs";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  ArrowLeft,
  ExternalLink,
  GitFork,
  Package,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CatalogEntry,
  CatalogMutationResult,
  InstalledPack,
  InstalledPackDetail,
} from "../../../shared/agent-db-contract";
import { invalidateCache, useQueryCache } from "../../hooks/useQueryCache";
import {
  cx,
  DASHBOARD_TABLE_CLASS_NAME,
  DashboardCard,
  LoadingState,
  PageShell,
} from "../layout/page-shell";
import { CatalogCard } from "./CatalogCard";
import { InstallModal } from "./InstallModal";
import { Sparkline } from "./Sparkline";

type ViewMode = "catalog" | "detail";

type InstallState = {
  open: boolean;
  packId: string;
  harness: string;
  action: "install" | "uninstall";
  runId: number | null;
  command: string | null;
};

const EMPTY_INSTALL: InstallState = {
  open: false,
  packId: "",
  harness: "",
  action: "install",
  runId: null,
  command: null,
};

const PROJECT_RELATIVE_HINTS = ["--directory .", "--directory=.", " -C ."];

export function PacksCatalog() {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("catalog");
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installModal, setInstallModal] = useState<InstallState>(EMPTY_INSTALL);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProjectCwd, setSelectedProjectCwd] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);

  // -- Data fetching --

  const { data: catalog, loading: catalogLoading } = useQueryCache<
    CatalogEntry[]
  >("db:catalog", () => window.desktopApi.db.getCatalog(), 5000, 10_000);

  const { data: installedPacks, loading: installedLoading } = useQueryCache<
    InstalledPack[]
  >(
    "db:installed-packs",
    () => window.desktopApi.db.getInstalledPacks(),
    5000,
    10_000
  );

  const { data: packDetail } = useQueryCache<InstalledPackDetail | null>(
    `db:pack-detail:${selectedPackId}`,
    () =>
      selectedPackId
        ? window.desktopApi.db.getPackDetail(selectedPackId)
        : Promise.resolve(null),
    5000,
    10_000
  );

  const { data: recentProjects } = useQueryCache<string[]>(
    "db:recent-projects",
    () => window.desktopApi.db.getRecentProjects(),
    10_000,
    30_000
  );

  // -- Filtering --

  const lowerSearch = search.toLowerCase();

  const filteredCatalog = useMemo(() => {
    const entries = Array.isArray(catalog) ? catalog : [];
    if (!lowerSearch) {
      return entries;
    }
    return entries.filter(
      (e) =>
        catalogDisplayName(e).toLowerCase().includes(lowerSearch) ||
        e.description?.toLowerCase().includes(lowerSearch) ||
        e.category?.toLowerCase().includes(lowerSearch) ||
        catalogPackId(e).toLowerCase().includes(lowerSearch)
    );
  }, [catalog, lowerSearch]);

  const installedEntries = useMemo(
    () =>
      filteredCatalog.filter((e) => catalogInstalledHarnesses(e).length > 0),
    [filteredCatalog]
  );

  const discoverEntries = useMemo(
    () =>
      filteredCatalog.filter((e) => catalogInstalledHarnesses(e).length === 0),
    [filteredCatalog]
  );

  const installedPackRows = useMemo(
    () => (Array.isArray(installedPacks) ? installedPacks : []),
    [installedPacks]
  );
  const recentProjectRows = useMemo(
    () => (Array.isArray(recentProjects) ? recentProjects : []),
    [recentProjects]
  );

  const hasProjectScopedActions = useMemo(
    () =>
      filteredCatalog.some((entry) =>
        catalogHarnesses(entry).some(
          (harness) =>
            requiresProjectCwd(entry, harness, "install") ||
            requiresProjectCwd(entry, harness, "uninstall")
        )
      ),
    [filteredCatalog]
  );

  useEffect(() => {
    if (!selectedProjectCwd && recentProjectRows[0]) {
      setSelectedProjectCwd(recentProjectRows[0]);
    }
  }, [recentProjectRows, selectedProjectCwd]);

  // -- Actions --

  const handleInstall = useCallback(
    async (packId: string, harness: string) => {
      const key = `${packId}:${harness}`;
      setInstalling((prev) => ({ ...prev, [key]: true }));
      setInstallError(null);

      try {
        const entry = catalog?.find((e) => e.packId === packId);
        const command = entry?.installCommands?.[harness] ?? null;
        const cwd = resolveProjectCwdForAction(
          entry,
          harness,
          "install",
          selectedProjectCwd
        );
        if (cwd === "missing") {
          setInstallError(
            `Select a recent project before installing ${packId}.`
          );
          return;
        }
        const result = await window.desktopApi.db.catalogInstall(
          packId,
          harness,
          cwd ?? undefined
        );
        if (!handleCatalogMutationResult(result, setInstallError)) {
          return;
        }
        setInstallModal({
          open: true,
          packId,
          harness,
          action: "install",
          runId: result.runId ?? null,
          command,
        });
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Install failed.");
      } finally {
        setInstalling((prev) => ({ ...prev, [key]: false }));
      }
    },
    [catalog, selectedProjectCwd]
  );

  const handleUninstall = useCallback(
    async (packId: string, harness: string) => {
      const key = `${packId}:${harness}`;
      setInstalling((prev) => ({ ...prev, [key]: true }));
      setInstallError(null);

      try {
        const entry = catalog?.find((e) => e.packId === packId);
        const command = entry?.uninstallCommands?.[harness] ?? null;
        const cwd = resolveProjectCwdForAction(
          entry,
          harness,
          "uninstall",
          selectedProjectCwd
        );
        if (cwd === "missing") {
          setInstallError(
            `Select a recent project before uninstalling ${packId}.`
          );
          return;
        }
        const result = await window.desktopApi.db.catalogUninstall(
          packId,
          harness,
          cwd ?? undefined
        );
        if (!handleCatalogMutationResult(result, setInstallError)) {
          return;
        }
        setInstallModal({
          open: true,
          packId,
          harness,
          action: "uninstall",
          runId: result.runId ?? null,
          command,
        });
      } catch (err) {
        setInstallError(
          err instanceof Error ? err.message : "Uninstall failed."
        );
      } finally {
        setInstalling((prev) => ({ ...prev, [key]: false }));
      }
    },
    [catalog, selectedProjectCwd]
  );

  const handleCloseModal = useCallback(() => {
    setInstallModal(EMPTY_INSTALL);
    // Refresh catalog and installed packs after install/uninstall
    invalidateCache("db:catalog");
    invalidateCache("db:installed-packs");
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await window.desktopApi.db.catalogRefresh();
      invalidateCache("db:catalog");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleCardClick = useCallback((packId: string) => {
    setSelectedPackId(packId);
    setViewMode("detail");
  }, []);

  const handleBack = useCallback(() => {
    setViewMode("catalog");
    setSelectedPackId(null);
  }, []);

  // -- Loading state --

  if (catalogLoading && !catalog) {
    return <LoadingState label="catalog" />;
  }

  // -- Detail view --

  if (viewMode === "detail" && selectedPackId) {
    const catalogEntry = catalog?.find((e) => e.packId === selectedPackId);
    return (
      <PackDetailView
        catalogEntry={catalogEntry ?? null}
        installError={installError}
        installing={installing}
        onBack={handleBack}
        onInstall={handleInstall}
        onProjectCwdChange={setSelectedProjectCwd}
        onUninstall={handleUninstall}
        packDetail={packDetail ?? null}
        packId={selectedPackId}
        recentProjects={recentProjectRows}
        selectedProjectCwd={selectedProjectCwd}
      />
    );
  }

  // -- Catalog view --

  return (
    <PageShell
      description="Browse, install, and manage packs across harnesses"
      title="Packs"
    >
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <Input
            aria-label="Search packs"
            className="pl-9"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search packs..."
            value={search}
          />
        </div>
        {hasProjectScopedActions && (
          <ProjectCwdSelect
            className="w-[18rem]"
            onProjectCwdChange={setSelectedProjectCwd}
            recentProjects={recentProjectRows}
            selectedProjectCwd={selectedProjectCwd}
          />
        )}
        <Button
          disabled={refreshing}
          onClick={handleRefresh}
          size="sm"
          variant="outline"
        >
          <RefreshCw className={cx("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {installError && (
        <div className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)] text-sm">
          {installError}
        </div>
      )}

      <Tabs className="w-full" defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All ({filteredCatalog.length})</TabsTrigger>
          <TabsTrigger value="installed">
            Installed ({installedEntries.length})
          </TabsTrigger>
          <TabsTrigger value="discover">
            Discover ({discoverEntries.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="all">
          <CatalogGrid
            entries={filteredCatalog}
            installing={installing}
            onClick={handleCardClick}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
          />
        </TabsContent>

        <TabsContent className="mt-4" value="installed">
          {installedEntries.length === 0 ? (
            <EmptyState
              className="py-16"
              icon={Package}
              title="No packs installed yet"
            />
          ) : (
            <CatalogGrid
              entries={installedEntries}
              installing={installing}
              onClick={handleCardClick}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
            />
          )}
        </TabsContent>

        <TabsContent className="mt-4" value="discover">
          {discoverEntries.length === 0 ? (
            <EmptyState
              className="py-16"
              icon={Package}
              title="All available packs are installed"
            />
          ) : (
            <CatalogGrid
              entries={discoverEntries}
              installing={installing}
              onClick={handleCardClick}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Installed packs (from local detection) */}
      {!installedLoading && installedPackRows.length > 0 && (
        <DashboardCard contentClassName="p-0" title="Locally Detected Packs">
          <div className="overflow-auto">
            <DsTable className={DASHBOARD_TABLE_CLASS_NAME}>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5 text-left">Pack ID</TableHead>
                  <TableHead className="px-5 text-left">Harnesses</TableHead>
                  <TableHead className="px-5 text-right">Skills</TableHead>
                  <TableHead className="px-5 text-left">Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {installedPackRows.map((pack) => (
                  <TableRow
                    className="cursor-pointer hover:bg-[var(--muted)]/50"
                    key={installedPackId(pack)}
                    onClick={() => handleCardClick(installedPackId(pack))}
                  >
                    <TableCell className="px-5 font-medium">
                      {installedPackId(pack)}
                    </TableCell>
                    <TableCell className="px-5">
                      <div className="flex flex-wrap gap-1">
                        {installedPackHarnesses(pack).map((h) => (
                          <Badge
                            className="text-[10px]"
                            key={h}
                            variant="outline"
                          >
                            {h}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="px-5 text-right">
                      {pack.skillCount}
                    </TableCell>
                    <TableCell className="px-5">
                      {formatDate(pack.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DsTable>
          </div>
        </DashboardCard>
      )}

      {/* Install modal */}
      <InstallModal
        action={installModal.action}
        command={installModal.command}
        harness={installModal.harness}
        onClose={handleCloseModal}
        open={installModal.open}
        packId={installModal.packId}
        runId={installModal.runId}
      />
    </PageShell>
  );
}

// ---- Grid of catalog cards ----

function CatalogGrid({
  entries,
  onInstall,
  onUninstall,
  onClick,
  installing,
}: {
  entries: CatalogEntry[];
  onInstall: (packId: string, harness: string) => void;
  onUninstall: (packId: string, harness: string) => void;
  onClick: (packId: string) => void;
  installing: Record<string, boolean>;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        className="py-16"
        icon={Package}
        title="No packs match your search"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => (
        <CatalogCard
          entry={entry}
          installing={installing}
          key={entry.packId}
          onClick={onClick}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />
      ))}
    </div>
  );
}

// ---- Pack detail view ----

function PackDetailView({
  packId,
  catalogEntry,
  packDetail,
  onBack,
  onInstall,
  onUninstall,
  installing,
  recentProjects,
  selectedProjectCwd,
  onProjectCwdChange,
  installError,
}: {
  packId: string;
  catalogEntry: CatalogEntry | null;
  packDetail: InstalledPackDetail | null;
  onBack: () => void;
  onInstall: (packId: string, harness: string) => void;
  onUninstall: (packId: string, harness: string) => void;
  installing: Record<string, boolean>;
  recentProjects: string[];
  selectedProjectCwd: string;
  onProjectCwdChange: (cwd: string) => void;
  installError: string | null;
}) {
  const { data: readme } = useQueryCache<string | null>(
    `db:catalog-readme:${packId}`,
    () => window.desktopApi.db.getCatalogReadme(packId),
    30_000,
    60_000
  );

  const displayName = catalogEntry?.displayName ?? packId;
  const description =
    catalogEntry?.descriptionLive ?? catalogEntry?.description;
  const starHistory = catalogEntry ? catalogStarHistory(catalogEntry) : [];
  const skills = installedPackDetailSkills(packDetail);
  const associations = installedPackDetailAssociations(packDetail);
  const contentsCache = catalogContentsCache(catalogEntry);
  const hasProjectScopedActions = catalogEntry
    ? catalogHarnesses(catalogEntry).some(
        (harness) =>
          requiresProjectCwd(catalogEntry, harness, "install") ||
          requiresProjectCwd(catalogEntry, harness, "uninstall")
      )
    : false;

  return (
    <PageShell description={description ?? "Pack detail"} title={displayName}>
      {/* Back button */}
      <div>
        <Button className="gap-1" onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft className="h-4 w-4" /> Back to catalog
        </Button>
      </div>

      {/* Stats row */}
      {catalogEntry && (
        <div className="flex flex-wrap items-center gap-4 text-[var(--muted-foreground)] text-sm">
          {catalogEntry.stars != null && (
            <span className="flex items-center gap-1">
              <Star className="h-4 w-4" />
              {catalogEntry.stars.toLocaleString()} stars
            </span>
          )}
          {catalogEntry.forks != null && (
            <span className="flex items-center gap-1">
              <GitFork className="h-4 w-4" />
              {catalogEntry.forks.toLocaleString()} forks
            </span>
          )}
          {starHistory.length >= 2 && (
            <Sparkline data={starHistory} height={24} width={120} />
          )}
          {catalogEntry.githubUrl && (
            <a
              className="flex items-center gap-1 hover:text-[var(--foreground)]"
              href={catalogEntry.githubUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-4 w-4" /> GitHub
            </a>
          )}
          {catalogEntry.verified && <Badge variant="default">Verified</Badge>}
          {catalogEntry.category && (
            <Badge variant="outline">{catalogEntry.category}</Badge>
          )}
        </div>
      )}

      {installError && (
        <div className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)] text-sm">
          {installError}
        </div>
      )}

      {hasProjectScopedActions && (
        <DashboardCard title="Project">
          <ProjectCwdSelect
            className="max-w-xl"
            onProjectCwdChange={onProjectCwdChange}
            recentProjects={recentProjects}
            selectedProjectCwd={selectedProjectCwd}
          />
        </DashboardCard>
      )}

      {/* Harnesses + install actions */}
      {catalogEntry && (
        <DashboardCard title="Harnesses">
          <div className="flex flex-wrap gap-3">
            {catalogHarnesses(catalogEntry).map((harness) => {
              const installed =
                catalogInstalledHarnesses(catalogEntry).includes(harness);
              const busy = installing[`${packId}:${harness}`] ?? false;

              return (
                <div
                  className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2"
                  key={harness}
                >
                  <Badge variant="outline">{harness}</Badge>
                  {installed ? (
                    <Button
                      className="h-7 text-xs"
                      disabled={busy}
                      onClick={() => onUninstall(packId, harness)}
                      size="sm"
                      variant="outline"
                    >
                      {busy ? "..." : "Uninstall"}
                    </Button>
                  ) : (
                    <Button
                      className="h-7 text-xs"
                      disabled={busy || !!catalogEntry.placeholderReason}
                      onClick={() => onInstall(packId, harness)}
                      size="sm"
                      title={catalogEntry.placeholderReason ?? undefined}
                      variant="default"
                    >
                      {busy ? "..." : "Install"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </DashboardCard>
      )}

      {/* Skills list */}
      {skills.length > 0 && (
        <DashboardCard
          contentClassName="p-0"
          title={`Skills (${skills.length})`}
        >
          <div className="overflow-auto">
            <DsTable className={DASHBOARD_TABLE_CLASS_NAME}>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5 text-left">Name</TableHead>
                  <TableHead className="px-5 text-left">Description</TableHead>
                  <TableHead className="px-5 text-left">Harness</TableHead>
                  <TableHead className="px-5 text-left">Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skills.map((skill) => (
                  <TableRow key={skill.skillId}>
                    <TableCell className="px-5 font-medium">
                      {skill.name ?? skill.skillId}
                    </TableCell>
                    <TableCell className="px-5 text-[var(--muted-foreground)] text-xs">
                      {skill.description ?? "-"}
                    </TableCell>
                    <TableCell className="px-5">
                      {skill.harness ? (
                        <Badge className="text-[10px]" variant="outline">
                          {skill.harness}
                        </Badge>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell className="px-5 font-mono text-xs">
                      {skill.version ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DsTable>
          </div>
        </DashboardCard>
      )}

      {/* Project associations */}
      {associations.length > 0 && (
        <DashboardCard title="Project Associations">
          <div className="space-y-2">
            {associations.map((assoc) => (
              <div
                className="flex items-center justify-between text-sm"
                key={assoc.projectPath}
              >
                <span className="truncate font-mono text-xs">
                  {assoc.projectPath}
                </span>
                <span className="shrink-0 text-[var(--muted-foreground)] text-xs">
                  {formatDate(assoc.lastSeenAt)}
                </span>
              </div>
            ))}
          </div>
        </DashboardCard>
      )}

      {/* README */}
      {readme && (
        <DashboardCard title="README">
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm">
            {readme}
          </div>
        </DashboardCard>
      )}

      {/* Contents */}
      {contentsCache.length > 0 && (
        <DashboardCard contentClassName="p-0" title="Contents">
          <div className="overflow-auto">
            <DsTable className={DASHBOARD_TABLE_CLASS_NAME}>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5 text-left">Name</TableHead>
                  <TableHead className="px-5 text-left">Type</TableHead>
                  <TableHead className="px-5 text-left">Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contentsCache.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell className="px-5 font-medium">
                      {item.name}
                    </TableCell>
                    <TableCell className="px-5">
                      <Badge className="text-[10px]" variant="outline">
                        {item.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-5 text-[var(--muted-foreground)] text-xs">
                      {item.description ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DsTable>
          </div>
        </DashboardCard>
      )}
    </PageShell>
  );
}

function formatDate(value: string | null | undefined): string {
  return formatDateTimeOrFallback(value, { fallback: "-" });
}

function ProjectCwdSelect({
  recentProjects,
  selectedProjectCwd,
  onProjectCwdChange,
  className,
}: {
  recentProjects: string[];
  selectedProjectCwd: string;
  onProjectCwdChange: (cwd: string) => void;
  className?: string;
}) {
  return (
    <Select
      disabled={recentProjects.length === 0}
      onValueChange={(value) =>
        onProjectCwdChange(value === "__none" ? "" : value)
      }
      value={selectedProjectCwd || "__none"}
    >
      <SelectTrigger
        aria-label="Select project"
        className={cx("h-9", className)}
      >
        <SelectValue placeholder="Project" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">No recent projects</SelectItem>
        {recentProjects.map((cwd) => (
          <SelectItem key={cwd} value={cwd}>
            {cwd}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function requiresProjectCwd(
  entry: CatalogEntry | null | undefined,
  harness: string,
  action: "install" | "uninstall"
): boolean {
  if (!entry) {
    return false;
  }
  const commandMap =
    action === "install" ? entry.installCommands : entry.uninstallCommands;
  const command = commandMap?.[harness];
  return (
    entry.projectScoped ||
    (typeof command === "string" &&
      PROJECT_RELATIVE_HINTS.some((hint) => command.includes(hint)))
  );
}

function catalogHarnesses(entry: CatalogEntry): string[] {
  return Array.isArray(entry.harnesses) ? entry.harnesses : [];
}

function catalogInstalledHarnesses(entry: CatalogEntry): string[] {
  return Array.isArray(entry.installedHarnesses)
    ? entry.installedHarnesses
    : [];
}

function catalogStarHistory(entry: CatalogEntry): number[] {
  return Array.isArray(entry.history) ? entry.history.map((h) => h.stars) : [];
}

function catalogContentsCache(
  entry: CatalogEntry | null
): NonNullable<CatalogEntry["contentsCache"]> {
  return Array.isArray(entry?.contentsCache) ? entry.contentsCache : [];
}

function catalogDisplayName(entry: CatalogEntry): string {
  return typeof entry.displayName === "string"
    ? entry.displayName
    : catalogPackId(entry);
}

function catalogPackId(entry: CatalogEntry): string {
  return typeof entry.packId === "string" ? entry.packId : "";
}

function installedPackId(pack: InstalledPack): string {
  return typeof pack.packId === "string" ? pack.packId : "";
}

function installedPackHarnesses(pack: InstalledPack): string[] {
  return Array.isArray(pack.harnesses) ? pack.harnesses : [];
}

function installedPackDetailSkills(
  packDetail: InstalledPackDetail | null
): InstalledPackDetail["skills"] {
  return Array.isArray(packDetail?.skills) ? packDetail.skills : [];
}

function installedPackDetailAssociations(
  packDetail: InstalledPackDetail | null
): InstalledPackDetail["associations"] {
  return Array.isArray(packDetail?.associations) ? packDetail.associations : [];
}

function resolveProjectCwdForAction(
  entry: CatalogEntry | null | undefined,
  harness: string,
  action: "install" | "uninstall",
  selectedProjectCwd: string
): string | null | "missing" {
  if (!requiresProjectCwd(entry, harness, action)) {
    return null;
  }
  return selectedProjectCwd || "missing";
}

function handleCatalogMutationResult(
  result: CatalogMutationResult,
  setInstallError: (message: string | null) => void
): result is CatalogMutationResult & { started: true; runId: number } {
  if (result.started && typeof result.runId === "number") {
    return true;
  }
  setInstallError(result.error?.message ?? "Pack operation did not start.");
  return false;
}
