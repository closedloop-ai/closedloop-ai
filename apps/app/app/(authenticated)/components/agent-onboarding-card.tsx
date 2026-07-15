"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Link } from "@repo/navigation/link";
import { Check, Circle, Loader2Icon, SparklesIcon, X } from "lucide-react";
import { useAgentOnboarding } from "@/hooks/queries/use-agent-onboarding";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";

export function AgentOnboardingCard() {
  return (
    <FeatureFlagged flag={AGENTS_FEATURE_FLAG_KEY}>
      <AgentOnboardingCardInner />
    </FeatureFlagged>
  );
}

function AgentOnboardingCardInner() {
  const orgSlug = useOrgSlug();
  const onboarding = useAgentOnboarding();
  const githubConnectUrl = getGitHubConnectUrl("install");

  if (!onboarding.shouldShow) {
    return null;
  }

  return (
    <Card className="mx-4 mt-4 shadow-none">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SparklesIcon className="h-5 w-5 text-primary" />
          <CardTitle>Set up AI agents for your team</CardTitle>
        </div>
        <CardDescription>
          Scan your repositories to generate domain-expert agents tailored to
          your codebase. Agents run locally on your machine — your source code
          stays private.
        </CardDescription>
        <CardAction>
          <Button
            className="h-8 w-8 text-muted-foreground"
            onClick={onboarding.dismiss}
            size="icon"
            variant="ghost"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Skip for now</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <PrereqItem completed label="Account created" />
          <PrereqItem
            completed={onboarding.hasGitHub}
            href={onboarding.hasGitHub ? undefined : githubConnectUrl}
            label={onboarding.hasGitHub ? "GitHub connected" : "Connect GitHub"}
          />
          <PrereqItem
            completed={onboarding.hasElectron}
            label={
              onboarding.hasElectron
                ? "Desktop app connected"
                : "Install Desktop App"
            }
          />
        </div>

        {onboarding.bootstrapInProgress ? (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-4 py-3">
            <Loader2Icon className="h-5 w-5 shrink-0 animate-spin text-primary" />
            <div>
              <p className="font-medium text-sm">Generating agents...</p>
              <p className="text-muted-foreground text-xs">
                <Link
                  className="underline"
                  href={`/${orgSlug}/agents?from=onboarding`}
                >
                  View progress
                </Link>
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {onboarding.prereqsMet ? (
              <Button asChild>
                <Link href={`/${orgSlug}/agents?from=onboarding`}>
                  <SparklesIcon className="h-4 w-4" />
                  Generate Agents
                </Link>
              </Button>
            ) : (
              <Button disabled>
                <SparklesIcon className="h-4 w-4" />
                Generate Agents
              </Button>
            )}
            <Button onClick={onboarding.dismiss} variant="ghost">
              Skip for now
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type PrereqItemProps = {
  readonly label: string;
  readonly completed: boolean;
  readonly href?: string;
};

function PrereqItem({ label, completed, href }: PrereqItemProps) {
  const content = (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5">
      {completed ? (
        <Check className="h-4 w-4 shrink-0 text-success" />
      ) : (
        <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
      )}
      <span
        className={`text-sm ${
          completed ? "text-muted-foreground" : "font-medium"
        }`}
      >
        {label}
      </span>
    </div>
  );

  if (href && !completed) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}
