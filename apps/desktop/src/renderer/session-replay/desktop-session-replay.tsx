import type * as DesktopSessionReplayClient from "@repo/analytics/desktop-session-replay";
import { DESKTOP_SESSION_REPLAY_FLAG_KEY } from "@repo/api/src/types/desktop-feature-flags";
import {
  DESKTOP_REPLAY_API_ORIGINS,
  DESKTOP_REPLAY_PATH_PREFIX,
} from "@repo/api/src/types/desktop-session-replay-pilot";
import { isUuidV4 } from "@repo/api/src/types/onboarding-analytics";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { DesktopAuthStatus } from "../../shared/contracts";
import type { DesktopReplayRecordingReport } from "../../shared/desktop-session-replay-bridge";
import { useRuntimeStatusValue } from "../hooks/use-runtime-status-poll";
import { RECORD_ID_ROUTE_PATTERNS } from "../navigation/route-table";
import { useDesktopAuthOptional } from "../shared-agent-sessions/desktop-auth-provider";

const runtimeStatusSchema = z.object({
  apiOrigin: z.string(),
  nodeUuid: z.string().refine(isUuidV4),
});

/**
 * ISS-11838: records this renderer with the keyless, replay-only client while
 * the default-off `desktop-session-replay` gate is open, signed in (the user's
 * assignment) or signed out (the install's `node_uuid` assignment, ISS-11945).
 * With the gate closed posthog-js is never loaded. The distinct id is the
 * install's `node_uuid` in both states, the one id the ISS-11946 ingress
 * accepts; for a signed-in install the ingress replaces it with the user's
 * Clerk id, from the access token main attaches (ISS-12222). Signing in or out
 * therefore restarts the recording as a new session, and discards what the old
 * one had not sent (ISS-12257). Recording waits for main's auth state, whose
 * auth generation each recording reports to main.
 */
export function DesktopSessionReplay(): ReactNode {
  const enabled = useFeatureFlagEnabled(DESKTOP_SESSION_REPLAY_FLAG_KEY);
  const authState = useDesktopAuthOptional()?.state;
  const signedIn = authState?.status === DesktopAuthStatus.Authenticated;
  const authGeneration = authState?.authGeneration;
  const client = useRef<ReplayClient | null>(null);
  useDiscardOnSignInFlip(authGeneration, client);
  return enabled && authGeneration !== undefined ? (
    <RecordWhileGateOpen
      authGeneration={authGeneration}
      client={client}
      key={String(signedIn)}
      signedIn={signedIn}
    />
  ) : null;
}

/**
 * Applying a saved profile changes the API origin without a reload, so the
 * origin is read from the shared runtime-status poll and a change stops the
 * recording before any restart.
 */
function RecordWhileGateOpen({
  authGeneration,
  client,
  signedIn,
}: {
  authGeneration: number;
  client: RefObject<ReplayClient | null>;
  signedIn: boolean;
}): null {
  // Only a change of sign-in state remounts this. A later generation without
  // one means main flipped away and back while this recording ran, so it keeps
  // reporting the generation it started under and main keeps refusing it.
  const [startedUnder] = useState(authGeneration);
  const target = useRuntimeStatusValue(true, readReplayTarget);
  const apiHost = target?.apiHost;
  const distinctId = target?.distinctId;

  useEffect(() => {
    if (!(apiHost && distinctId)) {
      return;
    }
    const replay: ReplayHandle = { cancelled: false };
    startReplay(
      replay,
      client,
      { apiHost, distinctId, recordIdRoutes: RECORD_ID_ROUTE_PATTERNS },
      { signedIn, authGeneration: startedUnder }
    ).catch(() => undefined);
    return () => {
      replay.cancelled = true;
      replay.stop?.();
    };
  }, [apiHost, distinctId, client, signedIn, startedUnder]);

  return null;
}

async function startReplay(
  replay: ReplayHandle,
  client: RefObject<ReplayClient | null>,
  options: DesktopSessionReplayClient.DesktopSessionReplayOptions,
  recording: DesktopReplayRecordingReport
): Promise<void> {
  // Code-split so a launch with the gate closed never loads posthog-js.
  const loaded = await import("@repo/analytics/desktop-session-replay");
  client.current = loaded;
  if (replay.cancelled) {
    return;
  }
  const previousBatchesAnswered = loaded.waitForSentDesktopReplayBatches();
  loaded.startDesktopSessionReplay(options);
  replay.stop = loaded.stopDesktopSessionReplay;
  // Main refuses replay batches until it hears which sign-in state this
  // recording runs under, and must not hear it while a batch recorded before
  // can still reach it. A batch it refuses meanwhile is retried by posthog-js.
  await previousBatchesAnswered;
  if (!replay.cancelled) {
    await window.desktopApi.reportDesktopReplayRecording?.(recording);
  }
}

/** Where and as whom to record, or null when this API origin does not record. */
function readReplayTarget(
  status: unknown
): Omit<
  DesktopSessionReplayClient.DesktopSessionReplayOptions,
  "recordIdRoutes"
> | null {
  const runtimeStatus = runtimeStatusSchema.safeParse(status);
  if (!runtimeStatus.success) {
    return null;
  }
  const apiHost = resolveReplayApiHost(runtimeStatus.data.apiOrigin);
  return apiHost === null
    ? null
    : { apiHost, distinctId: runtimeStatus.data.nodeUuid };
}

/** The posthog-js `api_host`, or null when the API is not a replay origin. */
function resolveReplayApiHost(apiOrigin: string): string | null {
  let origin: string;
  try {
    origin = new URL(apiOrigin).origin;
  } catch {
    return null;
  }
  const replayOrigin = DESKTOP_REPLAY_API_ORIGINS.find(
    (candidate) => candidate === origin
  );
  return replayOrigin === undefined
    ? null
    : `${replayOrigin}${DESKTOP_REPLAY_PATH_PREFIX}`;
}

/** Recording at one target: cancelled when the target changes or the gate closes, stoppable once started. */
type ReplayHandle = { cancelled: boolean; stop?: () => void };

type ReplayClient = typeof DesktopSessionReplayClient;

/**
 * Keyed on main's auth generation, not the sign-in state, so a sign-out and
 * sign-in the renderer hears only the last of still discard the recording that
 * spans them. A layout effect: it runs before the passive effects that stop the
 * old recording and start the next one, so it drops only what the old one
 * captured.
 */
function useDiscardOnSignInFlip(
  authGeneration: number | undefined,
  client: RefObject<ReplayClient | null>
): void {
  const recordedGeneration = useRef(authGeneration);
  useLayoutEffect(() => {
    if (recordedGeneration.current === authGeneration) {
      return;
    }
    recordedGeneration.current = authGeneration;
    client.current?.discardDesktopSessionReplay();
  }, [authGeneration, client]);
}
