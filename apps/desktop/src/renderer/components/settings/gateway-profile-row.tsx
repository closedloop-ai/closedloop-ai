import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { Pencil, Trash2 } from "lucide-react";

/**
 * A saved gateway profile as projected onto the Settings → Relay/Gateway
 * profiles list. Extracted from SettingsPanel.tsx (FEA-4005) so that
 * grandfathered file trends smaller per the repo file-size discipline.
 */
export type GatewayProfileRowData = {
  id: string;
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  hasCloudApiKey?: boolean;
  apiKeySource?: string;
  /**
   * FEA-4005: per-profile sandbox scope root. Absent on profiles saved before
   * this field existed — those fall back to the global sandbox on apply.
   */
  sandboxBaseDirectory?: string;
};

export type GatewayProfileRowProps = {
  profile: GatewayProfileRowData;
  globalSandbox: string;
  isActive: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameError: string | null;
  renameBusy: boolean;
  applying: boolean;
  applyError: string | null;
  confirmingDelete: boolean;
  deleting: boolean;
  deleteError: string | null;
  onStartRename: () => void;
  onRenameValueChange: (value: string) => void;
  onRename: () => void;
  onCancelRename: () => void;
  onSelect: () => void;
  onApply: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

export function GatewayProfileRow({
  profile,
  globalSandbox,
  isActive,
  isSelected,
  isRenaming,
  renameValue,
  renameError,
  renameBusy,
  applying,
  applyError,
  confirmingDelete,
  deleting,
  deleteError,
  onStartRename,
  onRenameValueChange,
  onRename,
  onCancelRename,
  onSelect,
  onApply,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: GatewayProfileRowProps) {
  return (
    <div
      className={`rounded border p-3 text-sm ${isSelected ? "border-[var(--primary)] bg-[var(--primary)]/5" : ""}`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <Input
              aria-label="Rename profile"
              autoFocus
              className="h-7 w-full text-sm"
              disabled={renameBusy}
              onChange={(e) => onRenameValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename();
                }
                if (e.key === "Escape") {
                  onCancelRename();
                }
              }}
              type="text"
              value={renameValue}
            />
          ) : (
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{profile.name}</p>
              {isActive && (
                <Badge className="shrink-0 text-[10px]" variant="default">
                  Active
                </Badge>
              )}
            </div>
          )}
          <p className="mt-0.5 truncate font-mono text-[var(--muted-foreground)] text-xs">
            {profile.relayOrigin}
          </p>
          <p className="mt-0.5 truncate font-mono text-[var(--muted-foreground)] text-xs">
            {profile.apiOrigin} - {profile.webAppOrigin}
          </p>
          <p className="mt-0.5 truncate font-mono text-[var(--muted-foreground)] text-xs">
            {profile.sandboxBaseDirectory
              ? `Sandbox: ${profile.sandboxBaseDirectory}`
              : `Sandbox: inherits global${globalSandbox ? ` (${globalSandbox})` : ""}`}
          </p>
        </div>
        <div className="ml-2 flex shrink-0 gap-2">
          {isRenaming ? (
            <>
              <Button
                disabled={renameBusy}
                onClick={onRename}
                size="sm"
                variant="outline"
              >
                {renameBusy ? "Saving..." : "Save"}
              </Button>
              <Button
                disabled={renameBusy}
                onClick={onCancelRename}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                aria-label="Rename profile"
                onClick={onStartRename}
                size="sm"
                title="Rename profile"
                variant="ghost"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label="Delete profile"
                onClick={onStartDelete}
                size="sm"
                title="Delete profile"
                variant="ghost"
              >
                <Trash2 className="h-3.5 w-3.5 text-[var(--destructive)]" />
              </Button>
              {!isSelected && (
                <Button onClick={onSelect} size="sm" variant="ghost">
                  Select
                </Button>
              )}
              {!isActive && (
                <Button
                  disabled={applying}
                  onClick={onApply}
                  size="sm"
                  variant="outline"
                >
                  {applying ? "Applying..." : "Apply"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {isRenaming && renameError && (
        <p className="mt-1 text-[var(--destructive)] text-xs">{renameError}</p>
      )}
      {applyError && (
        <p className="mt-1 text-[var(--destructive)] text-xs">{applyError}</p>
      )}
      {confirmingDelete && (
        <div className="mt-2 rounded border border-[var(--destructive)] bg-[var(--destructive)]/5 px-3 py-2">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[var(--destructive)] text-xs">
              Delete "{profile.name}"? This cannot be undone.
            </p>
            <Button
              disabled={deleting}
              onClick={onConfirmDelete}
              size="sm"
              variant="destructive"
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
            <Button
              disabled={deleting}
              onClick={onCancelDelete}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
          {deleteError && (
            <p className="mt-2 text-[var(--destructive)] text-xs">
              {deleteError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
