import type {
  LightPlan,
  LightPlanActionError,
  LightPlanPendingAction,
  LightPlanVersion,
} from "@repo/app/agents/components/plans/light-plans-shell";
import {
  getLightPlanStatusLabel,
  LightPlansShell,
  resolveLightPlanConfirmationState,
} from "@repo/app/agents/components/plans/light-plans-shell";
import { useCallback, useMemo, useState } from "react";
import type {
  PlanRecord,
  PlanVersionRecord,
} from "../../../shared/agent-db-contract";
import { invalidateCache, useQueryCache } from "../../hooks/useQueryCache";
import { LoadingState, PageShell } from "../layout/page-shell";

export function PlansView() {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<LightPlanPendingAction | null>(null);
  const [actionError, setActionError] = useState<LightPlanActionError | null>(
    null
  );

  const {
    data: plans,
    loading,
    error,
  } = useQueryCache<PlanRecord[]>(
    "db:plans-list",
    () => window.desktopApi.db.getPlansList(),
    5000,
    10_000
  );

  const planList = arrayOrEmpty(plans);
  const selectedPlan = useMemo(
    () => planList.find((plan) => plan.id === selectedPlanId) ?? null,
    [planList, selectedPlanId]
  );

  const {
    data: versions,
    loading: versionsLoading,
    error: versionsError,
  } = useQueryCache<PlanVersionRecord[]>(
    `db:plan-versions:${selectedPlanId}`,
    () =>
      selectedPlanId
        ? window.desktopApi.db.getPlanVersions(selectedPlanId)
        : Promise.resolve([]),
    10_000,
    30_000
  );

  const lightPlans = useMemo(
    () => planList.map(mapPlanRecordToLightPlan),
    [planList]
  );
  const selectedLightPlan = useMemo(
    () => (selectedPlan ? mapPlanRecordToLightPlan(selectedPlan) : null),
    [selectedPlan]
  );
  const lightVersions = useMemo(
    () => arrayOrEmpty(versions).map(mapPlanVersionRecordToLightPlanVersion),
    [versions]
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedPlanId(id);
    setShowVersions(false);
    setActionError((current) => (current?.planId === id ? current : null));
  }, []);

  const handleConfirm = useCallback(async (id: string) => {
    setPendingAction({ planId: id, action: "confirm" });
    setActionError(null);
    try {
      await window.desktopApi.db.confirmPlan(id);
      invalidateCache("db:plans-list");
    } catch {
      setActionError({
        planId: id,
        action: "confirm",
        message: getPlanActionErrorMessage("confirm"),
      });
    } finally {
      setPendingAction((current) =>
        current?.planId === id && current.action === "confirm" ? null : current
      );
    }
  }, []);

  const handleReject = useCallback(async (id: string) => {
    setPendingAction({ planId: id, action: "reject" });
    setActionError(null);
    try {
      await window.desktopApi.db.rejectPlan(id);
      invalidateCache("db:plans-list");
    } catch {
      setActionError({
        planId: id,
        action: "reject",
        message: getPlanActionErrorMessage("reject"),
      });
    } finally {
      setPendingAction((current) =>
        current?.planId === id && current.action === "reject" ? null : current
      );
    }
  }, []);

  if (loading && !plans) {
    return <LoadingState label="plans" />;
  }

  return (
    <PageShell
      description="Plans extracted from agent sessions -- review, confirm, or reject"
      title="Plans"
    >
      <LightPlansShell
        actionError={actionError}
        isError={error}
        isLoading={loading && !plans}
        isVersionsError={versionsError}
        isVersionsLoading={versionsLoading && !versions}
        onConfirmPlan={handleConfirm}
        onRejectPlan={handleReject}
        onSelectPlan={handleSelect}
        onToggleVersions={() => setShowVersions((visible) => !visible)}
        pendingAction={pendingAction}
        plans={lightPlans}
        selectedPlan={selectedLightPlan}
        selectedPlanId={selectedPlanId}
        showVersions={showVersions}
        surfaceCapabilities={{
          projectControls: false,
          teamControls: false,
        }}
        versions={lightVersions}
      />
    </PageShell>
  );
}

/**
 * Maps the stable desktop renderer DTO into the package-owned light-plan
 * projection. Persistence and IPC ownership stay in the existing desktop store.
 */
export function mapPlanRecordToLightPlan(plan: PlanRecord): LightPlan {
  const confirmationState = resolveLightPlanConfirmationState(
    plan.status,
    plan.needsConfirmation
  );

  return {
    id: plan.id,
    title: plan.title,
    source: plan.source,
    harness: plan.harness,
    captureMethod: plan.captureMethod,
    sourceStatus: plan.status,
    confirmationState,
    statusLabel: getLightPlanStatusLabel(plan.status, confirmationState),
    latestContent: plan.latestContent,
    versionCount: plan.versionCount,
    filePath: plan.filePath,
    sourceLogPath: plan.sourceLogPath,
    confidence: plan.confidence,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function getPlanActionErrorMessage(
  action: LightPlanActionError["action"]
): string {
  return action === "confirm"
    ? "Plan confirmation failed. Try again."
    : "Plan rejection failed. Try again.";
}

/**
 * Keeps version-row display data caller-owned; the shared shell never
 * re-synthesizes selected plan content from these rows.
 */
export function mapPlanVersionRecordToLightPlanVersion(
  version: PlanVersionRecord
): LightPlanVersion {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    authorType: version.authorType,
    captureMethod: version.captureMethod,
    createdAt: version.createdAt,
    contentMarkdown: version.contentMarkdown,
  };
}

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
