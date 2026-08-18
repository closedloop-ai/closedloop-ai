/**
 * Desktop opt-in distributions banner (FEA-2923 / §I).
 *
 * Subscribes to the main-process `desktop:distributions:opt-in-available`
 * push (bridged as `window.desktopApi.onDistributionsOptInAvailable`) and
 * surfaces each opt-in distribution so the targeted user can accept/install
 * it themselves — the "surfaced to the targeted users to accept/install"
 * half of the distribution motion (auto_install is handled headlessly by the
 * main-process RequiredPluginInstaller; opt_in is user-driven here).
 *
 * Accept branches on the distribution type:
 *
 *   - Generic (plugin/skill/command) distributions route through the same vetted
 *     local catalog-install path the auto-installer uses: the pack id is derived
 *     from the catalog item name with the shared `normalizePackId`, then
 *     `catalogInstall(packId, "auto")` runs the vetted local install command.
 *
 *   - Coaching-pack distributions (`catalogItem.coaching`) are NOT installable via
 *     the generic `pack_catalog` path — they live in the managed coaching-packs
 *     store and are copied/activated from a presigned asset zip by the
 *     main-process coaching-pack installer. Accept routes them through the
 *     dedicated `coachingInstall(dist.id)` bridge (which resolves the asset by
 *     distribution id) rather than running `catalogInstall` with a pack id the
 *     local catalog will never resolve.
 *
 * Accept/dismiss are remembered for the lifetime of this component (`handledIds`)
 * so a cloud reconnect that re-pushes an already-handled distribution does not
 * resurrect a banner row the user already dealt with.
 *
 * Mounting (FEA-4007): this is an app-level startup surface, mounted directly in
 * the desktop `AppShell` alongside the other global banners — NOT inside the
 * Agents workspace view. It is intentionally decoupled from the current tab so a
 * targeted user is prompted to opt into an org-distributed install on startup
 * regardless of which tab is open.
 *
 * At app level each pending distribution renders as its own sibling-shaped
 * banner row, matching UpdateBanner / DesktopSessionExpiredBanner /
 * DesktopSyncPrompt / FirstLaunchImportBanner: a single centered line of copy
 * plus its Accept/Dismiss buttons, `role="status"`, no inner card. To keep an
 * org that pushes many packs from stacking an unbounded wall of bars at boot,
 * only the first `MAX_VISIBLE_ROWS` render individually; the rest collapse into
 * one summary row that points at the Plugins view.
 */

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { OptInDistributionDto } from "@repo/api/src/types/distribution";
import { useCallback, useEffect, useRef, useState } from "react";
import { HARNESS_AUTO } from "../../shared/install-run-contract";
import { normalizePackId } from "../../shared/normalize-pack-id";

// How many opt-in rows render individually before the remainder collapse into a
// single "N more available" summary row. Keeps a multi-pack org push from
// stacking an unbounded column of bars above the content viewport at boot.
const MAX_VISIBLE_ROWS = 2;

export function OptInDistributionsBanner() {
  const [pending, setPending] = useState<OptInDistributionDto[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Distribution ids the user has already accepted/dismissed. Excluded from
  // future merges so a reconnect re-push does not resurrect a handled row.
  const handledIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = window.desktopApi?.onDistributionsOptInAvailable?.(
      (distributions) => {
        setPending(snapshotDistributions(distributions, handledIds.current));
      }
    );
    return () => unsubscribe?.();
  }, []);

  const dismiss = useCallback((id: string) => {
    handledIds.current.add(id);
    setErrors((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPending((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // FEA-4050: an explicit user dismiss must persist durably so the reconcile
  // does not re-push the same pack after an app restart. This wraps the
  // in-session `dismiss` (used by the accept path too) with a fire-and-forget
  // durable record. Persist FIRST from the id we already hold, then update the
  // in-memory state — a failed IPC still hides the row for the session and the
  // main-process guard tolerates a not-connected decline. The accept path keeps
  // calling bare `dismiss` (a successful install is not a decline).
  const declineAndDismiss = useCallback(
    (id: string) => {
      // Fire-and-forget: the durable record is best-effort and the row is
      // hidden regardless. Swallow a rejection so a failed persist never
      // surfaces as an unhandled promise rejection (the reconcile still
      // re-pushes on next launch if the decline didn't persist — no data loss,
      // just the pre-fix behavior for that one pack).
      window.desktopApi?.db?.declineDistribution?.(id).catch(() => {
        // intentionally ignored — see comment above
      });
      dismiss(id);
    },
    [dismiss]
  );

  const accept = useCallback(
    async (dist: OptInDistributionDto) => {
      const api = window.desktopApi?.db;
      if (!api) {
        return;
      }
      // Coaching packs live in the managed coaching-packs store and are
      // copied/activated from a presigned asset zip by the main-process
      // coaching-pack installer. Route them through the dedicated
      // `coachingInstall(dist.id)` bridge; only generic (plugin/skill/command)
      // distributions resolve to a local pack id via `catalogInstall`.
      const isCoaching = dist.catalogItem.coaching === true;
      let packId = "";
      if (!isCoaching) {
        packId = normalizePackId(dist.catalogItem.name);
        if (!packId) {
          setErrors((prev) => ({
            ...prev,
            [dist.id]: installFailureMessage(dist.catalogItem.name),
          }));
          return;
        }
      }
      setInstalling(dist.id);
      setErrors((prev) => {
        if (!(dist.id in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[dist.id];
        return next;
      });
      try {
        if (isCoaching) {
          await api.coachingInstall(dist.id);
        } else {
          // ISS-5123: the generic path installs by a pack id derived from
          // renderer-held state and never names the distribution, so nothing in
          // it would notice that the org withdrew this offer after the row was
          // pushed. Ask the cloud first; a rejection keeps the row with an
          // inline error instead of installing a pack no longer on offer.
          // (`coachingInstall` needs no equivalent — it revalidates by id in
          // main before it touches the asset.) Called WITHOUT optional chaining
          // on purpose: against a preload too old to expose it, the TypeError
          // lands in the catch below and the install is refused — fail closed.
          await api.ensureDistributionAssigned(dist.id);
          await api.catalogInstall(packId, HARNESS_AUTO);
        }
        dismiss(dist.id);
      } catch {
        // Keep the row visible with an inline, actionable error so a failed
        // install is distinguishable from a successful one (do NOT dismiss on
        // failure). We deliberately do not surface the raw error.message —
        // it's engine-internal and not something the user can act on.
        setErrors((prev) => ({
          ...prev,
          [dist.id]: installFailureMessage(dist.catalogItem.name),
        }));
      } finally {
        setInstalling(null);
      }
    },
    [dismiss]
  );

  if (pending.length === 0) {
    return null;
  }

  const visible = pending.slice(0, MAX_VISIBLE_ROWS);
  const overflow = pending.length - visible.length;

  return (
    <div className="shrink-0" data-testid="opt-in-banner">
      {visible.map((dist) => (
        <OptInDistributionRow
          error={errors[dist.id]}
          id={dist.id}
          installing={installing === dist.id}
          key={dist.id}
          label={describeDistribution(dist)}
          onAccept={() => accept(dist)}
          onDismiss={() => declineAndDismiss(dist.id)}
        />
      ))}
      {overflow > 0 ? (
        <div
          className="flex shrink-0 items-center justify-center gap-3 border-b px-4 py-2 text-sm"
          data-testid="opt-in-overflow"
          role="status"
        >
          <span className="truncate">
            {overflow === 1
              ? "1 more shared item is available in Plugins."
              : `${overflow} more shared items are available in Plugins.`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

type OptInDistributionRowProps = {
  id: string;
  label: string;
  installing: boolean;
  error: string | undefined;
  onAccept: () => void;
  onDismiss: () => void;
};

/**
 * One opt-in distribution rendered as a sibling-shaped app banner row: a single
 * centered line of provenance/kind copy plus Accept/Dismiss, matching the other
 * AppShell banners. The disabled state is scoped to this row's own in-flight
 * install so accepting one pack never greys out another's controls.
 */
function OptInDistributionRow({
  id,
  label,
  installing,
  error,
  onAccept,
  onDismiss,
}: OptInDistributionRowProps) {
  return (
    <div
      className="flex shrink-0 items-center justify-center gap-3 border-b px-4 py-2 text-sm"
      data-testid={`opt-in-row-${id}`}
      role="status"
    >
      <span className="min-w-0 truncate">
        {error ? (
          <span className="text-destructive" data-testid={`opt-in-error-${id}`}>
            {error}
          </span>
        ) : (
          label
        )}
      </span>
      <div className="flex shrink-0 gap-2">
        <Button disabled={installing} onClick={onAccept} size="sm">
          {installing ? "Installing…" : "Accept & install"}
        </Button>
        <Button
          disabled={installing}
          onClick={onDismiss}
          size="sm"
          variant="ghost"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * Apply an authoritative snapshot of what the org currently offers.
 *
 * ISS-5123: this REPLACES the pending set rather than union-merging into it. A
 * union could only ever grow — an offer the admin withdraws disappears from the
 * reconcile payload, and under a merge the revoked row stayed on screen and
 * stayed actionable. Main now pushes the snapshot on every reconcile including
 * the empty one, so absence from `incoming` is precisely how revocation reaches
 * the renderer.
 *
 * Rows the user has already accepted or dismissed this session stay suppressed
 * via `handledIds`, so a reconnect re-push still cannot resurrect a handled row.
 */
function snapshotDistributions(
  incoming: OptInDistributionDto[],
  handledIds: Set<string>
): OptInDistributionDto[] {
  return incoming.filter((dist) => !handledIds.has(dist.id));
}

// Human-readable noun for a distribution's kind. `targetKind` is a plugin/skill/
// command/agent/hook/mcp value (version-skew safe: an unknown/absent kind falls
// back to the generic "item"), but a coaching pack comes through the same push,
// so coaching wins over the raw kind — a coaching pack must not announce itself
// as a plugin.
function kindNoun(dist: OptInDistributionDto): string {
  if (dist.catalogItem.coaching === true) {
    return "coaching pack";
  }
  const kind = dist.catalogItem.targetKind;
  if (kind === "mcp") {
    return "MCP server";
  }
  if (kind && KNOWN_KIND_NOUNS.has(kind)) {
    return kind;
  }
  return "item";
}

// Provenance + kind copy for one row. On startup on the Sessions list the bare
// name gives no context, so the row carries who shared it and what it is — the
// context the Plugins page used to supply around the bare name.
function describeDistribution(dist: OptInDistributionDto): string {
  return `Your organization shared the ${dist.catalogItem.name} ${kindNoun(dist)} with you.`;
}

// Actionable, user-facing install-failure copy. Deliberately does not name our
// internal "pack id" and does not leak the raw engine error — it tells the user
// what they can do next.
function installFailureMessage(name: string): string {
  return `Couldn't install ${name}. Try again, or ask your admin to re-share it.`;
}

const KNOWN_KIND_NOUNS = new Set([
  "plugin",
  "skill",
  "command",
  "agent",
  "hook",
]);
