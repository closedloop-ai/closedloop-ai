"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import {
  EyeIcon,
  FlameIcon,
  GitMergeIcon,
  GlobeIcon,
  LockIcon,
} from "lucide-react";
import { useState } from "react";
import { publicProfile } from "../mock";

// The mocked share/embed affordance. A profile is PRIVATE by default: the
// dialog opens on an off state with an explicit "Make public" action, and once
// public a "Revoke link" invalidates the token. A real build would mint/rotate
// a share token; here the link and embed snippet are static placeholders so the
// design review can see the enable → live → revoke flow without any wiring.

const SHARE_URL = "https://closedloop.dev/p/9f3c2a71";
const EMBED_SNIPPET = `<iframe
  src="https://closedloop.dev/p/9f3c2a71/embed"
  width="480"
  height="260"
  title="Dana Whitfield on Closedloop"
  loading="lazy"
></iframe>`;

export function ShareDialog({
  open,
  onOpenChange,
  onPreviewPublic,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreviewPublic: () => void;
}) {
  const [isPublic, setIsPublic] = useState(false);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share your profile</DialogTitle>
          <DialogDescription>
            Your profile is private. Make it public to get a link anyone can
            open. The public page shows your headline stats, rank, and badges.
            Cost and spend figures are never included.
          </DialogDescription>
        </DialogHeader>
        {isPublic ? (
          <PublicState />
        ) : (
          <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3 text-sm">
            <LockIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p className="text-muted-foreground">
              No one can see this page yet. Nothing is shared until you make it
              public.
            </p>
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          {isPublic ? (
            <>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onPreviewPublic();
                }}
                variant="outline"
              >
                <EyeIcon aria-hidden="true" />
                Preview public page
              </Button>
              <Button onClick={() => setIsPublic(false)} variant="ghost">
                Revoke link
              </Button>
            </>
          ) : (
            <>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button onClick={() => setIsPublic(true)}>
                <GlobeIcon aria-hidden="true" />
                Make public
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The live-link state, shown only after the profile is made public.
function PublicState() {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="share-url">Public link</Label>
        <div className="flex items-center gap-2">
          <Input
            className="font-mono text-sm"
            id="share-url"
            readOnly
            value={SHARE_URL}
          />
          <CopyButton text={SHARE_URL} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Embed</Label>
        {/* What actually renders at the iframe's 480×260 target, so the
            handoff shows the embed state instead of only advertising it. */}
        <div className="mx-auto aspect-[480/260] w-full max-w-[480px] overflow-hidden rounded-lg border border-border bg-card">
          <EmbedCard />
        </div>
        <CodeBlock code={EMBED_SNIPPET} label="html" />
      </div>
    </div>
  );
}

// The compact card the /embed iframe serves — a trimmed version of the public
// card sized for a 480×260 unfurl slot. Driven by the same public projection.
function EmbedCard() {
  const { name, title, metrics, streakDays, badges, publicUrl } = publicProfile;
  const topMetrics = metrics.slice(0, 3);
  const milestone = badges[0];
  return (
    <div className="flex h-full flex-col justify-between p-4">
      <div className="min-w-0">
        <p className="truncate font-semibold text-base tracking-tight">
          {name}
        </p>
        <p className="truncate text-muted-foreground text-xs">{title}</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {topMetrics.map((metric) => (
          <div className="min-w-0" key={metric.key}>
            <p className="truncate font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
              {metric.label}
            </p>
            <p className="font-semibold text-lg tracking-tight">
              {metric.value}
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground text-xs">
          <FlameIcon aria-hidden="true" className="size-3 text-destructive" />
          {streakDays}-day streak
          {milestone ? (
            <>
              <GitMergeIcon
                aria-hidden="true"
                className="ml-1.5 size-3 text-primary"
              />
              {milestone.title}
            </>
          ) : null}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {publicUrl}
        </span>
      </div>
    </div>
  );
}
