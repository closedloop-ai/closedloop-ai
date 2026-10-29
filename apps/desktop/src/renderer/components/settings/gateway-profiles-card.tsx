import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { Section } from "@closedloop-ai/design-system/components/ui/layout/section";
import { useEffect, useState } from "react";
import { cleanIpcError } from "../../clean-ipc-error";
import { ProfileConnectionFields } from "./gateway-profile-connection-fields";
import {
  type GatewayProfileFormState,
  getProfileFormState,
  isProfileFormComplete,
  type ProfileActionError,
} from "./gateway-profile-form";
import {
  GatewayProfileRow,
  type GatewayProfileRowData,
} from "./gateway-profile-row";

/**
 * ISS-7043: Settings → Relay/Gateway "Gateway Profiles" — the saved-profile
 * list plus the two editors over it (the New-profile dialog and the
 * selected-profile form), and the apply/rename/delete/save IPC around them.
 *
 * Extracted verbatim from SettingsPanel.tsx so
 * that file trends smaller per the repo file-size discipline. Profile CRUD is
 * the one part of the Relay/Gateway tab with its own dialog and its own
 * multi-row busy/error state, which is why it splits here rather than staying
 * with the tab's connection toggles.
 */
export function GatewayProfilesCard({
  settings,
  onSettingsChange,
}: {
  settings: Record<string, unknown> | null;
  onSettingsChange?: (s: Record<string, unknown>) => void;
}) {
  const savedConfigs =
    (settings?.savedConfigs as GatewayProfileRowData[]) ?? [];
  const activeConfigId = settings?.activeConfigId as string | null | undefined;
  const globalSandbox = (settings?.sandboxBaseDirectory as string) || "";
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    activeConfigId ?? null
  );
  const selectedProfile =
    savedConfigs.find((config) => config.id === selectedProfileId) ?? null;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [newProfileForm, setNewProfileForm] = useState<GatewayProfileFormState>(
    () => getProfileFormState(null, settings)
  );
  const [selectedForm, setSelectedForm] = useState<GatewayProfileFormState>(
    () => getProfileFormState(selectedProfile, settings)
  );
  // ISS-4577 (whitlockk review): the per-profile sandbox field reports whether its
  // current value is a KNOWN-invalid path (settled risky root / missing dir).
  // The New-profile dialog and the selected-profile editor each gate their Save
  // on it so an invalid sandbox can no longer be persisted despite the inline
  // warning. Blank (inherit the global sandbox) is never invalid.
  const [newProfileSandboxInvalid, setNewProfileSandboxInvalid] =
    useState(false);
  const [selectedProfileSandboxInvalid, setSelectedProfileSandboxInvalid] =
    useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [applyError, setApplyError] = useState<ProfileActionError>(null);
  const [deleteError, setDeleteError] = useState<ProfileActionError>(null);

  const refreshSettings = async () => {
    const updated = await window.desktopApi.getSettings();
    onSettingsChange?.(updated as Record<string, unknown>);
  };

  useEffect(() => {
    if (savedConfigs.length === 0) {
      setSelectedProfileId(null);
      return;
    }
    if (
      selectedProfileId &&
      savedConfigs.some((config) => config.id === selectedProfileId)
    ) {
      return;
    }
    setSelectedProfileId(activeConfigId ?? savedConfigs[0]?.id ?? null);
  }, [activeConfigId, savedConfigs, selectedProfileId]);

  useEffect(() => {
    setSelectedForm(getProfileFormState(selectedProfile, settings));
    setProfileSaveError(null);
  }, [selectedProfile, settings]);

  const handleApplyProfile = async (id: string) => {
    setSelectedProfileId(id);
    setApplying(id);
    setApplyError(null);
    try {
      await window.desktopApi.applyConfig(id);
      await refreshSettings();
    } catch (err) {
      setApplyError({
        id,
        message: cleanIpcError(err, "Failed to apply profile"),
      });
    } finally {
      setApplying(null);
    }
  };

  const handleOpenDialog = () => {
    setNewProfileForm(getProfileFormState(null, settings));
    setSaveError(null);
    setDialogOpen(true);
  };

  const startRename = (id: string, currentName: string) => {
    setRenaming(id);
    setRenameValue(currentName);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
    setRenameError(null);
  };

  const handleRename = async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("Name is required");
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await window.desktopApi.renameConfig(id, trimmed);
      await refreshSettings();
      setRenaming(null);
      setRenameValue("");
    } catch (err) {
      setRenameError(cleanIpcError(err, "Failed to rename profile"));
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDeleteConfirm = async (id: string) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await window.desktopApi.deleteConfig(id);
      await refreshSettings();
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError({
        id,
        message: cleanIpcError(err, "Failed to delete profile"),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!isProfileFormComplete(newProfileForm)) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const payload: {
        name: string;
        relayOrigin: string;
        apiOrigin: string;
        webAppOrigin: string;
        apiKey?: string;
        sandboxBaseDirectory?: string;
      } = {
        name: newProfileForm.name,
        relayOrigin: newProfileForm.relayOrigin,
        apiOrigin: newProfileForm.apiOrigin,
        webAppOrigin: newProfileForm.webAppOrigin,
      };
      const apiKey = newProfileForm.apiKey.trim();
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      const sandbox = newProfileForm.sandboxBaseDirectory.trim();
      if (sandbox) {
        payload.sandboxBaseDirectory = sandbox;
      }
      const saved = (await window.desktopApi.saveConfig(payload)) as {
        id?: string;
      };
      await refreshSettings();
      if (saved.id) {
        setSelectedProfileId(saved.id);
      }
      setDialogOpen(false);
    } catch (err) {
      setSaveError(cleanIpcError(err, "Failed to save profile"));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSelectedProfile = async () => {
    if (!(selectedProfile && isProfileFormComplete(selectedForm))) {
      return;
    }
    setProfileSaving(true);
    setProfileSaveError(null);
    try {
      const payload: {
        id: string;
        name: string;
        relayOrigin: string;
        apiOrigin: string;
        webAppOrigin: string;
        apiKey?: string;
        sandboxBaseDirectory?: string;
      } = {
        id: selectedProfile.id,
        name: selectedForm.name,
        relayOrigin: selectedForm.relayOrigin,
        apiOrigin: selectedForm.apiOrigin,
        webAppOrigin: selectedForm.webAppOrigin,
      };
      const apiKey = selectedForm.apiKey.trim();
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      const sandbox = selectedForm.sandboxBaseDirectory.trim();
      if (sandbox) {
        payload.sandboxBaseDirectory = sandbox;
      }
      await window.desktopApi.saveConfig(payload);
      await refreshSettings();
      setSelectedForm((current) => ({ ...current, apiKey: "" }));
    } catch (err) {
      setProfileSaveError(cleanIpcError(err, "Failed to save profile"));
    } finally {
      setProfileSaving(false);
    }
  };

  return (
    <>
      <Section
        actions={
          <Button onClick={handleOpenDialog} size="sm" variant="outline">
            Save Profile
          </Button>
        }
        description="Saved sets of relay, API, and token settings you can switch between. Add a profile when you regularly move between environments so you can apply a whole configuration at once."
        title="Gateway Profiles"
      >
        {savedConfigs.length === 0 ? (
          <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
            No gateway profiles saved
          </p>
        ) : (
          <div className="space-y-2">
            {savedConfigs.map((config) => (
              <GatewayProfileRow
                applyError={
                  applyError?.id === config.id ? applyError.message : null
                }
                applying={applying === config.id}
                confirmingDelete={confirmDeleteId === config.id}
                deleteError={
                  deleteError?.id === config.id ? deleteError.message : null
                }
                deleting={deleting}
                globalSandbox={globalSandbox}
                isActive={config.id === activeConfigId}
                isRenaming={renaming === config.id}
                isSelected={config.id === selectedProfileId}
                key={config.id}
                onApply={() => {
                  handleApplyProfile(config.id).catch(() => {});
                }}
                onCancelDelete={() => {
                  setConfirmDeleteId(null);
                  setDeleteError(null);
                }}
                onCancelRename={cancelRename}
                onConfirmDelete={() => {
                  handleDeleteConfirm(config.id).catch(() => {});
                }}
                onRename={() => {
                  handleRename(config.id).catch(() => {});
                }}
                onRenameValueChange={(v) => {
                  setRenameValue(v);
                  setRenameError(null);
                }}
                onSelect={() => {
                  setSelectedProfileId(config.id);
                }}
                onStartDelete={() => {
                  setConfirmDeleteId(config.id);
                  setDeleteError(null);
                }}
                onStartRename={() => startRename(config.id, config.name)}
                profile={config}
                renameBusy={renameBusy}
                renameError={renameError}
                renameValue={renameValue}
              />
            ))}
          </div>
        )}
        {selectedProfile && (
          <div
            className="mt-4 space-y-3 border-t pt-4"
            data-testid={GATEWAY_PROFILE_EDITOR_TEST_ID}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-sm">Selected Profile</p>
                <p className="truncate text-[var(--muted-foreground)] text-xs">
                  {selectedProfile.name}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {selectedProfile.hasCloudApiKey && (
                  <Badge className="text-[10px]" variant="outline">
                    Token saved
                  </Badge>
                )}
                {selectedProfile.id === activeConfigId && (
                  <Badge className="text-[10px]" variant="default">
                    Active
                  </Badge>
                )}
              </div>
            </div>
            <ProfileConnectionFields
              form={selectedForm}
              globalSandbox={globalSandbox}
              onChange={(patch) => {
                setSelectedForm((current) => ({ ...current, ...patch }));
                setProfileSaveError(null);
              }}
              onEnter={() => {
                if (
                  !(
                    profileSaving ||
                    !isProfileFormComplete(selectedForm) ||
                    selectedProfileSandboxInvalid
                  )
                ) {
                  handleSaveSelectedProfile().catch(() => {});
                }
              }}
              onSandboxValidityChange={setSelectedProfileSandboxInvalid}
              tokenPlaceholder={
                selectedProfile.hasCloudApiKey
                  ? "Leave blank to keep saved token"
                  : "sk_live_..."
              }
            />
            {profileSaveError && (
              <p className="text-[var(--destructive)] text-xs">
                {profileSaveError}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                disabled={
                  profileSaving ||
                  !isProfileFormComplete(selectedForm) ||
                  selectedProfileSandboxInvalid
                }
                onClick={() => {
                  handleSaveSelectedProfile().catch(() => {});
                }}
                size="sm"
                variant="default"
              >
                {profileSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Current Configuration as Profile</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-[var(--muted-foreground)] text-sm">
              Enter a name and connection settings for this gateway profile.
            </p>
            <ProfileConnectionFields
              autoFocusName
              form={newProfileForm}
              globalSandbox={globalSandbox}
              onChange={(patch) => {
                setNewProfileForm((current) => ({ ...current, ...patch }));
                setSaveError(null);
              }}
              onEnter={() => {
                if (
                  !(
                    saving ||
                    !isProfileFormComplete(newProfileForm) ||
                    newProfileSandboxInvalid
                  )
                ) {
                  handleSaveProfile().catch(() => {});
                }
              }}
              onSandboxValidityChange={setNewProfileSandboxInvalid}
              tokenPlaceholder="sk_live_..."
            />
            {saveError && (
              <p className="text-[var(--destructive)] text-xs">{saveError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => setDialogOpen(false)}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={
                saving ||
                !isProfileFormComplete(newProfileForm) ||
                newProfileSandboxInvalid
              }
              onClick={() => {
                handleSaveProfile().catch(() => {});
              }}
              variant="default"
            >
              {saving ? "Saving..." : "Save Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Same reason as GATEWAY_PROFILE_ROW_TEST_ID: the card renders the connection
// form twice at once, so every editor query must be scoped, and a utility class
// is not a contract.
export const GATEWAY_PROFILE_EDITOR_TEST_ID = "gateway-profile-editor";
