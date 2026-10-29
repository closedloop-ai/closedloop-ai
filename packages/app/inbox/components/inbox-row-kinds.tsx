"use client";

import type { AssignmentNotificationProps } from "@repo/collaboration/client/assignment-notification";
import { AssignmentNotification } from "@repo/collaboration/client/assignment-notification";
import { AwaitingInputNotification } from "@repo/collaboration/client/awaiting-input-notification";
import type { MentionNotificationProps } from "@repo/collaboration/client/mention-notification";
import { MentionNotification } from "@repo/collaboration/client/mention-notification";
import { createContext, useContext } from "react";
import { createInboxRowKindRegistry } from "../lib/inbox-row-kind-registry";

/**
 * ISS-5010: whether the actor treatment is on, carried as context rather than as
 * a choice between two components. The registry below holds component TYPES, so
 * swapping one when the assignment lands would remount every affected row.
 *
 * Reading the gate once at the consumer also matters: a flag read falls through
 * to a localStorage read and JSON parse while it is unresolved, and a list
 * re-reading that per row would pay it once per notification.
 */
export const InboxActorRowsContext = createContext(false);

function AssignmentNotificationRow(props: AssignmentNotificationProps) {
  const showActor = useContext(InboxActorRowsContext);
  return <AssignmentNotification {...props} showActor={showActor} />;
}

function MentionNotificationRow(props: MentionNotificationProps) {
  const showActor = useContext(InboxActorRowsContext);
  return <MentionNotification {...props} showActor={showActor} />;
}

/**
 * The kinds the Inbox renders a row for, indexed by the record's own `kind`.
 *
 * ONE table for both sides of `inbox-complete-surface`, so neither the hazard
 * below nor the row identity above depends on which branch a reader is on, and
 * an ISS-5010 follow-on cannot be applied to one copy and missed on the other.
 *
 * Null-prototype and frozen (see `createInboxRowKindRegistry`): the key comes
 * off the wire, so an object literal would answer `"__proto__"` with
 * `Object.prototype` and hand it to React as this row's component type.
 */
export const INBOX_NOTIFICATION_KINDS = createInboxRowKindRegistry({
  $assignment: AssignmentNotificationRow,
  $awaitingInput: AwaitingInputNotification,
  $mention: MentionNotificationRow,
});
