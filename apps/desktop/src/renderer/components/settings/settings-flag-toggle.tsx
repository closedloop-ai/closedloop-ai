import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import { type ReactNode, useCallback, useState } from "react";
import { cleanIpcError } from "../../clean-ipc-error";

// The single labelled toggle row shared by the Labs, Data Collection, and CLI
// Tools cards (and any future settings card): one bordered row with a min-w-0
// label, a muted description, an optional trailing slot (e.g. a category Badge),
// a shrink-0 Switch, and an optional inline error underneath. Extracted so the
// copies of this markup cannot drift a pixel apart.
export function SettingsToggleRow({
  label,
  description,
  checked,
  disabled,
  onToggle,
  trailing,
  note,
  error,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  // Rendered inline after the label (e.g. a category Badge).
  trailing?: ReactNode;
  // Rendered on its own line below the description (e.g. a "Requires restart"
  // hint).
  note?: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="rounded border p-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm">{label}</p>
            {trailing}
          </div>
          <p className="mt-0.5 text-[var(--muted-foreground)] text-xs">
            {description}
          </p>
          {note}
        </div>
        <Switch
          aria-label={`Toggle ${label}`}
          checked={checked}
          className="ml-3 shrink-0"
          disabled={disabled}
          onCheckedChange={onToggle}
        />
      </div>
      {error && (
        <p className="mt-1 text-[var(--destructive)] text-xs">{error}</p>
      )}
    </div>
  );
}

// The "Requires restart" hint shown under a flag whose value the db-host only
// reads at init (openDatabase), so a live toggle only takes effect after an app
// restart. Shared by the Labs and CLI Tools cards so the two copies cannot drift
// (and so the type scale stays on-token: text-xs, not an off-scale text-[10px]).
export function RequiresRestartNote() {
  return (
    <p className="mt-0.5 text-[var(--warning-foreground)] text-xs">
      Requires restart
    </p>
  );
}

// The loading placeholder for SettingsToggleRow: the same bordered row shape
// with skeletons standing in for the label, description, and switch. Shared so a
// settings card holds a control behind a skeleton until its read resolves (never
// rendering a registry-default value it has not actually read) without each card
// re-copying the markup — the copies were drifting a pixel apart.
export function SettingsToggleRowSkeleton() {
  return (
    <div className="flex items-center justify-between rounded border p-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
      <Skeleton className="ml-3 h-5 w-9 shrink-0 rounded-full" />
    </div>
  );
}

// FEA-2842 / FEA-3741: the shared settings-flag toggle handler. Optimistically
// flips a boolean flag through the updateSettings IPC and re-reads the canonical
// settings record. `onError` is optional: privacy-sensitive cards (Data
// Collection) and opt-in CLI Tools cards pass a setter so a failed change
// surfaces inline rather than snapping back silently; experimental Labs flags
// leave it undefined to keep the existing best-effort behavior.
export function useFlagToggle(
  onUpdated: (settings: Record<string, unknown>) => void,
  onError?: (key: string, message: string) => void
) {
  const [saving, setSaving] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (key: string, currentValue: boolean) => {
      setSaving(key);
      onError?.(key, "");
      try {
        await window.desktopApi.updateSettings({ [key]: !currentValue });
        const updated = await window.desktopApi.getSettings();
        onUpdated(updated as Record<string, unknown>);
      } catch (err) {
        onError?.(key, cleanIpcError(err, "Failed to update setting"));
      }
      setSaving(null);
    },
    [onUpdated, onError]
  );

  return { saving, handleToggle };
}
