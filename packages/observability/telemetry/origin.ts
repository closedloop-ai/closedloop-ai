// ---------------------------------------------------------------------------
// Origin — identifies which service process emitted a telemetry event.
// Resolved once at module load from DD_SERVICE; never re-read.
// ---------------------------------------------------------------------------

export const Origin = {
  Desktop: "desktop",
  Api: "api",
  Relay: "relay",
  Unknown: "unknown",
} as const;

export type Origin = (typeof Origin)[keyof typeof Origin];

// Whitelist of origins that identify a real service process.
// Excludes `Origin.Unknown` — that value is the fallback sentinel for
// misconfigured/absent `DD_SERVICE`, not a valid service identity. Exported
// so `log.ts`'s `buildEntry()` meta-override check and this module-load
// `DD_SERVICE` match share a single source of truth.
export const KNOWN_ORIGINS: readonly Origin[] = Object.values(Origin).filter(
  (v) => v !== Origin.Unknown
);

function resolveOrigin(): Origin {
  const ddService = process.env.DD_SERVICE;

  const matched = KNOWN_ORIGINS.find((o) => o === ddService);

  if (matched !== undefined) {
    return matched;
  }

  // Use console.warn directly to avoid circular import with ../log.
  // Guarded to server-only: in browser bundles DD_SERVICE is never defined
  // (not a NEXT_PUBLIC_ var), so firing the warning on every client page load
  // would pollute end-user DevTools consoles with an ops-level signal.
  if (typeof window === "undefined") {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "telemetry.origin_fallback",
        message:
          "observability: DD_SERVICE did not match a known origin; defaulting to 'unknown'",
        DD_SERVICE: ddService,
      })
    );
  }

  return Origin.Unknown;
}

export const ORIGIN: Origin = resolveOrigin();
