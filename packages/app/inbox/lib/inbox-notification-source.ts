import type { InboxNotificationData } from "@liveblocks/client";

/**
 * ISS-9406 — the notification record `InboxSurfaceV2` consumes.
 *
 * Aliased rather than redeclared: the row components read the record directly,
 * so a parallel type would have to be converted back at the boundary. Nothing
 * in it is web specific — id, kind, `notifiedAt`, `readAt`, activities — and it
 * is the shape a desktop transport under PRD-702 owes this surface.
 */
export type InboxSurfaceNotification = InboxNotificationData;

/** What a host's notification transport is currently able to say. */
export const InboxTransportStatus = {
  /** A read is in flight. Never a zero and never the empty copy. */
  Loading: "loading",
  /**
   * This host cannot serve notifications at all right now. Distinct from
   * {@link InboxTransportStatus.Ready} with no records, which is the claim that
   * the reader genuinely has none.
   */
  Unavailable: "unavailable",
  /**
   * The read succeeded and `notifications` is what it returned — deliberately
   * NOT a claim of exhaustiveness. The inbox read is cursor-paged and reports
   * `hasFetchedAll`/`fetchMore`; no host has ever read either, so no shell
   * offers a way past the first page. Expressing that cap is a product decision
   * about an affordance that has never rendered; a host that gains one gets an
   * arm of its own rather than a silently truncated `Ready`.
   *
   * The word is this union's, not `complete-surface-contract.ts`'s: in that
   * shared vocabulary this read is `CompleteSurfaceState.Partial` — "a capped
   * page" — while its `Ready` asserts the whole population. ISS-10010 ruled the
   * cap is kept and unannounced, so this union offers no `Partial` arm to map
   * onto. The correspondence holds; the arm is simply not on offer here, and
   * that is a product ruling about this surface rather than licence for the
   * next capped one.
   */
  Ready: "ready",
} as const;
export type InboxTransportStatus =
  (typeof InboxTransportStatus)[keyof typeof InboxTransportStatus];

/**
 * The surface's only input.
 *
 * A union rather than a record plus flags: only the ready arm carries a
 * population, so "empty" is unstateable without a successful read behind it —
 * an unavailable transport rendering as "no notifications yet" is the collapse
 * this shape forbids. `markAllAsRead` sits on that arm for the same reason.
 */
export type InboxNotificationSource =
  | { readonly status: typeof InboxTransportStatus.Loading }
  | { readonly status: typeof InboxTransportStatus.Unavailable }
  | {
      readonly status: typeof InboxTransportStatus.Ready;
      /**
       * ONE page, per {@link InboxTransportStatus.Ready}. The surface's empty
       * render reads THIS field, so a transport reporting an empty page while
       * its own `unreadCount` is non-zero would draw "no notifications yet"
       * over a reader who has some — the collapse this union already forbids an
       * unavailable transport, reachable again through the cap.
       */
      readonly notifications: readonly InboxSurfaceNotification[];
      /**
       * Reader's own unread tally, as the host's transport reports it — never
       * re-derived from `notifications`, which would answer a different question
       * the moment a read is capped.
       */
      readonly unreadCount: number;
      /**
       * Reconciles the unread POPULATION through the host's transport — not
       * `notifications` above, which is one page. A transport that marks only
       * the records it holds makes this control's label false, so a second host
       * owes a command covering the reader's whole unread set, by whatever
       * means that host has. The web transport is pinned at both its seams:
       * `packages/collaboration/__tests__/inbox-mark-all-read-scope.test.ts`
       * for the wire form, and its `-hook` sibling for the react store the host
       * actually binds — the one layer holding records a page-scoped command
       * could narrow to.
       *
       * No runner holds a SECOND host to this yet.
       * `packages/app/inbox/__tests__/inbox-both-host-contract.ts` is where
       * that case would belong, and today it has no seam for it: its cases
       * inspect the DOM after a mount and none can drive a command or see what
       * a transport sent, so a page-scoped `markAllAsRead` would leave it
       * green. A host building one (PRD-702) owes that runner a command seam
       * as well as an answer.
       */
      readonly markAllAsRead: () => void;
    };

/** A constant, so a host cannot allocate a new one per render. */
export const INBOX_SOURCE_LOADING: InboxNotificationSource = {
  status: InboxTransportStatus.Loading,
};

/** The unavailable arm. */
export const INBOX_SOURCE_UNAVAILABLE: InboxNotificationSource = {
  status: InboxTransportStatus.Unavailable,
};
