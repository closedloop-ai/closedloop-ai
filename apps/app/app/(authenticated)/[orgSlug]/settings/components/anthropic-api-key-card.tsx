"use client";

import {
  useClaudeApiKeyInfo,
  useRemoveOrgClaudeApiKey,
  useRemoveUserClaudeApiKey,
  useSetOrgClaudeApiKey,
  useSetUserClaudeApiKey,
} from "@repo/app/api-keys/hooks/use-claude-api-keys";
import { Badge } from "@repo/design-system/components/ui/badge";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import { CheckCircleIcon, KeyIcon, Loader2Icon, TrashIcon } from "lucide-react";
import { useState } from "react";

function KeyStatusRow({
  label,
  isSet,
  lastFour,
  onRemove,
  isRemoving,
}: {
  label: string;
  isSet: boolean;
  lastFour: string | null;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  if (!isSet) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">{label}</span>
        <Badge variant="outline">Not set</Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <CheckCircleIcon className="h-4 w-4 text-success" />
        <span className="text-sm">{label}</span>
        <span className="font-mono text-muted-foreground text-xs">
          ****{lastFour}
        </span>
      </div>
      <Button
        aria-label="Remove API key"
        disabled={isRemoving}
        onClick={onRemove}
        size="sm"
        variant="ghost"
      >
        {isRemoving ? (
          <Loader2Icon className="h-4 w-4 animate-spin" />
        ) : (
          <TrashIcon className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}

type AnthropicApiKeyCardProperties = {
  isAdmin: boolean;
};

export function AnthropicApiKeyCard({
  isAdmin,
}: AnthropicApiKeyCardProperties) {
  const { data: keyInfo, isLoading } = useClaudeApiKeyInfo();
  const setOrgKey = useSetOrgClaudeApiKey();
  const removeOrgKey = useRemoveOrgClaudeApiKey();
  const setUserKey = useSetUserClaudeApiKey();
  const removeUserKey = useRemoveUserClaudeApiKey();

  const [orgKeyInput, setOrgKeyInput] = useState("");
  const [userKeyInput, setUserKeyInput] = useState("");

  const handleSetOrgKey = async () => {
    try {
      await setOrgKey.mutateAsync(orgKeyInput);
      setOrgKeyInput("");
      toast.success("Organization API key saved");
    } catch {
      toast.error("Failed to save API key. Check that it's valid.");
    }
  };

  const handleSetUserKey = async () => {
    try {
      await setUserKey.mutateAsync(userKeyInput);
      setUserKeyInput("");
      toast.success("Personal API key saved");
    } catch {
      toast.error("Failed to save API key. Check that it's valid.");
    }
  };

  const handleRemoveOrgKey = async () => {
    try {
      await removeOrgKey.mutateAsync();
      toast.success("Organization API key removed");
    } catch {
      toast.error("Failed to remove API key");
    }
  };

  const handleRemoveUserKey = async () => {
    try {
      await removeUserKey.mutateAsync();
      toast.success("Personal API key removed");
    } catch {
      toast.error("Failed to remove API key");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyIcon className="h-5 w-5" />
          Anthropic API Key
        </CardTitle>
        <CardDescription>
          Required for AI loop execution. Set an organization-wide key, or
          override with your own personal key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Current status */}
            <div className="space-y-3">
              <KeyStatusRow
                isRemoving={removeOrgKey.isPending}
                isSet={keyInfo?.org.isSet ?? false}
                label="Organization key"
                lastFour={keyInfo?.org.lastFour ?? null}
                onRemove={handleRemoveOrgKey}
              />
              <KeyStatusRow
                isRemoving={removeUserKey.isPending}
                isSet={keyInfo?.user.isSet ?? false}
                label="Personal key (override)"
                lastFour={keyInfo?.user.lastFour ?? null}
                onRemove={handleRemoveUserKey}
              />
            </div>

            {/* Set org key (admin only) */}
            {isAdmin && (
              <div className="space-y-2">
                <Label htmlFor="org-key">Organization API Key</Label>
                <div className="flex gap-2">
                  <Input
                    id="org-key"
                    onChange={(e) => setOrgKeyInput(e.target.value)}
                    placeholder="sk-ant-..."
                    type="password"
                    value={orgKeyInput}
                  />
                  <Button
                    disabled={!orgKeyInput || setOrgKey.isPending}
                    onClick={handleSetOrgKey}
                  >
                    {setOrgKey.isPending ? (
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Shared across all organization members. Admin only.
                </p>
              </div>
            )}

            {/* Set personal key (all users) */}
            <div className="space-y-2">
              <Label htmlFor="user-key">Personal API Key</Label>
              <div className="flex gap-2">
                <Input
                  id="user-key"
                  onChange={(e) => setUserKeyInput(e.target.value)}
                  placeholder="sk-ant-..."
                  type="password"
                  value={userKeyInput}
                />
                <Button
                  disabled={!userKeyInput || setUserKey.isPending}
                  onClick={handleSetUserKey}
                >
                  {setUserKey.isPending ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Overrides the organization key for your loops only.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
