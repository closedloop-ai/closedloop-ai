/**
 * Desktop host of the shared agent component detail. Local inventory reads
 * use the injected IPC source; the Artifact canvas receives the existing
 * OptimizationAnalyticsPanel through the analytics slot, so no HTTP-backed
 * chart is mounted on the local source. The shell retains its Labs gates,
 * breadcrumb publisher, and the local install action.
 */

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentDetail } from "@repo/app/agents/components/workspace/agent-detail";
import { useAgentComponentDetail } from "@repo/app/agents/hooks/use-agent-component-detail";
import { isLocallyInstallable } from "@repo/app/agents/lib/component-meta";
import { CheckIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { HARNESS_AUTO } from "../../../shared/install-run-contract";
import { normalizePackId } from "../../../shared/normalize-pack-id";
import { cleanIpcError } from "../../clean-ipc-error";
import { usePublishDetailTitle } from "../../navigation/detail-title-context";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { OptimizationAnalyticsPanel } from "./optimization-analytics-panel";

/**
 * Split an org-identity slug (`${kind}::${key}`) into its analytics key half.
 *
 * The analytics IPC (`getComponentModelTrend`, `getSubagentFrequency`,
 * `isSkillLoaded`) filters on `agent_component_session_usage.component_key`,
 * which the identity slug is derived from (`orgIdentitySlug`). The display
 * `name` is NOT a reliable key — e.g. skills key on `/name` — so keying the
 * panel on the slug's key half avoids silently-empty analytics when the
 * display name differs from the usage `component_key`.
 */
function analyticsKeyFromSlug(slug: string): string {
  const sep = slug.indexOf("::");
  return sep === -1 ? slug : slug.slice(sep + 2);
}

/**
 * Desktop wrapper for the shared Agent Detail body (FEA-2923 / T-5.3).
 *
 * Mounts the shared `AgentDetail` presentational component, which fetches data
 * via `useAgentComponentDetail` off the injected local IPC data source, and
 * supplies the desktop-local `OptimizationAnalyticsPanel` inside its Artifact
 * canvas for the resolved component.
 *
 * `usePublishDetailTitle` publishes the resolved component name to the Topbar
 * breadcrumb ("Agents / <name>") while this view is mounted.
 */
export function AgentDetailView({
  agentSlug,
  backHref,
}: {
  agentSlug: string;
  backHref: string;
}) {
  return <AgentDetailViewContent agentSlug={agentSlug} backHref={backHref} />;
}

function AgentDetailViewContent({
  agentSlug,
  backHref,
}: {
  agentSlug: string;
  backHref: string;
}) {
  const detailQuery = useAgentComponentDetail(agentSlug);
  const detail = detailQuery.data;

  // Publish the component name to the Topbar breadcrumb ("Agents / <name>");
  // null while the detail is still loading. Uses a raw string key to avoid
  // extending DetailKind in detail-title-context (which is outside this
  // agent's file boundary): the key format mirrors detailTitleKey(). The third
  // argument reports that the READ settled (ISS-4839 / codex review on #4266)
  // so a not-found or unavailable component releases the breadcrumb's pending
  // slot rather than skeletoning against a settled body.
  usePublishDetailTitle(
    `agent:${agentSlug}`,
    detail?.name ?? null,
    !detailQuery.isLoading
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AgentDetail
        analytics={(detail) => (
          <OptimizationAnalyticsPanel
            target={{
              kind: detail.kind,
              // Analytics query keys on `agent_component_session_usage.component_key`
              // (the name-level key), NOT the display name. FEA-4335: `agentSlug` may
              // be a CONTENT-HASH routable slug (`${kind}::${fingerprint}`) whose key
              // half is a 64-hex digest, not the `component_key` — every optimization
              // query would miss. Prefer the detail's resolved `analyticsKey` (the
              // name the hash resolved back to); fall back to the slug's key half for
              // a legacy name-level route or a version-skewed reader that omits it.
              key: detail.analyticsKey ?? analyticsKeyFromSlug(agentSlug),
              name: detail.name,
              // ISS-4403: content-scope the optimization reads to the version this
              // route resolved to — the resolver's `analyticsFingerprint` (the full
              // `component_version_hash`; desktop has no DefinitionVersion linkage).
              // Present ONLY on a real content-hash route and ABSENT on a legacy
              // name-level route, so the panel aggregates the whole name there. This
              // deliberately does NOT use `versionId`: that is the representative
              // bucket hash, populated even on a name-level route, and scoping by it
              // would silently narrow the panel to one version (and hide
              // hashless/other-version history) while the page stays name-level.
              //
              // ISS-10341: the page's own totals are now FAMILY-scoped, so on a
              // content-hash route this panel is narrower than the page around it.
              // That is legible rather than silent — `shortFingerprint` below heads
              // it `This version · #<short>`. ISS-10488 owns whether it should widen.
              fingerprint: detail.analyticsFingerprint,
              // The short (8-hex) display badge for the panel subhead, present
              // exactly when the read was content-scoped so the heading can tell
              // the user WHICH version these numbers describe.
              shortFingerprint: detail.analyticsFingerprint
                ? detail.fingerprint
                : undefined,
            }}
          />
        )}
        backHref={backHref}
        getSessionHref={desktopSessionDetailHref}
        // FEA-4017: any org member can install a pack-sourced component onto
        // this local machine. The desktop machine IS the local target, so no
        // compute-target choice is offered.
        // Non-installable components (repo/local/server/scope sources) get no
        // action, mirroring how Promote hides for non-distributable kinds.
        headerAction={(component) =>
          isLocallyInstallable(component) ? (
            // Key by the component identity so the install action's local
            // idle/installing/done/error state is reset (remounted) when the
            // detail view is reused for a different component — a late resolve
            // from component A must never leave B showing "Install started" or
            // A's error.
            <DesktopInstallAction component={component} key={component.slug} />
          ) : null
        }
        slug={agentSlug}
      />
    </div>
  );
}

/**
 * FEA-4017 desktop "Install" header action. Installs the pack that carries this
 * component onto the local machine via the vetted `desktop:db:catalog-install`
 * IPC (`catalogInstall`), which resolves the install command from the local
 * `pack_catalog` row keyed by the pack id — cloud commands are never an install
 * source. Uses the `"auto"` harness so main resolves the concrete harness the
 * same way the auto-installer / opt-in banner do. Available to any org member:
 * the IPC is a local, sender-gated operation with no org-admin gate.
 */
function DesktopInstallAction({
  component,
}: {
  component: AgentComponentDetail;
}) {
  const [state, setState] = useState<"idle" | "installing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const packId = normalizePackId(component.source);

  const handleInstall = useCallback(async () => {
    const api = window.desktopApi?.db;
    if (!(api && packId)) {
      setError("Could not resolve a pack to install.");
      return;
    }
    setState("installing");
    setError(null);
    try {
      const result = await api.catalogInstall(packId, HARNESS_AUTO);
      // The IPC resolves `{ started: false, error }` (unresolvable pack /
      // in-flight run) WITHOUT throwing — treating any resolution as success
      // would make the button lie when nothing ran. Honor the `started` flag
      // and surface the rejection reason inline. Note `started: true` only means
      // the run KICKED OFF (streamRun spawns and returns before the child
      // exits), so the terminal label is the honest "Install started", not
      // "Installed" — we don't observe the run's exit here.
      if (result?.started) {
        setState("done");
      } else {
        setState("idle");
        setError(result?.error?.message ?? "Install did not start.");
      }
    } catch (err: unknown) {
      setState("idle");
      setError(cleanIpcError(err, "Install failed."));
    }
  }, [packId]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={state === "installing" || !packId}
        onClick={handleInstall}
        size="sm"
        type="button"
        variant="outline"
      >
        {state === "installing" ? (
          <Loader2Icon className="mr-1 size-4 animate-spin" />
        ) : null}
        {state === "done" ? <CheckIcon className="mr-1 size-4" /> : null}
        {state === "idle" ? <DownloadIcon className="mr-1 size-4" /> : null}
        {installLabel(state)}
      </Button>
      {error ? (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function installLabel(state: "idle" | "installing" | "done"): string {
  if (state === "installing") {
    return "Installing…";
  }
  if (state === "done") {
    return "Install started";
  }
  return "Install";
}
