"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { DataSyncLevelPicker } from "../../shared/components/data-sync-level-picker";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";
import {
  SYNC_CONSENT_LEVELS,
  SYNC_LEVEL_GROUP_LABEL,
  type SyncConsentLevel,
} from "./sync-consent";

export function GuidedOnboardingSyncStep({
  annotation,
  brand,
  error,
  level,
  notice,
  onBack,
  onContinue,
  onLevelChange,
  saving,
}: {
  annotation?: ReactNode;
  brand: ReactNode;
  /**
   * Why the last save failed, or `null`. Host-owned and rendered verbatim, so
   * the step states the host's own reason rather than a generic one it invented.
   */
  error: string | null;
  level: SyncConsentLevel | null;
  /** Host content above the picker; the Web setup gate's progress (ISS-12363). */
  notice?: ReactNode;
  onBack?: () => void;
  /**
   * Carries the level the user actually chose. The host persists it and decides
   * whether to advance — a failed write must leave the step on screen and
   * retryable, because dismissing it would tell the user a choice was recorded
   * that never reached disk.
   */
  onContinue: (level: SyncConsentLevel) => void;
  onLevelChange: (level: SyncConsentLevel) => void;
  /** Controlled in-flight state (host-owned): drives the spinner + disables. */
  saving: boolean;
}) {
  return (
    <GuidedOnboardingStepLayout
      annotation={annotation}
      body={
        <>
          {notice}
          {/* Above the picker, not below it: the three cards are tall, so an
              alert under them sits off screen at the scroll position where the
              visitor just pressed Continue. Same `Alert` the desktop consent
              takeover uses for the same failure. */}
          {error === null ? null : (
            <Alert className="mt-7" variant="error">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DataSyncLevelPicker
            className={error === null ? "mt-7" : "mt-4"}
            label={SYNC_LEVEL_GROUP_LABEL}
            levels={SYNC_CONSENT_LEVELS}
            onSelect={onLevelChange}
            selected={level}
          />
        </>
      }
      brand={brand}
      description="Choose how much session data to sync to your team. You can change this later in Settings."
      eyebrow="Your data, your choice"
      footer={
        <>
          <GuidedOnboardingBackButton onBack={onBack} />
          <Button
            aria-busy={saving}
            className="w-full sm:w-56"
            data-analytics-sync-choice={level ?? ""}
            disabled={level === null || saving}
            onClick={() => {
              if (level !== null) {
                onContinue(level);
              }
            }}
            size="lg"
            type="button"
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            Continue
          </Button>
        </>
      }
      title="Choose what to sync"
    />
  );
}

export function selectSyncStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingSyncStep> {
  return {
    annotation: source.annotations[OnboardingPhase.SyncPolicy],
    brand: source.brand,
    error: source.syncError,
    level: source.syncLevel,
    notice: source.stepNotices?.[OnboardingPhase.SyncPolicy],
    onBack: source.onBack,
    onContinue: source.onContinueFromSync ?? source.onComplete,
    onLevelChange: source.onSyncLevelChange,
    saving: source.syncSaving,
  };
}
