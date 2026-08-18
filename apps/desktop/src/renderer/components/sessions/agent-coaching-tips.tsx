import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { ChevronRight, Plus, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAgentCoachingApi } from "./agent-coaching-api";
import { buildActionDraft } from "./agent-coaching-drafts";
import { groundedMetricsHaveActivity } from "./agent-coaching-lookback";
import {
  type AgentCoachingAction,
  type AgentCoachingApi,
  type AgentCoachingFeedbackEvent,
  type AgentCoachingGroundedMetrics,
  type AgentCoachingLoadResult,
  type AgentCoachingTip,
  type CoachingPackInfo,
  resolveApplyKind,
} from "./agent-coaching-types";
import { CodingWrapped } from "./coding-wrapped";

type AgentCoachingTipsProps = {
  api?: AgentCoachingApi;
  /**
   * FEA-3722: the selected date-range window in days (or `null` for all-time)
   * from the Sessions view's shared range selector. Threaded into every tips/
   * Coding-Wrap load so the deck honors the top 7d/30d/90d/All selector; a
   * change re-loads. Omitted (e.g. in isolated tests) keeps the default window.
   */
  lookbackDays?: number | null;
};

// The badge tells the user AT A GLANCE what kind of lever a tip pulls, so no two
// labels may read as the same thing. wall_time is the user's own clock ("Time");
// speed_of_delivery and token_efficiency both pull the reuse lever (turn a
// repeated pattern into a durable primitive), so both read as "Reuse"; and Cost
// owns spend outright — avoiding the old Speed/Wall-time and Tokens/Cost pairs
// that each looked like the same concept. "Wall time" was also our word, not the
// user's, so the badge says "Time".
const CATEGORY_LABELS: Record<AgentCoachingTip["category"], string> = {
  accuracy: "Accuracy",
  // FEA-4153: names the miss (a best practice the user's usage shows unused),
  // not the vague category noun "Capability".
  capability_gap: "Unused",
  context_management: "Context",
  cost: "Cost",
  opportunity_analysis: "Opportunity",
  resilience: "Resilience",
  speed_of_delivery: "Reuse",
  token_efficiency: "Reuse",
  wall_time: "Time",
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

// Backfill writes many rows in a burst; coalesce the resulting change pushes so
// the corpus-populated re-load fires once the burst settles, not once per row.
const ACTIVITY_WAIT_RELOAD_DEBOUNCE_MS = 400;

type CoachingKickoffHandlers = {
  onResult: (result: AgentCoachingLoadResult) => void;
  onError: () => void;
  /** Fired after the FIRST load settles (ok or error) so the panel reveals. */
  onFirstSettle: () => void;
};

/**
 * Kick off the day's coaching load, waiting for the local activity corpus to
 * populate before generating. Subscribes to local-DB changes (if the api
 * exposes the seam) and re-loads — debounced — until a load reports real
 * activity (or the harness returns tips), then stops so later DB churn doesn't
 * regenerate. Every load after the first sees a populated corpus, so the wasted
 * empty-corpus LLM spawn on the startup backfill race never happens. Returns a
 * cleanup fn that cancels any pending re-load and unsubscribes.
 */
function startCoachingKickoff(
  coachingApi: AgentCoachingApi,
  handlers: CoachingKickoffHandlers,
  // FEA-3722: window every load in this kickoff to the selected date range.
  lookbackDays?: number | null
): () => void {
  let cancelled = false;
  let inFlight = false;
  let firstSettled = false;
  // Set when a DB-activity push arrives while a load is already in flight. That
  // notification would otherwise be dropped (load() returns early on inFlight),
  // stranding the view on stale data until an unrelated later change. Instead we
  // record that the corpus went dirty mid-flight and reconcile exactly once when
  // the current load settles — bursts coalesce into this single flag, so we
  // never fan out one follow-up per push (FEA-3698).
  let dirty = false;
  let unsubscribe: (() => void) | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const stopWaiting = () => {
    unsubscribe?.();
    unsubscribe = null;
    // Drop any pending follow-up work: nothing scheduled and no dirty state
    // survives disposal or the grounded-stop, so we never reconcile after we've
    // torn down (or double-subscribe on a remount).
    dirty = false;
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
  };

  const load = () => {
    if (cancelled) {
      return;
    }
    if (inFlight) {
      // A load is already running; remember that data changed underneath it so
      // the single follow-up scheduled when it settles reconciles the latest
      // state, rather than dropping this push. Only track dirtiness while we're
      // still watching — once stopWaiting() has unsubscribed we intentionally
      // stop reacting to DB churn for the day.
      if (unsubscribe !== null) {
        dirty = true;
      }
      return;
    }
    inFlight = true;
    coachingApi
      .loadTips(lookbackDays)
      .then((result) => {
        if (cancelled) {
          return;
        }
        handlers.onResult(result);
        // Grounded in real activity (or the harness already produced tips) —
        // we've kicked off for the day; stop watching so later writes don't
        // trigger a regenerate.
        if (
          groundedMetricsHaveActivity(result.groundedMetrics) ||
          result.tips.length > 0
        ) {
          stopWaiting();
        }
      })
      .catch(() => {
        if (!cancelled) {
          handlers.onError();
        }
        // A failed load leaves a retry path intact: we stay subscribed, so the
        // next DB push (or the dirty follow-up below) re-attempts the load.
      })
      .finally(() => {
        inFlight = false;
        if (!(firstSettled || cancelled)) {
          firstSettled = true;
          handlers.onFirstSettle();
        }
        // Reconcile activity that landed while this load was in flight. Consume
        // the flag and schedule EXACTLY ONE debounced follow-up (further
        // mid-flight pushes coalesced into it); skip when cancelled or once we've
        // stopped watching, so disposal/grounded-stop leaves no trailing reload.
        if (dirty && !cancelled && unsubscribe !== null) {
          dirty = false;
          scheduleReload();
        }
      });
  };

  // Coalesce a burst of pushes into a single debounced load: clearing any prior
  // timer means N rapid notifications collapse to one reconciliation once the
  // burst settles, not one load per row of a backfill.
  const scheduleReload = () => {
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(load, ACTIVITY_WAIT_RELOAD_DEBOUNCE_MS);
  };

  // Subscribe BEFORE the first read so a backfill write that lands between the
  // read and the subscription can't be missed (which would strand coaching
  // empty until the next unrelated DB change).
  unsubscribe =
    coachingApi.subscribeToActivity?.(() => {
      if (cancelled) {
        return;
      }
      scheduleReload();
    }) ?? null;

  load();

  return () => {
    cancelled = true;
    stopWaiting();
  };
}

export function AgentCoachingTips({
  api,
  lookbackDays,
}: AgentCoachingTipsProps) {
  const coachingApi = useMemo(
    () => api ?? createAgentCoachingApi(window.desktopApi),
    [api]
  );
  const [tips, setTips] = useState<AgentCoachingTip[]>([]);
  const [activePack, setActivePack] = useState<CoachingPackInfo | null>(null);
  // The lookback metrics powering the Coding Wrapped deck (FEA-3403). Populated
  // from the same load pass as the tips — the deck renders nothing until set.
  const [groundedMetrics, setGroundedMetrics] =
    useState<AgentCoachingGroundedMetrics | null>(null);
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

  // Load the day's batch on mount (i.e. every login), but DEFER generation until
  // the local corpus is populated: on the desktop startup race this panel mounts
  // before the SQLite backfill lands sessions/events/tokens, so the first read
  // sees nothing and would otherwise burn a (refused) LLM spawn on an empty
  // corpus. `startCoachingKickoff` re-loads once the local DB reports activity
  // and only kicks off generation when there's real data to ground tips in;
  // after that first grounded load it stops (the model already drops tips the
  // user cleared today, so we do not auto-refetch beyond the initial wait).
  useEffect(() => {
    // FEA-3722: re-run (re-load the Wrap + tips) whenever the selected date
    // range changes so the deck re-windows to the new 7d/30d/90d/All selection.
    // Clear the prior window's tips/metrics and re-enter the loading gate FIRST,
    // so the Wrap never renders stats (or a window label) computed for a range
    // the user just left — the panel hides until the new grounded load settles,
    // exactly as on the initial mount, rather than flashing stale numbers.
    setLoading(true);
    setTips([]);
    setActivePack(null);
    setGroundedMetrics(null);
    setSelectedIndex(0);
    return startCoachingKickoff(
      coachingApi,
      {
        onError: () => {
          setTips([]);
          setActivePack(null);
          setGroundedMetrics(null);
        },
        onFirstSettle: () => setLoading(false),
        onResult: ({
          tips: loadedTips,
          activePack: pack,
          groundedMetrics: metrics,
        }) => {
          setTips(loadedTips);
          setActivePack(pack);
          setGroundedMetrics(metrics);
          setSelectedIndex(0);
        },
      },
      lookbackDays
    );
  }, [coachingApi, lookbackDays]);

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
    // Dismiss moves selection to a different tip; drop any open draft so a stale
    // drafted-artifact panel from the dismissed tip doesn't hang over the next
    // one (FEA-3687 #2). Not reset on the install path, which must keep showing
    // its install-result message.
    installer.reset();
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
    // The drafted-artifact / pending-install / install-result panel belongs to
    // the tip you drafted it from. Reset it on navigation so a stale draft from
    // the previous tip never lingers over the next one (FEA-3687 #2).
    installer.reset();
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
      // FEA-3722: keep the on-demand pull windowed to the selected date range.
      .loadTips(lookbackDays)
      .then(
        ({ tips: loadedTips, activePack: pack, groundedMetrics: metrics }) => {
          // Keep the badge and Wrapped deck in sync with the signals this pass
          // actually used.
          setActivePack(pack);
          setGroundedMetrics(metrics);
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
        }
      )
      .catch(() => undefined)
      .finally(() => setFetchingMore(false));
  };

  return (
    <Card
      aria-label="Agent coaching tips"
      className="border-border"
      role="region"
    >
      {/* Persistent header, always present so the user can pull more tips even
        after dismissing everything. The action button lives in the Card's
        CardAction slot, the provenance in CardDescription. */}
      <CardHeader>
        <CardTitle className="font-medium text-base">Coaching</CardTitle>
        {activePack ? (
          <CardDescription
            title={`Coaching signals supplied by the ${activePack.displayName} pack${
              activePack.version ? ` v${activePack.version}` : ""
            }`}
          >
            Powered by {activePack.displayName}
          </CardDescription>
        ) : null}
        <CardAction>
          <Button
            disabled={fetchingMore}
            onClick={getMoreTips}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus className="size-4" />
            {fetchingMore ? "Getting more…" : "Get more tips"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {selectedTip ? (
          <div>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="accent">
                    {CATEGORY_LABELS[selectedTip.category]}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    Tip {selectedIndex + 1} of {tips.length}
                  </span>
                </div>
                <h3 className="mt-2 font-semibold text-foreground text-sm">
                  {selectedTip.title}
                </h3>
                <p className="mt-1 text-muted-foreground text-sm">
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
                {expanded ? "Hide details" : "Details"}
              </Button>
              {tips.length > 1 ? (
                <Button
                  onClick={showNext}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              ) : null}
            </div>

            {expanded ? (
              <TipDetails onAction={handleAction} tip={selectedTip} />
            ) : null}
            {lastAction ? (
              <p className="mt-3 text-muted-foreground text-xs">{lastAction}</p>
            ) : null}
          </div>
        ) : null}

        {noNewNotice ? (
          <p className="text-muted-foreground text-sm">
            No new tips right now. Check back after a few more sessions.
          </p>
        ) : null}
        {selectedTip || noNewNotice ? null : (
          <p className="text-muted-foreground text-sm">
            No coaching tips right now. Use “Get more tips” to generate fresh
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

        {/* Coding Wrapped (FEA-3403): a light, secondary fun-fact strip under the
          actionable tip, hidden until a signal exists. */}
        <CodingWrapped metrics={groundedMetrics} />
      </CardContent>
    </Card>
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
    <div>
      <h4 className="font-medium text-foreground text-xs uppercase tracking-wide">
        Drafted artifact
      </h4>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-3 text-muted-foreground text-xs">
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
        // A successful install tears the whole panel down (see useDraftInstaller),
        // so this line now only ever surfaces a failure. Render it in the
        // destructive token — matching the SessionsView error row — so a failure
        // reads like a failure instead of neutral helper copy.
        <p className="mt-2 whitespace-pre-wrap text-[var(--destructive)] text-xs">
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
      // Dispatch by the reviewed action's kind (FEA-3687 #4): a
      // create-new-file skill installs deterministically; edit-existing routes
      // to the LLM-driven harness edit. `pendingInstall` is the action being
      // installed; absent kind defaults to create-new-file via resolveApplyKind.
      const kind = pendingInstall
        ? resolveApplyKind(pendingInstall)
        : undefined;
      await installArtifact(draftText, undefined, kind);
      // FEA-3722: a successful install removes the tip (onApplied) AND must
      // clear the draft/pending/install state — otherwise the reviewed-draft
      // panel lingers below a now-empty coaching surface. Reset before
      // onApplied so the whole draft affordance tears down with the tip.
      reset();
      onApplied();
    } catch (error) {
      // Failure keeps the drafted artifact on screen and surfaces why; clearing
      // pendingInstall drops the one-shot Install button (as before), so a retry
      // goes back through Apply. Only a SUCCESSFUL install resets the panel.
      setInstallResult(formatInstallError(error));
      setPendingInstall(null);
    } finally {
      setInstalling(false);
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
    <div className="mt-4 grid gap-4 border-border border-t pt-4">
      <div className="grid gap-1">
        <h4 className="font-medium text-foreground text-xs uppercase tracking-wide">
          Why
        </h4>
        <p className="text-muted-foreground text-sm">
          {tip.detail.whyThisRecommendation}
        </p>
      </div>

      <div className="grid gap-2">
        <h4 className="font-medium text-foreground text-xs uppercase tracking-wide">
          Evidence
        </h4>
        <ul className="grid gap-1 text-muted-foreground text-sm">
          {tip.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {tip.detail.candidateFromThisDryRun ? (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="font-medium text-foreground text-sm">
            {tip.detail.candidateFromThisDryRun.moveThis}
          </p>
          <p className="mt-1 text-muted-foreground text-sm">
            Estimated savings:{" "}
            {tip.detail.candidateFromThisDryRun.estimatedTokenSavingsPercent}%
            of repeated probe tokens.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <h4 className="font-medium text-foreground text-xs uppercase tracking-wide">
          Actions
        </h4>
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
