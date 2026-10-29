"use client";

import { useUnreadInboxNotificationsCount } from "@liveblocks/react";

/**
 * The unread inbox count WITHOUT suspending (ISS-9734, PLN-2016 D5).
 *
 * `./hooks` re-exports Liveblocks' suspense build, whose count hook suspends
 * until the first answer, so a sidebar row reading it would have to wait inside
 * a boundary. This wraps the non-suspense hook instead: its result says which
 * state the read is in — `{ isLoading: true }`, `{ isLoading: false, count }`,
 * or `{ isLoading: false, error }` — so a caller can keep a loading or failed
 * read apart from a real count.
 *
 * A named wrapper rather than a re-export because this package forbids barrel
 * modules; the one file that re-exports Liveblocks (`./hooks`) is the suspense
 * build this exists to avoid.
 */
export function useUnreadInboxCount(): ReturnType<
  typeof useUnreadInboxNotificationsCount
> {
  return useUnreadInboxNotificationsCount();
}
