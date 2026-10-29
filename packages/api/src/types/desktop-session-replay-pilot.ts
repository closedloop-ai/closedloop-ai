/**
 * Desktop session replay (ISS-11838): the keyless replay client in the desktop
 * renderer posts to a neutral path on our own API host (ISS-11866 D2/D7, C2),
 * first measured by the ISS-11944 stage pilot. The renderer records only when
 * its configured API origin is one of these, and its `connect-src` admits
 * exactly these. The API serves the snapshot path on stage and prod (ISS-11946).
 */
export const DESKTOP_REPLAY_API_ORIGINS = [
  "https://api.closedloop.ai",
  "https://api.stage.example",
] as const;

/** ISS-11866 D7: a neutral path on the API host, never a vendor or tracker name. */
export const DESKTOP_REPLAY_PATH_PREFIX = "/r";

/**
 * posthog-js posts snapshots to `/s/`. The pilot overrides it without the
 * trailing slash because Next.js redirects a trailing-slash URL to its
 * slashless form by default, and the route lives in `apps/api`.
 */
export const DESKTOP_REPLAY_SNAPSHOT_PATH = "/s";

/**
 * ISS-11838 masking ruling: wraps the branch file-diff viewer so the replay
 * block selector can name it. react-diff-viewer-continued emits only generated
 * emotion classes and puts diff lines in `td > div/ins/del`, outside `pre`.
 */
export const BRANCH_FILE_DIFF_CLASS = "branch-file-diff";
