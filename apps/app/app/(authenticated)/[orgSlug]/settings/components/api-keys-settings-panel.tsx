"use client";

import type { ApiKey, CreateApiKeyResponse } from "@repo/api/src/types/api-key";
import { ApiKeyCreatedDialog } from "@repo/app/api-keys/components/api-key-created-dialog";
import { ApiKeyScopeCell } from "@repo/app/api-keys/components/api-key-scope-cell";
import {
  useCreatePlatformApiKey,
  usePlatformApiKeys,
  useRevokePlatformApiKey,
} from "@repo/app/api-keys/hooks/use-platform-api-keys";
import {
  API_KEY_STATUS_LABEL,
  type ApiKeyStatus,
  describeApiKeyStatus,
  formatApiKeyDate,
  isApiKeyActive,
} from "@repo/app/api-keys/lib/api-key-row";
import { getApiKeyScopeDisplay } from "@repo/app/api-keys/lib/api-key-scope-display";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { env } from "@/env";

/**
 * This panel's treatment for each status. Kept here rather than in the shared
 * helper because the Settings v2 panel deliberately draws the same three
 * statuses with the low-tint variants; only the status derivation is shared, so
 * the two cannot disagree about WHICH state a key is in. Exhaustive over
 * `ApiKeyStatus`, so a new status fails `tsc` here rather than rendering
 * unstyled.
 */
const API_KEY_STATUS_VARIANT: Record<
  ApiKeyStatus,
  "default" | "secondary" | "destructive"
> = {
  active: "default",
  expired: "secondary",
  revoked: "destructive",
};

type CreateApiKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (response: CreateApiKeyResponse) => void;
};

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<CreateApiKeyDialogProps>) {
  const [name, setName] = useState("");
  const createApiKey = useCreatePlatformApiKey({
    onError: () => toast.error("Failed to create API key"),
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }
    try {
      const response = await createApiKey.mutateAsync({
        name: name.trim(),
      });
      setName("");
      onOpenChange(false);
      onCreated(response);
      // The plaintext now lives in the panel's `createdKey` state, which is what
      // the one-time dialog renders and what dismissing it clears. Drop the
      // mutation cache's own copy immediately: this dialog stays MOUNTED for the
      // life of the panel, so without this the secret outlived the disclosure it
      // was shown in and survived every later dismissal (#6392, whitlockk). Reset
      // here rather than at dismissal because from this line on the cached copy
      // is redundant, and nothing reads it.
      createApiKey.reset();
    } catch {
      // Reported by the mutation's `onError` above.
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>
            Give your API key a descriptive name so you can identify it later.
            New keys have full read, write, and delete access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                autoFocus
                id="key-name"
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI/CD pipeline"
                value={name}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || createApiKey.isPending}
              type="submit"
            >
              {createApiKey.isPending ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeysCardContent({
  isLoading,
  apiKeys,
  onRevoke,
}: Readonly<{
  isLoading: boolean;
  apiKeys: ApiKey[] | undefined;
  onRevoke: (key: ApiKey) => void;
}>) {
  const now = new Date();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!apiKeys || apiKeys.length === 0) {
    return (
      <p className="py-4 text-center text-muted-foreground text-sm">
        No API keys yet. Create one to get started.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Prefix</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last Used</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apiKeys.map((key) => {
          const status = describeApiKeyStatus(key, now);
          const active = isApiKeyActive(key, now);
          const scope = getApiKeyScopeDisplay(key.scopes);
          return (
            <TableRow key={key.id}>
              <TableCell className="font-medium">{key.name}</TableCell>
              <TableCell className="font-mono text-muted-foreground text-sm">
                {key.keyPrefix}...
              </TableCell>
              <TableCell>
                <ApiKeyScopeCell scope={scope} />
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatApiKeyDate(key.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatApiKeyDate(key.lastUsedAt)}
              </TableCell>
              <TableCell>
                <Badge variant={API_KEY_STATUS_VARIANT[status]}>
                  {API_KEY_STATUS_LABEL[status]}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  disabled={!active}
                  onClick={() => onRevoke(key)}
                  size="sm"
                  variant="outline"
                >
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const MCP_TOOL_GROUPS = [
  {
    label: "Projects",
    tools: ["list-projects", "get-project", "create-project", "update-project"],
  },
  {
    label: "Documents",
    tools: [
      "list-documents",
      "get-document",
      "create-document",
      "update-document",
      "create-document-version",
      "list-document-versions",
    ],
  },
  {
    label: "Links",
    tools: ["list-artifact-links", "create-artifact-link"],
  },
  {
    label: "Integrations",
    tools: ["get-github-status", "get-linear-status", "get-google-status"],
  },
  {
    label: "Planning",
    tools: ["list-templates"],
  },
  {
    label: "Other",
    tools: ["list-users", "ping"],
  },
] as const;

function QuickStartGuide() {
  const mcpServerUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? "MCP server URL";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quick Start</CardTitle>
        <CardDescription>
          Use your API key to connect Closedloop to Claude Code, Claude Desktop,
          or your own scripts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="font-medium text-sm">Claude Code (CLI)</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {`claude mcp add --transport http closedloop ${mcpServerUrl}`}
          </pre>
          <p className="text-muted-foreground text-xs">
            Install it at the user/global scope so it is available across
            projects. You&apos;ll be prompted to authenticate via OAuth when the
            server is first used.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Claude Code Cowork</p>
          <p className="text-muted-foreground text-xs">
            Go to{" "}
            <strong>
              Settings &rarr; Connectors &rarr; Add Custom Connector
            </strong>
            . Use any connector name you want, add it at the user/global scope,
            and set the Remote MCP server URL to:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {mcpServerUrl}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">REST API</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {`curl https://api.closedloop.ai/documents -H "Authorization: Bearer sk_live_YOUR_KEY"`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Available MCP Tools (35)</p>
          <div className="space-y-1.5">
            {MCP_TOOL_GROUPS.map((group) => (
              <div className="text-xs" key={group.label}>
                <span className="font-medium">{group.label}:</span>{" "}
                <span className="text-muted-foreground">
                  {group.tools.map((tool, i) => (
                    <span key={tool}>
                      <code className="text-xs">{tool}</code>
                      {i < group.tools.length - 1 ? ", " : ""}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApiKeysSettingsPanel() {
  const { data: apiKeys, isLoading } = usePlatformApiKeys();
  const revokeApiKey = useRevokePlatformApiKey({
    onError: () => toast.error("Failed to revoke API key"),
  });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreateApiKeyResponse | null>(
    null
  );
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const handleRevoke = async () => {
    if (!revokeTarget) {
      return;
    }
    try {
      await revokeApiKey.mutateAsync(revokeTarget.id);
      toast.success("API key revoked");
    } catch {
      // Reported by the mutation's `onError` above.
    }
    setRevokeTarget(null);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>
              Manage API keys for programmatic access to Closedloop.
            </CardDescription>
          </div>
          <Button onClick={() => setShowCreateDialog(true)} size="sm">
            <PlusIcon className="h-4 w-4" />
            Create Key
          </Button>
        </CardHeader>
        <CardContent>
          <ApiKeysCardContent
            apiKeys={apiKeys}
            isLoading={isLoading}
            onRevoke={setRevokeTarget}
          />
        </CardContent>
      </Card>

      <QuickStartGuide />

      <CreateApiKeyDialog
        onCreated={setCreatedKey}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />

      {createdKey ? (
        <ApiKeyCreatedDialog
          onDismiss={() => setCreatedKey(null)}
          plaintext={createdKey.plaintext}
        />
      ) : null}

      <ConfirmationDialog
        confirmLabel="Revoke"
        description="This will immediately invalidate the key. Any integrations using it will stop working."
        isPending={revokeApiKey.isPending}
        onConfirm={handleRevoke}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        open={revokeTarget !== null}
        title="Revoke API Key"
        variant="destructive"
      />
    </>
  );
}
