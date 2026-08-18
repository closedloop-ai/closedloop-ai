import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import { type KeyboardEvent, useId } from "react";
import { ProfileSandboxField } from "./gateway-profile-sandbox-field";
import type { GatewayProfileFormState } from "./SettingsPanel";

/**
 * ISS-4577: the shared gateway-profile connection form (name, token, relay/api/
 * app URIs, and the per-profile sandbox field). Rendered by both the New-profile
 * dialog and the selected-profile editor in SettingsPanel.
 *
 * Extracted from the (grandfathered, shrink-only) SettingsPanel.tsx so that file
 * trends smaller per the repo file-size discipline, following the sibling
 * ProfileSandboxField split (FEA-4005).
 */
export function ProfileConnectionFields({
  form,
  onChange,
  onEnter,
  tokenPlaceholder,
  autoFocusName,
  globalSandbox,
  onSandboxValidityChange,
}: {
  form: GatewayProfileFormState;
  onChange: (patch: Partial<GatewayProfileFormState>) => void;
  onEnter?: () => void;
  tokenPlaceholder: string;
  autoFocusName?: boolean;
  /** FEA-4005: the current global sandbox, shown as the inherit-hint placeholder. */
  globalSandbox: string;
  /**
   * ISS-4577 (wongk review): bubble the sandbox field's known-invalid state up
   * so the owning Save button can be disabled for a settled risky/missing path.
   */
  onSandboxValidityChange?: (invalid: boolean) => void;
}) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      onEnter?.();
    }
  };
  const fieldIdPrefix = useId();
  const profileNameId = `${fieldIdPrefix}-name`;
  const authenticationTokenId = `${fieldIdPrefix}-authentication-token`;
  const relayUriId = `${fieldIdPrefix}-relay-uri`;
  const apiUriId = `${fieldIdPrefix}-api-uri`;
  const appUriId = `${fieldIdPrefix}-app-uri`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={profileNameId}>
          Profile Name
        </Label>
        <Input
          autoFocus={autoFocusName}
          id={profileNameId}
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Production"
          type="text"
          value={form.name}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={authenticationTokenId}>
          Authentication Token
        </Label>
        <Input
          autoComplete="off"
          className="font-mono text-xs"
          id={authenticationTokenId}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder={tokenPlaceholder}
          type="password"
          value={form.apiKey}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={relayUriId}>
          Relay URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={relayUriId}
          onChange={(e) => onChange({ relayOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://relay.closedloop.ai"
          type="text"
          value={form.relayOrigin}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={apiUriId}>
          API URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={apiUriId}
          onChange={(e) => onChange({ apiOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://api.closedloop.ai"
          type="text"
          value={form.apiOrigin}
        />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label className="text-xs" htmlFor={appUriId}>
          App URI
        </Label>
        <Input
          className="font-mono text-xs"
          id={appUriId}
          onChange={(e) => onChange({ webAppOrigin: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="https://app.closedloop.ai"
          type="text"
          value={form.webAppOrigin}
        />
      </div>
      <ProfileSandboxField
        globalSandbox={globalSandbox}
        onChange={(value) => onChange({ sandboxBaseDirectory: value })}
        onEnter={onEnter}
        onValidityChange={onSandboxValidityChange}
        value={form.sandboxBaseDirectory}
      />
    </div>
  );
}
