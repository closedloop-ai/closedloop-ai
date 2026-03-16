"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { CheckCircleIcon, KeyIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  useClaudeApiKeyInfo,
  useSetOrgClaudeApiKey,
} from "@/hooks/queries/use-claude-api-keys";

type AddAnthropicKeyStepProps = {
  readonly onNext: () => void;
};

export function AddAnthropicKeyStep({ onNext }: AddAnthropicKeyStepProps) {
  const [keyInput, setKeyInput] = useState("");
  const { data: keyInfo, isLoading } = useClaudeApiKeyInfo();
  const setOrgKey = useSetOrgClaudeApiKey();

  const isKeySet = keyInfo?.org.isSet ?? false;
  const lastFour = keyInfo?.org.lastFour ?? null;

  const handleSaveKey = async () => {
    try {
      await setOrgKey.mutateAsync(keyInput);
      setKeyInput("");
      toast.success("API key saved and validated");
    } catch {
      toast.error("Failed to save API key. Check that it's valid.");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Add Anthropic API Key</h2>
        <p className="text-muted-foreground text-sm">
          An Anthropic API key is required to power AI-driven workflows. This
          key will be shared across your organization.
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <KeyIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">Organization API Key</p>
            <p className="text-muted-foreground text-xs">
              Used for all AI-powered features
            </p>
          </div>
          {isKeySet && (
            <div className="flex items-center gap-1 text-green-500 text-sm">
              <CheckCircleIcon className="h-4 w-4" />
              Set
            </div>
          )}
        </div>

        <ApiKeyContent
          isKeySet={isKeySet}
          isLoading={isLoading}
          isSaving={setOrgKey.isPending}
          keyInput={keyInput}
          lastFour={lastFour}
          onKeyInputChange={setKeyInput}
          onSave={handleSaveKey}
        />
      </div>

      <div className="flex items-center justify-between">
        {/* TODO: Remove skip button — temporary for local dev */}
        <Button
          className="text-muted-foreground"
          onClick={onNext}
          size="sm"
          variant="ghost"
        >
          Skip for now
        </Button>
        <Button disabled={!isKeySet} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function ApiKeyContent({
  isLoading,
  isKeySet,
  isSaving,
  keyInput,
  lastFour,
  onKeyInputChange,
  onSave,
}: {
  readonly isLoading: boolean;
  readonly isKeySet: boolean;
  readonly isSaving: boolean;
  readonly keyInput: string;
  readonly lastFour: string | null;
  readonly onKeyInputChange: (value: string) => void;
  readonly onSave: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isKeySet) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
        <CheckCircleIcon className="h-4 w-4 text-green-500" />
        <span>
          API key configured{" "}
          <span className="font-mono text-muted-foreground text-xs">
            ****{lastFour}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id="anthropic-key"
          onChange={(e) => onKeyInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyInput) {
              onSave();
            }
          }}
          placeholder="sk-ant-..."
          type="password"
          value={keyInput}
        />
        <Button disabled={!keyInput || isSaving} onClick={onSave}>
          {isSaving ? <Loader2Icon className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Your key is encrypted at rest and validated against the Anthropic API.
      </p>
    </div>
  );
}
