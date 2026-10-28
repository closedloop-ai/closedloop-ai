import type { GatewayProfileRowData } from "./gateway-profile-row";

/**
 * ISS-7043: the gateway-profile edit-form contract — the shape both the
 * New-profile dialog and the selected-profile editor bind to, plus the pure
 * seed/validate helpers over it.
 *
 * Extracted from SettingsPanel.tsx so that
 * file trends smaller per the repo file-size discipline, following the sibling
 * ProfileSandboxField (FEA-4005) and ProfileConnectionFields (ISS-4577) splits.
 * It is a `.ts` with no JSX so the presentational field components can import
 * the type without pulling a component runtime in behind it.
 */
export type GatewayProfileFormState = {
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  apiKey: string;
  /** FEA-4005: editable sandbox scope root for this profile. */
  sandboxBaseDirectory: string;
};

/** Which profile a failed apply/delete belongs to, so the error renders on its own row. */
export type ProfileActionError = { id: string; message: string } | null;

export function getProfileFormState(
  profile: Partial<GatewayProfileRowData> | null | undefined,
  settings: Record<string, unknown> | null
): GatewayProfileFormState {
  return {
    name: profile?.name ?? "",
    relayOrigin:
      profile?.relayOrigin ?? ((settings?.relayOrigin as string) || ""),
    apiOrigin: profile?.apiOrigin ?? ((settings?.apiOrigin as string) || ""),
    webAppOrigin:
      profile?.webAppOrigin ?? ((settings?.webAppOrigin as string) || ""),
    apiKey: "",
    // FEA-4005: seed the field only from the profile's OWN sandbox. Leaving it
    // empty means "inherit the global sandbox" — we no longer default it to the
    // current global value, which would silently pin a legacy profile to today's
    // global path on any unrelated Save (and then restore that stale snapshot on
    // a later Apply). The global sandbox is shown as a placeholder hint instead.
    sandboxBaseDirectory: profile?.sandboxBaseDirectory ?? "",
  };
}

export function isProfileFormComplete(form: GatewayProfileFormState): boolean {
  // The sandbox is optional (empty = inherit the global sandbox), so it does not
  // gate completeness; a bad non-empty value is rejected in the main process.
  return (
    form.name.trim().length > 0 &&
    form.relayOrigin.trim().length > 0 &&
    form.apiOrigin.trim().length > 0 &&
    form.webAppOrigin.trim().length > 0
  );
}
