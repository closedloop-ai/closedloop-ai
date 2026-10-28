import type { MonitoredActivityTarget } from "./monitored-activity-target.ts";

/**
 * PLN-2061 M5: one target in a repository the organization does not track that
 * a session's run touched, read back off the session's retained
 * monitored-activity evidence (ISS-9182).
 *
 * `url` is ABSENT, never null, when the retained row carries no link — the same
 * omission `MonitoredActivityRetainedSnapshot.url` makes for a repository name
 * that cannot occupy a URL path. A consumer renders such an entry as plain text.
 */
export type SessionUntrackedRepositoryTarget = MonitoredActivityTarget & {
  url?: string;
};
