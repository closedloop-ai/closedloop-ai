import { useEffect, useState } from "react";
import { z } from "zod";

/**
 * The configured web-app origin, plus whether that answer is SETTLED.
 *
 * ISS-5366 review: `origin: null` had to carry two incompatible meanings — "the
 * settings read has not landed yet" and "there is no usable configured origin".
 * A caller gating a navigable affordance on it therefore rendered its
 * UNAVAILABLE state during the load window, asserting that a destination was
 * unreachable while it was merely unresolved. `isResolved` separates them:
 * `false` means not known yet, `true` means the read finished and this is the
 * answer.
 */
export type WebAppOriginResolution = Readonly<{
  origin: string | null;
  isResolved: boolean;
}>;

/**
 * The settled origin, cached process-wide.
 *
 * Every hook instance used to run its own `getSettings` and start from `null`,
 * so every mount re-opened the same window between first paint and the read
 * landing. A settled value seeds the next mount's state SYNCHRONOUSLY, which
 * removes the window entirely for every mount after the first.
 */
let settledOrigin: { value: string | null } | null = null;

/** The in-flight read, so concurrent mounts share one settings IPC. */
let inFlightOrigin: Promise<string | null> | null = null;

function readOriginOnce(): Promise<string | null> {
  if (inFlightOrigin) {
    return inFlightOrigin;
  }
  const readSettings = window.desktopApi?.getSettings;
  if (!readSettings) {
    // No bridge (a partial test stub, or a renderer mounted outside Electron):
    // the origin is unknowable. That is SETTLED — it will never arrive — so the
    // pills go inert rather than waiting forever on a read that is not coming.
    settledOrigin = { value: null };
    return Promise.resolve(null);
  }
  const pending = readSettings()
    .then((settings) => {
      const value = readWebAppOrigin(settings);
      settledOrigin = { value };
      return value;
    })
    .catch(() => {
      // An unreadable settings store leaves the origin UNUSABLE. Guessing
      // production here is what produced the cross-tenant link below.
      settledOrigin = { value: null };
      return null;
    })
    .finally(() => {
      inFlightOrigin = null;
    });
  inFlightOrigin = pending;
  return pending;
}

/**
 * Test seam: drop the process-wide cache so one test's resolved origin does not
 * leak into the next test's first render.
 */
export function resetWebAppOriginCacheForTests(): void {
  settledOrigin = null;
  inFlightOrigin = null;
}

/**
 * The web app origin this desktop is configured to talk to (ISS-4898), or
 * `null` once resolved with nothing usable.
 *
 * A desktop can be pointed at production, a stage host, or a local dev server
 * through its gateway profile (`webAppOrigin` in the settings store, edited on
 * Settings → Connection), and the identity — including the org slug — comes from
 * whichever cloud that profile names. Building a link against a hardcoded
 * production origin would therefore hand a stage user a prod URL for a stage
 * org: a pill that looks live and lands nowhere, which is the exact failure this
 * row's design has spent three tickets avoiding.
 *
 * FAILS UNRESOLVED, NOT TO PRODUCTION (wongk + codex review). The earlier
 * version seeded state with `DEFAULT_WEB_APP_ORIGIN` and kept it on a failed or
 * malformed read. Identity resolves on its own schedule, so on a stage build
 * that made the window between mount and the settings read settling — and,
 * permanently, any settings-IPC failure — produce an ALLOWLISTED PRODUCTION link
 * carrying a NON-PRODUCTION org slug: a live-looking pill that opens the wrong
 * tenant's cloud. Returning `null` in both cases keeps the pill from linking
 * until the configured origin is actually known.
 *
 * `origin: null` therefore still means exactly one thing to a caller: do not
 * build a URL. There is no state in which this hook returns a guessed origin.
 * ISS-5366 adds `isResolved` so a caller can also tell "not yet" from "not at
 * all" and avoid rendering its unavailable state over a pending read.
 *
 * The cache is stale-while-revalidate rather than write-once: a cached value
 * seeds the first render and the mount still re-reads behind it, so an origin
 * edited on Settings → Connection is picked up on the next mount instead of
 * being pinned for the life of the process.
 */
export function useWebAppOrigin(): WebAppOriginResolution {
  const [resolution, setResolution] = useState<WebAppOriginResolution>(
    initialOriginResolution
  );

  useEffect(() => {
    let cancelled = false;
    readOriginOnce()
      .then((origin) => {
        if (!cancelled) {
          setResolution({ origin, isResolved: true });
        }
      })
      // `readOriginOnce` settles its own read failures to `null`, so this arm
      // is unreachable in practice. It is still the honest handler: a rejection
      // that somehow escaped would leave the resolution PENDING forever, and a
      // caller waiting on `isResolved` would hold its loading state for the life
      // of the view. Settling to "resolved, no origin" degrades to the same
      // inert pills every other failure path produces.
      .catch(() => {
        if (!cancelled) {
          setResolution({ origin: null, isResolved: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return resolution;
}

function initialOriginResolution(): WebAppOriginResolution {
  if (settledOrigin) {
    return { origin: settledOrigin.value, isResolved: true };
  }
  return { origin: null, isResolved: false };
}

/**
 * `getSettings` is bridged as `unknown` (the store is a loose record), so the
 * one field this needs is validated rather than cast. A blank, malformed, or
 * non-http(s) value resolves to `null` — an unusable configured value is not
 * evidence that production is the right destination.
 */
const webAppOriginSettingsSchema = z
  .object({ webAppOrigin: z.string().trim().min(1) })
  .partial();

function readWebAppOrigin(settings: unknown): string | null {
  const parsed = webAppOriginSettingsSchema.safeParse(settings);
  const configured = parsed.success ? parsed.data.webAppOrigin : undefined;
  if (!configured) {
    return null;
  }
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
