"use client";

import type { ApiKey } from "@repo/api/src/types/api-key";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ApiKeyCreatedDialog } from "../../../api-keys/components/api-key-created-dialog";
import { ApiKeyScopeCell } from "../../../api-keys/components/api-key-scope-cell";
import {
  useCreatePlatformApiKey,
  usePlatformApiKeys,
  useRevokePlatformApiKey,
} from "../../../api-keys/hooks/use-platform-api-keys";
import {
  API_KEY_STATUS_LABEL,
  type ApiKeyStatus,
  describeApiKeyStatus,
  formatApiKeyDate,
  isApiKeyActive,
} from "../../../api-keys/lib/api-key-row";
import { getApiKeyScopeDisplay } from "../../../api-keys/lib/api-key-scope-display";
import { ConfirmationDialog } from "../../../shared/components/confirmation-dialog";
import { SettingsPanelDataStateView } from "../components/settings-panel-data-state-view";
import { SettingsPanelSection } from "../components/settings-panel-section";
import {
  classifySettingsPanelRead,
  isStaleResourceError,
  SettingsPanelDataState,
} from "../lib/settings-panel-data-state";
import { ApiKeysCredentialCards } from "./api-keys/api-keys-credential-cards";
import { CreateApiKeyDialog } from "./create-api-key-dialog";

const API_KEYS_SUBJECT = "your API keys";

/**
 * The Settings v2 API Keys panel (ISS-8369).
 *
 * SCOPE. Closedloop programmatic keys: create, list, revoke. Below them sits
 * the credential a user SUPPLIES rather than this product mints (the org's
 * Pensero credential), which ISS-10316 moved here from the legacy Integrations
 * tab. Those live in
 * {@link ApiKeysCredentialCards}; this module owns only the platform keys.
 *
 * SECRETS. A key's plaintext exists on exactly one path: the create response,
 * into local state, into {@link ApiKeyCreatedDialog}, and gone. It is never
 * logged, never sent to analytics, never put in a thrown message, and there is
 * no read that could bring it back — the list projection carries the prefix
 * only. Dismissing the dialog also calls `createKey.reset()`, so the secret does
 * not linger in the mutation cache for the life of the mounted panel.
 */
export function ApiKeysSettingsPanel() {
  const keys = usePlatformApiKeys();
  const createKey = useCreatePlatformApiKey();
  const revokeKey = useRevokePlatformApiKey({
    onError: (error) => {
      if (!isStaleResourceError(error)) {
        toast.error("Couldn't revoke that API key");
      }
    },
  });

  const [isCreating, setIsCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const dataState = classifySettingsPanelRead({
    error: keys.error,
    hasData: keys.data !== undefined,
    isEmpty: keys.data?.length === 0,
    isPending: keys.isPending,
  });

  const dismissCreatedSecret = () => {
    setCreatedSecret(null);
    // Drops the plaintext from the mutation cache too. Without it the secret
    // stays on `createKey.data` until the panel unmounts.
    createKey.reset();
  };

  const handleRevoke = async () => {
    if (revokeTarget === null) {
      return;
    }
    try {
      await revokeKey.mutateAsync(revokeTarget.id);
      toast.success("API key revoked");
    } catch (error) {
      // Version skew: the route answers 404 for a key that is missing OR
      // already revoked, so another admin or an older client may simply have
      // got there first. That is the outcome the user asked for — re-read and
      // say so rather than reporting their action as broken. Any other failure
      // is reported by the mutation's `onError` above.
      if (isStaleResourceError(error)) {
        toast.success("That key was already revoked");
      }
      await keys.refetch();
    }
    setRevokeTarget(null);
  };

  return (
    <SettingsPanelSection
      description="Authenticate MCP clients and REST API requests to Closedloop."
      title="API Keys"
    >
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Closedloop API keys</CardTitle>
            <CardDescription>
              A key's secret is shown once, when you create it. After that only
              its prefix is stored.
            </CardDescription>
            <CardAction>
              <Button
                disabled={dataState === SettingsPanelDataState.Forbidden}
                onClick={() => setIsCreating(true)}
                size="sm"
              >
                <PlusIcon aria-hidden="true" />
                Create key
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <SettingsPanelDataStateView
              empty={{
                description:
                  "Create a key to connect an MCP client or a REST integration.",
                icon: KeyRoundIcon,
                title: "No API keys yet",
              }}
              onRetry={() => {
                keys.refetch();
              }}
              state={dataState}
              subject={API_KEYS_SUBJECT}
            />
            {dataState === SettingsPanelDataState.Ready && keys.data ? (
              <ApiKeysTable apiKeys={keys.data} onRevoke={setRevokeTarget} />
            ) : null}
          </CardContent>
        </Card>

        <ApiKeysCredentialCards />
      </div>

      <CreateApiKeyDialog
        isPending={createKey.isPending}
        onCreate={async (name) => {
          const created = await createKey.mutateAsync({ name });
          setIsCreating(false);
          setCreatedSecret(created.plaintext);
        }}
        onOpenChange={setIsCreating}
        open={isCreating}
      />

      {createdSecret === null ? null : (
        <ApiKeyCreatedDialog
          onDismiss={dismissCreatedSecret}
          plaintext={createdSecret}
        />
      )}

      <ConfirmationDialog
        confirmLabel="Revoke"
        description="This takes effect immediately. Anything still using the key stops working."
        isPending={revokeKey.isPending}
        onConfirm={handleRevoke}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeTarget(null);
          }
        }}
        open={revokeTarget !== null}
        title="Revoke API key"
        variant="destructive"
      />
    </SettingsPanelSection>
  );
}

/**
 * This panel's treatment for each status. Low-tint variants rather than the
 * solid fills the legacy panel uses: a list of ten live keys is ten chips, and
 * ten saturated pills is texture, not signal. Exhaustive over `ApiKeyStatus`, so
 * a status added to the shared helper fails `tsc` here rather than rendering
 * unstyled.
 */
const API_KEY_STATUS_VARIANT: Record<
  ApiKeyStatus,
  "success" | "muted" | "error"
> = {
  active: "success",
  expired: "muted",
  revoked: "error",
};

function ApiKeysTable({
  apiKeys,
  onRevoke,
}: Readonly<{ apiKeys: readonly ApiKey[]; onRevoke: (key: ApiKey) => void }>) {
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Prefix</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apiKeys.map((key) => {
          const status = describeApiKeyStatus(key, now);
          return (
            <TableRow key={key.id}>
              <TableCell className="font-medium">{key.name}</TableCell>
              <TableCell className="font-mono text-muted-foreground text-sm">
                {key.keyPrefix}…
              </TableCell>
              <TableCell>
                <ApiKeyScopeCell scope={getApiKeyScopeDisplay(key.scopes)} />
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
                  aria-label={`Revoke ${key.name}`}
                  disabled={!isApiKeyActive(key, now)}
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
