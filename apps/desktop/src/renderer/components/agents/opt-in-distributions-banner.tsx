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
 * Accept/dismiss are remembered for the lifetime of the view (`handledIds`) so a
 * cloud reconnect that re-pushes an already-handled distribution does not
 * resurrect a banner row the user already dealt with.
 */

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { OptInDistributionDto } from "@repo/api/src/types/distribution";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizePackId } from "../../../shared/normalize-pack-id";

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
        setPending((prev) =>
          mergeDistributions(prev, distributions, handledIds.current)
        );
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
            [dist.id]: "Could not resolve a pack id for this distribution.",
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
          await api.catalogInstall(packId, "auto");
        }
        dismiss(dist.id);
      } catch (error: unknown) {
        // Keep the row visible with an inline error so a failed install is
        // distinguishable from a successful one (do NOT dismiss on failure).
        const message =
          error instanceof Error ? error.message : "Install failed.";
        setErrors((prev) => ({ ...prev, [dist.id]: message }));
      } finally {
        setInstalling(null);
      }
    },
    [dismiss]
  );

  if (pending.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-2 border-border border-b bg-muted/40 p-3"
      data-testid="opt-in-banner"
    >
      <p className="font-medium text-sm">Plugins available for you</p>
      <ul className="flex flex-col gap-2">
        {pending.map((dist) => (
          <li
            className="flex flex-col gap-1 rounded-md border border-border bg-background p-2"
            data-testid={`opt-in-row-${dist.id}`}
            key={dist.id}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm">{dist.catalogItem.name}</span>
              <div className="flex shrink-0 gap-2">
                <Button
                  disabled={installing === dist.id}
                  onClick={() => accept(dist)}
                  size="sm"
                >
                  {installing === dist.id ? "Installing…" : "Accept & install"}
                </Button>
                <Button
                  disabled={installing === dist.id}
                  onClick={() => dismiss(dist.id)}
                  size="sm"
                  variant="ghost"
                >
                  Dismiss
                </Button>
              </div>
            </div>
            {errors[dist.id] ? (
              <p
                className="text-destructive text-xs"
                data-testid={`opt-in-error-${dist.id}`}
              >
                {errors[dist.id]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Union-merge incoming distributions by id, preserving existing entries and
 * dropping any id the user has already accepted/dismissed (`handledIds`) so a
 * reconnect re-push does not resurrect a handled banner row.
 */
function mergeDistributions(
  prev: OptInDistributionDto[],
  incoming: OptInDistributionDto[],
  handledIds: Set<string>
): OptInDistributionDto[] {
  const byId = new Map(prev.map((d) => [d.id, d]));
  for (const dist of incoming) {
    if (handledIds.has(dist.id)) {
      continue;
    }
    byId.set(dist.id, dist);
  }
  return [...byId.values()];
}
