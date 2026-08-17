"use client";

import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { CheckCircleIcon, KeyRoundIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ANTHROPIC_API_KEY_CARD_ANCHOR, GITHUB_CARD_ANCHOR } from "../mock";

type SettingsIntegrationsProps = {
  githubConnected: boolean;
  onConnectGitHub: () => void;
  apiKeySaved: boolean;
  onSaveApiKey: () => void;
};

// The Compute & Integrations tab. Presentational stand-ins for the production
// GitHubIntegrationCard and AnthropicApiKeyCard; each carries the DOM id the
// checklist deep-links scroll to. Connect/save state is owned by the shell so
// completing a step here ticks the setup checklist off too.
export const SettingsIntegrations = ({
  githubConnected,
  onConnectGitHub,
  apiKeySaved,
  onSaveApiKey,
}: SettingsIntegrationsProps) => (
  <div className="space-y-6">
    <GitHubCard connected={githubConnected} onConnect={onConnectGitHub} />
    <AnthropicApiKeyCard onSave={onSaveApiKey} saved={apiKeySaved} />
  </div>
);

const GitHubCard = ({
  connected,
  onConnect,
}: {
  connected: boolean;
  onConnect: () => void;
}) => (
  <Card id={GITHUB_CARD_ANCHOR} tabIndex={-1}>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <GitHubMark className="size-5" />
        GitHub
      </CardTitle>
      <CardDescription>
        Link your repositories for code management and PR insights.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {connected ? (
        <div className="flex items-center gap-3">
          <CheckCircleIcon className="size-5 text-success" />
          <div className="space-y-0.5">
            <p className="font-medium text-sm">Connected to GitHub</p>
            <p className="text-muted-foreground text-sm">acme-engineering</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">Not connected yet.</p>
          <Button onClick={onConnect}>
            <GitHubMark className="size-4" />
            Connect GitHub
          </Button>
        </div>
      )}
    </CardContent>
  </Card>
);

const AnthropicApiKeyCard = ({
  saved,
  onSave,
}: {
  saved: boolean;
  onSave: () => void;
}) => {
  const [key, setKey] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length === 0) {
      return;
    }
    onSave();
  };

  return (
    <Card id={ANTHROPIC_API_KEY_CARD_ANCHOR} tabIndex={-1}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-5" />
          Anthropic API Key
        </CardTitle>
        <CardDescription>
          Required for AI-powered workflows. Stored encrypted for your
          organization.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {saved ? (
          <div className="flex items-center gap-3">
            <CheckCircleIcon className="size-5 text-success" />
            <div className="space-y-0.5">
              <p className="font-medium text-sm">API key saved</p>
              <p className="text-muted-foreground text-sm tabular-nums">
                sk-ant-•••••••••••••••
              </p>
            </div>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="anthropic-key">Organization API key</Label>
              <Input
                autoComplete="off"
                id="anthropic-key"
                onChange={(event) => setKey(event.target.value)}
                placeholder="sk-ant-..."
                type="password"
                value={key}
              />
            </div>
            <Button disabled={key.trim().length === 0} type="submit">
              Save key
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
};
