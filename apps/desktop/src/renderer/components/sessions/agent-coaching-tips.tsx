import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  ChevronRight,
  Lightbulb,
  Plus,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAgentCoachingApi } from "./agent-coaching-api";
import { buildActionDraft } from "./agent-coaching-drafts";
import type {
  AgentCoachingAction,
  AgentCoachingApi,
  AgentCoachingFeedbackEvent,
  AgentCoachingTip,
  CoachingPackInfo,
} from "./agent-coaching-types";

type AgentCoachingTipsProps = {
  api?: AgentCoachingApi;
};

const CATEGORY_LABELS: Record<AgentCoachingTip["category"], string> = {
  accuracy: "Accuracy",
  context_management: "Context",
  opportunity_analysis: "Opportunity",
  speed_of_delivery: "Speed",
  token_efficiency: "Tokens",
};

function formatInstallError(error: unknown): string {
  return error instanceof Error
    ? `Install failed: ${error.message}`
    : "Install failed.";
}

/**
 * Append generated tips not already shown or cleared this session; reports
 * whether any were new.
 */
function appendFreshTips(
  current: AgentCoachingTip[],
  loaded: AgentCoachingTip[],
  cleared: ReadonlySet<string>
): { next: AgentCoachingTip[]; added: boolean } {
  const known = new Set(current.map((tip) => tip.id));
  const fresh = loaded.filter(
    (tip) => !(known.has(tip.id) || cleared.has(tip.id))
  );
  return { next: [...current, ...fresh], added: fresh.length > 0 };
}

export function AgentCoachingTips({ api }: AgentCoachingTipsProps) {
  const coachingApi = useMemo(
    () => api ?? createAgentCoachingApi(window.desktopApi),
    [api]
  );
  const [tips, setTips] = useState<AgentCoachingTip[]>([]);
  const [activePack, setActivePack] = useState<CoachingPackInfo | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [noNewNotice, setNoNewNotice] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  // Tips the user cleared this session (dismissed or acted on). Held in a ref
  // (it is never rendered) and mutated synchronously the moment a tip is
  // cleared, so getMoreTips' async setTips updater reads the set as of
  // promise-resolution time, not button-click time: a tip cleared while
  // loadTips() is in flight must still be suppressed. recordFeedback is
  // best-effort, so if it fails the model can re-serve a cleared tip on the next
  // load; excluding these ids from appended results keeps a telemetry failure
  // from resurrecting a tip the user already cleared this session.
  const clearedIdsRef = useRef<Set<string>>(new Set());
  const installer = useDraftInstaller(coachingApi);

  // Load the day's batch on mount (i.e. every login). The model already drops
  // tips the user dismissed or acted on today, so once they've been cleared
  // out this returns nothing and the panel stays empty until tomorrow — we do
  // not auto-refetch.
  useEffect(() => {
    let mounted = true;
    // A single load pass returns the day's tips and the pack that powered them.
    // The pack drives the "Powered by …" badge; null / failure just means the
    // built-in signals are in effect, so the badge renders nothing.
    coachingApi
      .loadTips()
      .then(({ tips: loadedTips, activePack: pack }) => {
        if (mounted) {
          setTips(loadedTips);
          setActivePack(pack);
          setSelectedIndex(0);
        }
      })
      .catch(() => {
        if (mounted) {
          setTips([]);
          setActivePack(null);
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [coachingApi]);

  const selectedTip = tips[selectedIndex] ?? null;

  // Hide only during the first load. Once loaded we always render the bar — even
  // with zero tips — so "Get More Tips" stays reachable after everything has
  // been dismissed (rather than the whole panel vanishing).
  if (loading) {
    return null;
  }

  const recordFeedback = async (
    action: AgentCoachingFeedbackEvent["action"],
    actionId?: string
  ) => {
    if (!selectedTip) {
      return;
    }
    await coachingApi.recordFeedback({
      action,
      actionId,
      category: selectedTip.category,
      createdAt: new Date().toISOString(),
      tipId: selectedTip.id,
    });
  };

  // Clearing a tip — by dismissing OR acting on it — is the only way to remove
  // it. It drops out of the in-session list and the recorded feedback keeps the
  // model from re-serving it for the rest of the day.
  const clearSelectedTip = () => {
    if (!selectedTip) {
      return;
    }
    const clearedId = selectedTip.id;
    clearedIdsRef.current.add(clearedId);
    setTips((current) => {
      const next = current.filter((tip) => tip.id !== clearedId);
      setSelectedIndex((index) =>
        Math.min(index, Math.max(next.length - 1, 0))
      );
      return next;
    });
    setExpanded(false);
  };

  const dismissTip = async () => {
    // recordFeedback is best-effort telemetry; a rejection must never strand the
    // tip in the UI. Clear it regardless of whether the feedback was recorded.
    try {
      await recordFeedback("dismissed");
    } catch {
      // Ignore — the tip is still cleared below so the user can dismiss it.
    }
    setLastAction(null);
    clearSelectedTip();
  };

  const openDetails = async () => {
    if (!expanded) {
      setExpanded(true);
      // recordFeedback is best-effort telemetry; a rejection must not surface
      // as an unhandled rejection. The panel is already expanded above.
      try {
        await recordFeedback("details_opened");
      } catch {
        // Ignore — the details are open regardless of feedback recording.
      }
    }
  };

  const toggleDetails = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    await openDetails();
  };

  const handleAction = async (action: AgentCoachingAction) => {
    if (!selectedTip) {
      return;
    }
    // read_only inspects (reveal the cluster), it doesn't resolve the tip.
    if (action.mode === "read_only") {
      await openDetails();
      return;
    }
    // confirm_then_apply surfaces the draft for review; the explicit Install
    // click then applies it. A plain draft is a preview — show + copy the
    // artifact but KEEP the tip (and its Apply action) so the user can still
    // install it. Only Install or Dismiss clears the tip.
    if (installer.draft(selectedTip, action) === "review") {
      setLastAction(`${action.label}: review the draft below, then install`);
      return;
    }
    // recordFeedback is best-effort telemetry; a rejection must not strand the
    // status message or surface as an unhandled rejection. The draft was
    // already produced above.
    try {
      await recordFeedback("action_clicked", action.id);
    } catch {
      // Ignore — the draft is ready regardless of feedback recording.
    }
    setLastAction(`${action.label}: drafted & copied to clipboard`);
  };

  const installDraft = async () => {
    const action = installer.pendingInstall;
    if (!(action && selectedTip)) {
      return;
    }
    // recordFeedback is best-effort telemetry; a rejection must not block the
    // install (which clears the tip on success).
    try {
      await recordFeedback("action_clicked", action.id);
    } catch {
      // Ignore — proceed to install regardless of feedback recording.
    }
    await installer.install(clearSelectedTip);
  };

  const showNext = () => {
    if (tips.length === 0) {
      return;
    }
    setSelectedIndex((index) => (index + 1) % tips.length);
    setExpanded(false);
    setLastAction(null);
  };

  // Explicit opt-in to pull more suggestions on demand — the same generation
  // path as the initial load. Appends only ids not already shown; dismissed ids
  // never come back. If nothing new is produced we say so rather than no-op'ing
  // silently.
  const getMoreTips = () => {
    if (fetchingMore) {
      return;
    }
    setFetchingMore(true);
    setNoNewNotice(false);
    installer.reset();
    coachingApi
      .loadTips()
      .then(({ tips: loadedTips, activePack: pack }) => {
        // Keep the badge in sync with the signals this pass actually used.
        setActivePack(pack);
        setTips((current) => {
          const { next, added } = appendFreshTips(
            current,
            loadedTips,
            clearedIdsRef.current
          );
          if (!added) {
            setNoNewNotice(true);
            return current;
          }
          if (current.length === 0) {
            setSelectedIndex(0);
          }
          return next;
        });
      })
      .catch(() => undefined)
      .finally(() => setFetchingMore(false));
  };

  return (
    <section
      aria-label="Agent coaching tips"
      className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm"
    >
      {/* Persistent bar — always present so the user can pull more tips even
          after dismissing everything. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[var(--muted-foreground)] text-xs uppercase tracking-[0.18em]">
          <span className="flex size-7 items-center justify-center rounded-md bg-[var(--primary)]/10 text-[var(--primary)]">
            <Lightbulb className="size-4" />
          </span>
          Coaching
          {activePack ? (
            <Badge
              title={`Coaching signals supplied by the ${activePack.displayName} pack${
                activePack.version ? ` v${activePack.version}` : ""
              }`}
              variant="secondary"
            >
              Powered by {activePack.displayName}
            </Badge>
          ) : null}
        </div>
        <Button
          disabled={fetchingMore}
          onClick={getMoreTips}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus className="size-4" />
          {fetchingMore ? "Getting more…" : "Get More Tips"}
        </Button>
      </div>

      {selectedTip ? (
        <div className="mt-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="accent">
                  {CATEGORY_LABELS[selectedTip.category]}
                </Badge>
                <span className="text-[var(--muted-foreground)] text-xs">
                  Tip {selectedIndex + 1} of {tips.length}
                </span>
              </div>
              <h2 className="mt-2 font-semibold text-[var(--foreground)] text-sm">
                {selectedTip.title}
              </h2>
              <p className="mt-1 text-[var(--muted-foreground)] text-sm">
                {selectedTip.body}
              </p>
            </div>
            <Button
              aria-label="Dismiss coaching tip"
              onClick={dismissTip}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={toggleDetails}
              size="sm"
              type="button"
              variant="outline"
            >
              <Sparkles className="size-4" />
              Details
            </Button>
            {tips.length > 1 ? (
              <Button
                onClick={showNext}
                size="sm"
                type="button"
                variant="ghost"
              >
                <ChevronRight className="size-4" />
                Next
              </Button>
            ) : null}
          </div>

          {expanded ? (
            <TipDetails onAction={handleAction} tip={selectedTip} />
          ) : null}
          {lastAction ? (
            <p className="mt-3 text-[var(--muted-foreground)] text-xs">
              {lastAction}
            </p>
          ) : null}
        </div>
      ) : null}

      {noNewNotice ? (
        <p className="mt-3 text-[var(--muted-foreground)] text-sm">
          No new tips right now — check back after a few more sessions.
        </p>
      ) : null}
      {selectedTip || noNewNotice ? null : (
        <p className="mt-3 text-[var(--muted-foreground)] text-sm">
          No coaching tips right now. Use “Get More Tips” to generate fresh
          ones.
        </p>
      )}

      <DraftArtifactPanel
        canInstall={Boolean(coachingApi.installArtifact)}
        installer={installer}
        onInstall={() => {
          installDraft().catch(() => undefined);
        }}
      />
    </section>
  );
}

type DraftInstaller = ReturnType<typeof useDraftInstaller>;

function DraftArtifactPanel({
  installer,
  canInstall,
  onInstall,
}: {
  installer: DraftInstaller;
  canInstall: boolean;
  onInstall: () => void;
}) {
  if (!installer.draftText) {
    return null;
  }
  return (
    <div className="mt-3">
      <h3 className="font-medium text-[var(--foreground)] text-xs uppercase tracking-[0.14em]">
        Drafted artifact
      </h3>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--muted)]/30 p-3 text-[var(--muted-foreground)] text-xs">
        {installer.draftText}
      </pre>
      {installer.pendingInstall && canInstall ? (
        <Button
          className="mt-2"
          disabled={installer.installing}
          onClick={onInstall}
          size="sm"
          type="button"
          variant="secondary"
        >
          <WandSparkles className="size-4" />
          {installer.installing
            ? "Installing…"
            : `Install (${installer.pendingInstall.label})`}
        </Button>
      ) : null}
      {installer.installResult ? (
        <p className="mt-2 whitespace-pre-wrap text-[var(--muted-foreground)] text-xs">
          {installer.installResult}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Owns the draft/install sub-state so the main component stays under the
 * cognitive-complexity limit. `draft()` produces the artifact (returning
 * "review" when it needs an explicit Install) and `install()` hands the
 * reviewed draft to the local harness.
 */
function useDraftInstaller(coachingApi: AgentCoachingApi) {
  const [draftText, setDraftText] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] =
    useState<AgentCoachingAction | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<string | null>(null);

  const reset = () => {
    setDraftText(null);
    setPendingInstall(null);
    setInstallResult(null);
  };

  const draft = (
    tip: AgentCoachingTip,
    action: AgentCoachingAction
  ): "review" | "drafted" => {
    const text = buildActionDraft(tip, action);
    setDraftText(text);
    setInstallResult(null);
    if (action.mode === "confirm_then_apply" && coachingApi.installArtifact) {
      setPendingInstall(action);
      return "review";
    }
    setPendingInstall(null);
    if (typeof navigator !== "undefined") {
      navigator.clipboard?.writeText?.(text)?.catch(() => {
        // Clipboard write is best-effort; ignore rejection (e.g. permission denied).
      });
    }
    return "drafted";
  };

  const install = async (onApplied: () => void): Promise<void> => {
    const installArtifact = coachingApi.installArtifact;
    if (!(draftText && installArtifact)) {
      return;
    }
    setInstalling(true);
    try {
      const output = await installArtifact(draftText);
      setInstallResult(output.trim() || "Installed.");
      onApplied();
    } catch (error) {
      setInstallResult(formatInstallError(error));
    } finally {
      setInstalling(false);
      setPendingInstall(null);
    }
  };

  return {
    draft,
    draftText,
    install,
    installing,
    installResult,
    pendingInstall,
    reset,
  };
}

function TipDetails({
  onAction,
  tip,
}: {
  onAction: (action: AgentCoachingAction) => void;
  tip: AgentCoachingTip;
}) {
  return (
    <div className="mt-4 grid gap-4 border-[var(--border)] border-t pt-4">
      <div className="grid gap-1">
        <h3 className="font-medium text-[var(--foreground)] text-xs uppercase tracking-[0.14em]">
          Why
        </h3>
        <p className="text-[var(--muted-foreground)] text-sm">
          {tip.detail.whyThisRecommendation}
        </p>
      </div>

      <div className="grid gap-2">
        <h3 className="font-medium text-[var(--foreground)] text-xs uppercase tracking-[0.14em]">
          Evidence
        </h3>
        <ul className="grid gap-1 text-[var(--muted-foreground)] text-sm">
          {tip.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {tip.detail.candidateFromThisDryRun ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 p-3">
          <p className="font-medium text-[var(--foreground)] text-sm">
            {tip.detail.candidateFromThisDryRun.moveThis}
          </p>
          <p className="mt-1 text-[var(--muted-foreground)] text-sm">
            Estimated savings:{" "}
            {tip.detail.candidateFromThisDryRun.estimatedTokenSavingsPercent}%
            of repeated probe tokens.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <h3 className="font-medium text-[var(--foreground)] text-xs uppercase tracking-[0.14em]">
          Actions
        </h3>
        <div className="flex flex-wrap gap-2">
          {tip.actions.map((action) => (
            <Button
              key={action.id}
              onClick={() => onAction(action)}
              size="sm"
              type="button"
              variant={
                action.mode === "confirm_then_apply" ? "outline" : "secondary"
              }
            >
              <WandSparkles className="size-4" />
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
