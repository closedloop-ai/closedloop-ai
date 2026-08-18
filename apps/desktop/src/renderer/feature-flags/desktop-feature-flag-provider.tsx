import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { FEATURE_FLAGS } from "../../shared/feature-flags";

type DesktopFlagState = {
  key: string;
  value: boolean;
};

/**
 * Desktop shell adapter for the `@repo/app` feature-flag port (FEA-1514).
 *
 * Until PostHog is wired into the desktop renderer, unknown/shared flags still
 * resolve from the build type: ENABLED in an unpackaged dev build and DISABLED
 * in a packaged release. Desktop-owned flags resolve from the settings registry
 * defaults until persisted settings arrive, then from the persisted values.
 * This keeps default-off local features from briefly mounting in dev while
 * preserving the dev fallback for shared UI flags such as Branches.
 *
 * `app.isPackaged` (main process) is the authoritative signal, surfaced on the
 * runtime-status IPC payload. It defaults to DISABLED until the async fetch
 * resolves, so a packaged build never briefly flashes gated UI; when PostHog
 * lands here this whole adapter is replaced by a posthog-backed one, like
 * `posthogFeatureFlagAdapter` in apps/app.
 */
export function DesktopFeatureFlagProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [flagsEnabled, setFlagsEnabled] = useState(false);
  const [desktopFlags, setDesktopFlags] = useState<Record<string, boolean>>(
    () => ({ ...DESKTOP_FLAG_DEFAULTS })
  );
  // ISS-5037: has the FIRST `getAllFlags` settled? Before it does, every
  // desktop flag reads its registry default, which for a default-OFF flag is
  // indistinguishable from "the user turned it off". That is the right posture
  // for SHOWING gated UI (stay dark), but not for a one-way decision like
  // redirecting a route away — see `App.tsx`'s Labs gate.
  const [desktopFlagsResolved, setDesktopFlagsResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refreshDesktopFlags = () => {
      window.desktopApi
        .getAllFlags()
        .then((payload) => {
          if (cancelled) {
            return;
          }
          setDesktopFlags(readDesktopFlags(payload));
          setDesktopFlagsResolved(true);
        })
        .catch(() => {
          if (!cancelled) {
            setDesktopFlags({ ...DESKTOP_FLAG_DEFAULTS });
            // Settled, even though it settled on the defaults: an unreachable
            // bridge must not hold a gated route on its loading state forever.
            setDesktopFlagsResolved(true);
          }
        });
    };
    window.desktopApi
      .getRuntimeStatus()
      .then((status) => {
        if (!cancelled) {
          setFlagsEnabled(isUnpackagedBuild(status));
        }
      })
      .catch(() => {
        // Unreachable status → stay prod-safe (all flags disabled).
      });
    refreshDesktopFlags();
    window.desktopApi.onFlagsChanged?.(refreshDesktopFlags);
    return () => {
      cancelled = true;
    };
  }, []);

  const adapter = useMemo<FeatureFlagAdapter>(
    () => ({
      useFeatureFlagEnabled: (key) => {
        if (Object.hasOwn(DESKTOP_FLAG_DEFAULTS, key)) {
          return desktopFlags[key] === true;
        }
        return flagsEnabled;
      },
    }),
    [desktopFlags, flagsEnabled]
  );

  return (
    <DesktopFeatureFlagsResolvedContext value={desktopFlagsResolved}>
      <FeatureFlagAdapterProvider adapter={adapter}>
        {children}
      </FeatureFlagAdapterProvider>
    </DesktopFeatureFlagsResolvedContext>
  );
}

/**
 * ISS-5037 — whether the desktop flag snapshot has actually arrived.
 *
 * Defaults to `false` (and to `false` with no provider, e.g. a unit test that
 * mounts a bare subtree), so a caller that withholds a one-way decision until
 * this is true degrades to withholding it — never to committing it early.
 */
export function useDesktopFeatureFlagsResolved(): boolean {
  return useContext(DesktopFeatureFlagsResolvedContext);
}

const DesktopFeatureFlagsResolvedContext = createContext(false);

const DESKTOP_FLAG_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  FEATURE_FLAGS.map((flag) => [flag.key, flag.default])
);

function isUnpackagedBuild(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    (status as { isPackaged?: unknown }).isPackaged === false
  );
}

function readDesktopFlags(payload: unknown): Record<string, boolean> {
  return { ...DESKTOP_FLAG_DEFAULTS, ...extractDesktopFlags(payload) };
}

function extractDesktopFlags(payload: unknown): Record<string, boolean> {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const flags = (payload as { flags?: unknown }).flags;
  if (!Array.isArray(flags)) {
    return {};
  }
  return Object.fromEntries(
    flags.filter(isDesktopFlagState).map((flag) => [flag.key, flag.value])
  );
}

function isDesktopFlagState(value: unknown): value is DesktopFlagState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && typeof record.value === "boolean";
}
