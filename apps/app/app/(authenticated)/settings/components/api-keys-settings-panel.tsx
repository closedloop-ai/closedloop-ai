"use client";

import type { ApiKey, CreateApiKeyResponse } from "@repo/api/src/types/api-key";
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
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from "@/hooks/queries/use-api-keys";
import { CreateApiKeySuccessDialog } from "./create-api-key-success-dialog";

function getKeyStatus(key: ApiKey): {
  label: string;
  variant: "default" | "secondary" | "destructive";
} {
  if (key.revokedAt !== null) {
    return { label: "Revoked", variant: "destructive" };
  }
  if (key.expiresAt !== null && new Date(key.expiresAt) <= new Date()) {
    return { label: "Expired", variant: "secondary" };
  }
  return { label: "Active", variant: "default" };
}

function isKeyActive(key: ApiKey): boolean {
  return (
    key.revokedAt === null &&
    (key.expiresAt === null || new Date(key.expiresAt) > new Date())
  );
}

function formatDate(date: Date | null): string {
  if (!date) {
    return "—";
  }
  return new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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
  const createApiKey = useCreateApiKey();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      return;
    }
    try {
      const response = await createApiKey.mutateAsync({ name: name.trim() });
      setName("");
      onOpenChange(false);
      onCreated(response);
    } catch {
      toast.error("Failed to create API key");
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
          <DialogDescription>
            Give your API key a descriptive name so you can identify it later.
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
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
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
}: {
  isLoading: boolean;
  apiKeys: ApiKey[] | undefined;
  onRevoke: (key: ApiKey) => void;
}) {
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
          <TableHead>Created</TableHead>
          <TableHead>Last Used</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apiKeys.map((key) => {
          const status = getKeyStatus(key);
          const active = isKeyActive(key);
          return (
            <TableRow key={key.id}>
              <TableCell className="font-medium">{key.name}</TableCell>
              <TableCell className="font-mono text-muted-foreground text-sm">
                {key.keyPrefix}...
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatDate(key.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {formatDate(key.lastUsedAt)}
              </TableCell>
              <TableCell>
                <Badge variant={status.variant}>{status.label}</Badge>
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

export function ApiKeysSettingsPanel() {
  const { data: apiKeys, isLoading } = useApiKeys();
  const revokeApiKey = useRevokeApiKey();
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
      toast.error("Failed to revoke API key");
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
              Manage API keys for programmatic access to Symphony.
            </CardDescription>
          </div>
          <Button onClick={() => setShowCreateDialog(true)} size="sm">
            <PlusIcon className="mr-2 h-4 w-4" />
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

      <CreateApiKeyDialog
        onCreated={setCreatedKey}
        onOpenChange={setShowCreateDialog}
        open={showCreateDialog}
      />

      {createdKey ? (
        <CreateApiKeySuccessDialog
          onClose={() => setCreatedKey(null)}
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
