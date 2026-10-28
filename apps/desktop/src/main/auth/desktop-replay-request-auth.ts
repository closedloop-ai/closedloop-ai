import {
  DESKTOP_REPLAY_API_ORIGINS,
  DESKTOP_REPLAY_PATH_PREFIX,
  DESKTOP_REPLAY_SNAPSHOT_PATH,
} from "@repo/api/src/types/desktop-session-replay-pilot";
import type { Session } from "electron";
import { z } from "zod";
import type { DesktopReplayRecordingReport } from "../../shared/desktop-session-replay-bridge.js";

const REPLAY_SNAPSHOT_PATHNAME = `${DESKTOP_REPLAY_PATH_PREFIX}${DESKTOP_REPLAY_SNAPSHOT_PATH}`;
const AUTHORIZATION_HEADER = /^authorization$/i;

/** Electron match patterns for the replay snapshot path on every replay origin. */
export const DESKTOP_REPLAY_REQUEST_URL_PATTERNS =
  DESKTOP_REPLAY_API_ORIGINS.map(
    (origin) => `${origin}${REPLAY_SNAPSHOT_PATHNAME}*`
  );

export type DesktopReplayRequestAuthDeps = {
  /**
   * The signed-in desktop session's access token when `origin` minted it, or
   * null when signed out or the token came from another origin.
   */
  getAccessToken: (origin: string) => Promise<string | null>;
  /** The install's configured API origin; a token is sent nowhere else. */
  resolveApiOrigin: () => string;
  /**
   * ISS-12257: whether the renderer's replay recording started under main's
   * current sign-in state and auth generation
   * ({@link createDesktopReplayRecordingFence}).
   */
  isRecordingSignInCurrent: () => boolean;
};

export type DesktopReplayRequest = {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
};

/**
 * ISS-12222: lets the replay ingress stamp a signed-in install's replays with
 * its user. Main attaches the desktop session's access token to the renderer's
 * replay snapshot requests, so the renderer and its posthog-js client never
 * hold a credential. Electron keeps one `onBeforeSendHeaders` listener per
 * session, and a later registration replaces this one.
 */
export function installDesktopReplayRequestAuth(
  options: DesktopReplayRequestAuthDeps & { session: Session }
): void {
  options.session.webRequest.onBeforeSendHeaders(
    { urls: DESKTOP_REPLAY_REQUEST_URL_PATTERNS },
    (details, callback) => {
      authorizeDesktopReplayRequest(details, options).then(
        (requestHeaders) =>
          callback(requestHeaders ? { requestHeaders } : { cancel: true }),
        () =>
          callback(
            options.isRecordingSignInCurrent()
              ? { requestHeaders: details.requestHeaders }
              : { cancel: true }
          )
      );
    }
  );
}

/**
 * The headers a request leaves with: the access token added to a snapshot POST
 * on the configured API origin when that origin minted it, and every other
 * request untouched. Null refuses a snapshot POST recorded under the other
 * sign-in state (ISS-12257), including one whose state flipped while its token
 * was read.
 */
export async function authorizeDesktopReplayRequest(
  request: DesktopReplayRequest,
  deps: DesktopReplayRequestAuthDeps
): Promise<Record<string, string> | null> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== REPLAY_SNAPSHOT_PATHNAME ||
    url.origin !== deps.resolveApiOrigin()
  ) {
    return request.requestHeaders;
  }
  if (!deps.isRecordingSignInCurrent()) {
    return null;
  }
  const accessToken = await deps.getAccessToken(url.origin);
  if (!deps.isRecordingSignInCurrent()) {
    return null;
  }
  if (!accessToken) {
    return request.requestHeaders;
  }
  const headers = Object.fromEntries(
    Object.entries(request.requestHeaders).filter(
      ([name]) => !AUTHORIZATION_HEADER.test(name)
    )
  );
  return { ...headers, Authorization: `Bearer ${accessToken}` };
}

/**
 * ISS-12257: main's sign-in state flips before the renderer hears of it, and a
 * replay batch takes the identity of the moment it leaves, so a batch the
 * renderer recorded before a flip could leave with the identity from after
 * it. Replay batches are refused from each flip until the renderer, after it,
 * has discarded the old recording's unsent batches and reported the next
 * recording. A report counts only for the auth generation it echoes, so one
 * the renderer sent before a flip cannot reopen the fence after it, even once
 * a second flip has brought main back to the same sign-in state.
 */
export function createDesktopReplayRecordingFence(
  isSignedIn: () => boolean,
  authGeneration: () => number | undefined
) {
  let recording: DesktopReplayRecordingReport | null = null;
  return {
    /** The renderer's report: anything but a recording report is ignored. */
    report: (payload: unknown): void => {
      const report = recordingReportSchema.safeParse(payload);
      if (report.success) {
        recording = report.data;
      }
    },
    isCurrent: () =>
      recording?.authGeneration !== undefined &&
      recording.authGeneration === authGeneration() &&
      recording.signedIn === isSignedIn(),
  };
}

const recordingReportSchema = z.object({
  signedIn: z.boolean(),
  authGeneration: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<DesktopReplayRecordingReport>;
