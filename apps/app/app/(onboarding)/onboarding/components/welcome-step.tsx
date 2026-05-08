"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Rocket } from "lucide-react";

type WelcomeStepProps = {
  readonly onNext: () => void;
};

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="flex flex-col items-center gap-6 py-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Rocket className="h-8 w-8 text-primary" />
      </div>
      <div className="space-y-2">
        <h1 className="font-bold text-2xl">Welcome to ClosedLoop</h1>
        <p className="mx-auto max-w-sm text-muted-foreground">
          Let&apos;s get your workspace set up. We&apos;ll create a team and
          your first project so you can hit the ground running.
        </p>
      </div>
      <Button onClick={onNext} size="lg">
        Get Started
      </Button>
    </div>
  );
}
