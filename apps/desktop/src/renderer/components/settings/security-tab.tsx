import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import { useCallback, useEffect, useState } from "react";
import { cleanIpcError } from "../../clean-ipc-error";
import { GlobalSandboxSection } from "./global-sandbox-card";
import { ConfigRow } from "./settings-config-row";

/**
 * Renderer view of ApiKeyStore.getStatus() (src/main/api-key-store.ts).
 *
 * Exported so test fixtures standing in for that IPC are checked against the
 * same contract this component consumes — a shadow copy in a test would let a
 * renamed or added `source` value diverge without failing typecheck.
 */
export type ApiKeyStatusView = {
  hasApiKey: boolean;
  source: "safeStorage" | "environment" | "none";
  environmentVariable?: string;
  provenance?: string;
};

/**
 * ISS-7043: Settings → Security — the API-key summary and editor, the global
 * sandbox root, the dangerous auto-approve switch, and the security flag list.
 *
 * Moved out of SettingsPanel.tsx so that file
 * trends smaller per the repo file-size discipline. The body moved unchanged
 * EXCEPT for the inline API-key nested ternary, which became the
 * `apiKeyValueLabel` helper below — the one place this move could have changed
 * behavior, so re-derive that helper rather than the rest when auditing the
 * split. It is pinned by __tests__/settings-panel-security-api-key-label.test.tsx.
 */
export function SecurityTab({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange: (s: Record<string, unknown>) => void;
}) {
  const [dangerousAutoApprove, setDangerousAutoApprove] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatusView | null>(
    null
  );
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [dangerousError, setDangerousError] = useState<string | null>(null);

  // Split from `refreshApiKeyStatus` so the mount effect can decide whether to
  // publish the answer, without a second copy of the read living next to it.
  const readApiKeyStatus = useCallback(
    async () => (await window.desktopApi.getApiKeyStatus()) as ApiKeyStatusView,
    []
  );

  const refreshApiKeyStatus = useCallback(async () => {
    setApiKeyStatus(await readApiKeyStatus());
  }, [readApiKeyStatus]);

  useEffect(() => {
    let cancelled = false;
    window.desktopApi
      .getDangerousAutoApprove()
      .then((value) => {
        if (!cancelled) {
          setDangerousAutoApprove(value);
        }
      })
      .catch(() => {});
    readApiKeyStatus()
      .then((status) => {
        if (!cancelled) {
          setApiKeyStatus(status);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [readApiKeyStatus]);

  const handleDangerousToggle = async (next: boolean) => {
    setDangerousError(null);
    try {
      await window.desktopApi.setDangerousAutoApprove(next);
      setDangerousAutoApprove(next);
    } catch (err) {
      setDangerousError(
        cleanIpcError(err, "Failed to update auto-approve setting")
      );
    }
  };

  const handleSetApiKey = async () => {
    const value = apiKeyInput.trim();
    if (!value) {
      return;
    }
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await window.desktopApi.setApiKey(value);
      setApiKeyInput("");
      await refreshApiKeyStatus();
    } catch (err) {
      setApiKeyError(cleanIpcError(err, "Failed to set API key"));
    } finally {
      setApiKeyBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setApiKeyBusy(true);
    setApiKeyError(null);
    try {
      await window.desktopApi.clearApiKey();
      setApiKeyInput("");
      await refreshApiKeyStatus();
    } catch (err) {
      setApiKeyError(cleanIpcError(err, "Failed to clear API key"));
    } finally {
      setApiKeyBusy(false);
    }
  };

  const apiKeyConfigured = apiKeyStatus?.hasApiKey === true;
  const apiKeyFromEnv = apiKeyStatus?.source === "environment";

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Security Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigRow label="API Key" value={apiKeyValueLabel(apiKeyStatus)} />
          <ConfigRow
            label="Auth Mode"
            value={(settings?.authMode as string) ?? "standard"}
          />

          <GlobalSandboxSection
            onSettingsChange={onSettingsChange}
            settings={settings}
          />

          <div className="space-y-2 border-t pt-2">
            <p className="font-medium text-sm">Manage API Key</p>
            <p className="text-[var(--muted-foreground)] text-xs">
              {apiKeyFromEnv
                ? "An API key is provided via an environment variable. Setting one here stores an encrypted key that takes precedence."
                : "Set a Closedloop API key (starts with sk_live_). It is stored encrypted at rest."}
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="API key"
                autoComplete="off"
                className="flex-1 font-mono text-xs"
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSetApiKey().catch(() => {});
                  }
                }}
                placeholder="sk_live_..."
                type="password"
                value={apiKeyInput}
              />
              <Button
                disabled={apiKeyBusy || apiKeyInput.trim().length === 0}
                onClick={handleSetApiKey}
                size="sm"
                variant="outline"
              >
                Set
              </Button>
              <Button
                className="text-[var(--destructive)]"
                disabled={apiKeyBusy || !apiKeyConfigured}
                onClick={handleClearApiKey}
                size="sm"
                variant="ghost"
              >
                Clear
              </Button>
            </div>
            {apiKeyError && (
              <p className="text-[var(--destructive)] text-xs">{apiKeyError}</p>
            )}
          </div>

          <div className="border-t pt-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-[var(--destructive)] text-sm">
                  Dangerous Auto-Approve
                </p>
                <p className="text-[var(--muted-foreground)] text-xs">
                  Automatically approve all commands — use with extreme caution
                </p>
              </div>
              <Switch
                aria-label="Dangerous Auto-Approve"
                checked={dangerousAutoApprove}
                className="data-[state=checked]:bg-[var(--destructive)]"
                onCheckedChange={handleDangerousToggle}
              />
            </div>
            {dangerousError && (
              <p className="mt-1 text-[var(--destructive)] text-xs">
                {dangerousError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A null status is still-loading, NOT "no key" — the two must not collapse into
 * the same words, so the pre-read state stays an explicit ellipsis rather than
 * claiming the key is absent.
 */
function apiKeyValueLabel(status: ApiKeyStatusView | null): string {
  if (status === null) {
    return "...";
  }
  if (status.hasApiKey !== true) {
    return "Not configured";
  }
  const provenance = status.provenance ? `, ${status.provenance}` : "";
  return `Configured (${status.source}${provenance})`;
}
