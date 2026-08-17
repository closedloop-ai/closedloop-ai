"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  CheckIcon,
  EyeOffIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { type SyncTier, type SyncTierId, syncTiers } from "../mock";

const DetailLine = ({
  label,
  kind,
}: {
  label: string;
  kind: "sync" | "local";
}) => (
  <div className="flex items-center gap-2 text-xs">
    <span
      className={cn(kind === "sync" ? "text-success" : "text-muted-foreground")}
    >
      {kind === "sync" ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <EyeOffIcon className="size-3.5" />
      )}
    </span>
    <span
      className={cn(
        kind === "sync" ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {label}
    </span>
  </div>
);

// A real radio (Radio Group, packages/design-system/components/ui/radio-group.tsx)
// instead of a hand-rolled button-with-a-fake-circle: arrow keys move between
// the three tiers and the checked state is actually announced (#4285 T13).
const TierCard = ({
  tier,
  fieldId,
  selected,
}: {
  tier: SyncTier;
  fieldId: string;
  selected: boolean;
}) => (
  <label
    className={cn(
      "flex w-full cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors",
      selected
        ? "border-primary/40 bg-primary/5 ring-3 ring-primary/15"
        : "border-border bg-card hover:border-primary/25"
    )}
    htmlFor={fieldId}
  >
    <RadioGroupItem className="mt-0.5" id={fieldId} value={tier.id} />
    <div className="min-w-0 flex-1">
      <p className="font-semibold text-sm tracking-tight">{tier.title}</p>
      <p className="mt-1 text-pretty text-muted-foreground text-xs leading-relaxed">
        {tier.desc}
      </p>
      {tier.syncs.length > 0 || tier.local.length > 0 ? (
        <div
          className={cn(
            "mt-3 grid gap-4",
            tier.syncs.length > 0 && tier.local.length > 0
              ? "grid-cols-2"
              : "grid-cols-1"
          )}
        >
          {tier.syncs.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
                Syncs to cloud
              </p>
              {tier.syncs.map((detail) => (
                <DetailLine
                  key={detail.label}
                  kind={detail.kind}
                  label={detail.label}
                />
              ))}
            </div>
          ) : null}
          {tier.local.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
                Stays local
              </p>
              {tier.local.map((detail) => (
                <DetailLine
                  key={detail.label}
                  kind={detail.kind}
                  label={detail.label}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {tier.caveat ? (
        <p className="mt-2.5 text-muted-foreground text-xs">↳ {tier.caveat}</p>
      ) : null}
    </div>
  </label>
);

// Post-login data-sync consent. Shown once, immediately after an account is
// created / signed in — the user chooses how much of their local analytics
// syncs to the cloud. Nothing is preselected: the choice only counts as
// theirs if Continue stays disabled until they make it (#4285 T12).
export const SyncConsent = ({
  open,
  onDone,
}: {
  open: boolean;
  onDone: (tier: SyncTierId) => void;
}) => {
  const radioName = useId();
  const [selected, setSelected] = useState<SyncTierId | null>(null);
  if (!open) {
    return null;
  }
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-8">
        <div className="mx-auto flex w-full max-w-[620px] flex-col">
          {/* Left-aligned, unlike the other three onboarding covers, so the
              set of "cover" screens doesn't read as stamped from one
              template (#4285 T14). */}
          <div>
            <p className="flex items-center gap-1.5 font-semibold text-[11px] text-primary uppercase tracking-[0.08em]">
              <CheckIcon aria-hidden="true" className="size-3.5" />
              You're signed in
            </p>
            <h1 className="mt-1.5 font-semibold text-2xl tracking-tight">
              Choose what syncs to the cloud
            </h1>
            <p className="mt-2 max-w-[440px] text-pretty text-muted-foreground text-sm leading-relaxed">
              Your sessions were analyzed locally. Decide how much leaves your
              machine. You can change this anytime in Settings.
            </p>
          </div>

          <RadioGroup
            className="mt-6 flex flex-col gap-2.5 pb-6"
            onValueChange={(value) => setSelected(value as SyncTierId)}
            value={selected ?? undefined}
          >
            {syncTiers.map((tier) => (
              <TierCard
                fieldId={`${radioName}-${tier.id}`}
                key={tier.id}
                selected={selected === tier.id}
                tier={tier}
              />
            ))}
          </RadioGroup>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-border border-t bg-muted/40 px-6 py-3">
        <div className="mx-auto flex w-full max-w-[620px] items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
            <ShieldCheckIcon className="size-3.5 text-success" />
            Encrypted in transit · change or revoke anytime in Settings
          </span>
          <Button
            className="ml-auto"
            disabled={selected === null}
            onClick={() => selected && onDone(selected)}
            size="lg"
          >
            {selected === "local" ? "Continue without syncing" : "Continue"}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
};
