"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { GithubIcon, Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

// GitHub connection is REQUIRED for every account — it's what powers the
// API-based PR/repo/comment backfill (so we never drive the user's local
// gh/git under their personal credentials). A GitHub sign-up grants this in one
// shot at minting; this blocking step only appears for Google / email sign-ups,
// which mint the Clerk identity first and must connect GitHub before syncing.
const GRANTED_SCOPES = [
  "Read your pull requests, commits & repositories",
  "Read your organizations & teams",
  "Attribute merged PRs and comments to you",
];

export const ConnectGitHub = ({
  open,
  onConnected,
}: {
  open: boolean;
  onConnected: () => void;
}) => {
  const [pending, setPending] = useState(false);
  if (!open) {
    return null;
  }
  const connect = () => {
    setPending(true);
    // Prototype: simulate the GitHub OAuth round-trip, then resolve.
    window.setTimeout(onConnected, 1100);
  };
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-[440px] text-center">
        <GithubIcon aria-hidden="true" className="mx-auto size-8" />
        <p className="mt-4 font-semibold text-[11px] text-primary uppercase tracking-[0.08em]">
          One more step · Required
        </p>
        <h1 className="mt-1.5 font-semibold text-2xl tracking-tight">
          Connect GitHub to finish setup
        </h1>
        <p className="mx-auto mt-2 max-w-[400px] text-pretty text-muted-foreground text-sm leading-relaxed">
          ClosedLoop reads your PR, commit, and repo activity through the GitHub
          API you authorize, so we never drive your local gh or git under your
          personal credentials. Connecting is required to sync and compare.
        </p>

        <div className="mt-5 rounded-xl border border-border bg-card p-4 text-left">
          <p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
            You'll grant access to
          </p>
          <ul className="mt-2 space-y-1.5">
            {GRANTED_SCOPES.map((scope) => (
              <li className="flex items-center gap-2 text-xs" key={scope}>
                <ShieldCheckIcon className="size-3.5 shrink-0 text-success" />
                {scope}
              </li>
            ))}
          </ul>
        </div>

        <Button
          className="mt-5 w-full"
          disabled={pending}
          onClick={connect}
          size="lg"
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <GithubIcon />}
          {pending ? "Opening your browser…" : "Continue with GitHub"}
        </Button>
        <p className="mt-3 text-[11px] text-muted-foreground">
          A GitHub sign-up grants this in one step. You're seeing it because you
          signed up another way.
        </p>
      </div>
    </div>
  );
};
