/**
 * ISS-12420: volatile readiness buffer, not a durable outbox. Remove on first
 * transport attempt: ambiguous HTTP outcomes must never be retried without
 * server idempotency. A process exit loses pending events by design.
 */
import { randomUUID } from "node:crypto";
import { OnboardingAnalyticsDropReason } from "@closedloop-ai/telemetry-contract/app";
import {
  isUuidV4,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { DesktopAuthStatus } from "../../shared/contracts.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { onboardingDiscardTelemetry } from "../telemetry/onboarding-discard-telemetry.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { DesktopAnalyticsLaneEvent } from "./desktop-analytics-http-lane.js";

export const ONBOARDING_QUEUE_LIMIT = 100;
export const ONBOARDING_QUEUE_TTL_MS = 10 * 60 * 1000;

export type OnboardingAnalyticsDrop = {
  component: "onboarding_analytics";
  action: "event_dropped";
  reason: OnboardingAnalyticsDropReason;
  original_event: string;
  step: string | null;
  flow_id: string | null;
  queue_age_ms: number;
  app_version: string;
  drop_id: string;
};

type Ownership = {
  identity: SignedInUserIdentity | null;
  origin: string | undefined;
  revoked: OnboardingAnalyticsDropReason | null;
};

type Entry = {
  event: DesktopAnalyticsLaneEvent;
  ownership: Ownership;
  acceptedAt: number;
  diagnosed: boolean;
};

type QueueOptions = {
  getIdentity: () => SignedInUserIdentity | null;
  getAuthStatus: () => DesktopAuthStatus;
  getApiOrigin: () => string | undefined;
  getAppVersion: () => string;
  getReadyTarget: () => string | null;
  send: (
    event: DesktopAnalyticsLaneEvent,
    target: string,
    canStillSend: () => boolean
  ) => void;
};

export function isQueuedOnboardingEvent(
  event: DesktopAnalyticsLaneEvent
): boolean {
  // Generic page/button events are also in this taxonomy. Require their flow
  // witness so this change does not buffer unrelated product analytics.
  return (
    Object.values(OnboardingAnalyticsEvent).some(
      (name) => name === event.event
    ) && isUuidV4(event.properties?.[OnboardingAnalyticsProperty.FlowId])
  );
}

export function createOnboardingAnalyticsQueue(options: QueueOptions) {
  const entries: Entry[] = [];
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let ownership: Ownership | null = null;

  const diagnose = (entry: Entry, reason: OnboardingAnalyticsDropReason) => {
    if (entry.diagnosed) {
      return;
    }
    entry.diagnosed = true;
    const step = entry.event.properties?.[OnboardingAnalyticsProperty.Step];
    const flowId = entry.event.properties?.[OnboardingAnalyticsProperty.FlowId];
    const record: OnboardingAnalyticsDrop = {
      // Keep distinct discards distinct through GatewayLogger deduplication.
      drop_id: randomUUID(),
      component: "onboarding_analytics",
      action: "event_dropped",
      reason,
      original_event: entry.event.event,
      step: Object.values(OnboardingPhase).some((value) => value === step)
        ? String(step)
        : null,
      flow_id: isUuidV4(flowId) ? flowId : null,
      queue_age_ms: Math.max(0, Date.now() - entry.acceptedAt),
      app_version: options.getAppVersion(),
    };
    // PRD-793 explicitly approves flow_id in these local records; ISS-12421's
    // acceptance criteria require the keyless record below to be searchable by
    // it. No payload, account id, node id, credentials, or content enters
    // either sink.
    gatewayLog.info(record.component, JSON.stringify(record));
    // ISS-12421: the keyless OTLP lane, which does not depend on the
    // authenticated readiness this discard reports on.
    onboardingDiscardTelemetry.report({
      reason: record.reason,
      originalEvent: record.original_event,
      step: record.step,
      flowId: record.flow_id,
      queueAgeMs: record.queue_age_ms,
    });
  };

  const identityRefusal = (
    owner: Ownership
  ): OnboardingAnalyticsDropReason | null => {
    if (owner.revoked) {
      return owner.revoked;
    }
    const status = options.getAuthStatus();
    if (
      status === DesktopAuthStatus.SignedOut ||
      status === DesktopAuthStatus.RefreshFailed
    ) {
      return OnboardingAnalyticsDropReason.UserSignedOut;
    }
    const current = options.getIdentity();
    if (
      !(owner.identity && current) ||
      current.userId !== owner.identity.userId ||
      options.getApiOrigin() !== owner.origin
    ) {
      return OnboardingAnalyticsDropReason.IdentityChanged;
    }
    // The API scopes capture to the token's active organization; it cannot
    // safely deliver to an old org merely by naming the old target.
    if (current.organizationId !== owner.identity.organizationId) {
      return OnboardingAnalyticsDropReason.OrganizationMismatch;
    }
    return null;
  };

  const refusal = (entry: Entry): OnboardingAnalyticsDropReason | null => {
    const reason = identityRefusal(entry.ownership);
    if (reason) {
      entry.ownership.revoked = reason;
      return reason;
    }
    if (Date.now() - entry.acceptedAt >= ONBOARDING_QUEUE_TTL_MS) {
      return OnboardingAnalyticsDropReason.QueueExpired;
    }
    return null;
  };

  const canSend = (entry: Entry): boolean => {
    const reason = refusal(entry);
    if (reason) {
      diagnose(entry, reason);
    }
    return reason === null;
  };

  const refresh = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (disposed) {
      return;
    }
    if (ownership) {
      ownership.revoked = identityRefusal(ownership);
      if (ownership.revoked) {
        ownership = null;
      }
    }
    const target =
      options.getAuthStatus() === DesktopAuthStatus.Authenticated
        ? options.getReadyTarget()
        : null;
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index];
      if (!canSend(entry)) {
        entries.splice(index, 1);
      } else if (target) {
        entries.splice(index, 1);
        options.send(entry.event, target, () => canSend(entry));
      } else {
        index += 1;
      }
    }
    if (entries.length) {
      expiryTimer = setTimeout(
        refresh,
        Math.max(
          1,
          entries[0].acceptedAt + ONBOARDING_QUEUE_TTL_MS - Date.now()
        )
      );
      expiryTimer.unref?.();
    }
  };

  return {
    accept(event: DesktopAnalyticsLaneEvent) {
      if (disposed) {
        return;
      }
      refresh();
      // Keep the newest evidence when full; FIFO eviction is deterministic.
      if (entries.length === ONBOARDING_QUEUE_LIMIT) {
        const oldest = entries.shift();
        if (oldest) {
          diagnose(oldest, OnboardingAnalyticsDropReason.QueueOverflow);
        }
      }
      const identity = options.getIdentity();
      ownership ??= {
        identity: identity ? { ...identity } : null,
        origin: options.getApiOrigin(),
        revoked: null,
      };
      entries.push({
        event: structuredClone(event),
        ownership,
        acceptedAt: Date.now(),
        diagnosed: false,
      });
      refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
      entries.length = 0;
      ownership = null;
    },
  };
}
