// ---------------------------------------------------------------------------
// Origin — identifies which service process emitted a telemetry event.
// Resolved once at module load from DD_SERVICE; never re-read.
// ---------------------------------------------------------------------------

export const Origin = {
  Desktop: "desktop",
  Api: "api",
  Relay: "relay",
  Mcp: "mcp",
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
  const normalized = ddService?.startsWith("cl-")
    ? ddService.slice(3)
    : ddService;

  const matched = KNOWN_ORIGINS.find((o) => o === normalized);

  if (matched !== undefined) {
    return matched;
  }

  // Use console.warn directly to avoid circular import with ../log. That same
  // cycle is why the severity is a literal rather than `LogLevel.Warn`: log.ts
  // evaluates this module while its own consts are still in TDZ.
  // `status` is Datadog's reserved severity attribute and `level` is not, so
  // both are stamped, matching log.ts's own fallback warning — otherwise this
  // drain line's severity rests on per-service level remapping (ISS-6341).
  // Guarded to server-only: in browser bundles DD_SERVICE is never defined
  // (not a NEXT_PUBLIC_ var), so firing the warning on every client page load
  // would pollute end-user DevTools consoles with an ops-level signal.
  if (typeof window === "undefined") {
    console.warn(
      JSON.stringify({
        level: "warn",
        status: "warn",
        event: "telemetry.origin_fallback",
        message:
          "observability: DD_SERVICE did not match a known origin; defaulting to 'unknown'",
        DD_SERVICE: ddService,
        stripped: normalized,
      })
    );
  }

  return Origin.Unknown;
}

export const ORIGIN: Origin = resolveOrigin();
