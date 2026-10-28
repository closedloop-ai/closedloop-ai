import type { InboxNotificationSource } from "../lib/inbox-notification-source";

/**
 * The public contract of {@link InboxSurfaceV2} (ISS-9406).
 *
 * ONE prop, and it is required. ISS-9216 AC2 and ISS-9218's `notSupported` bar
 * have nothing to apply to here, because there is nothing optional to omit: the
 * transport state is the only thing a host knows that the surface cannot.
 *
 * ISS-9216's other half — a surface owns its pagination — has nothing to own
 * yet: no shell has ever offered a way past the inbox read's first page. See
 * {@link InboxTransportStatus.Ready}.
 */
export type InboxSurfaceV2Props = {
  /** What this host's notification transport can currently say. */
  source: InboxNotificationSource;
};
