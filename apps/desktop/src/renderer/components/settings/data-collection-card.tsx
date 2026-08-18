/**
 * @file data-collection-card.tsx
 * @description The Settings → General "Data Collection" card: one privacy
 * toggle per local agent tool Closedloop is allowed to read.
 *
 * Extracted from `SettingsPanel.tsx` (ISS-5768) to keep that grandfathered file
 * shrinking rather than growing, following the sibling pattern already
 * established by `data-sync-tab.tsx`, `labs-tab.tsx`, and
 * `security-flags-section.tsx`. Behaviour is unchanged.
 */
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { useCallback, useEffect, useState } from "react";
import { FEATURE_FLAGS } from "../../../shared/feature-flags";
import {
  SettingsToggleRow,
  SettingsToggleRowSkeleton,
  useFlagToggle,
} from "./settings-flag-toggle";

const DATA_COLLECTION_FLAGS = FEATURE_FLAGS.filter(
  (flag) => flag.category === "Data Collection"
);

export function DataCollectionCard() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
    null
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    window.desktopApi
      .getSettings()
      .then((s) => setSettings(s as Record<string, unknown>))
      .catch(() => {
        // A failed read must not fall back to the registry default (which would
        // render every tool ON — a privacy lie); surface an error instead of
        // hanging on the skeleton forever.
        setLoadFailed(true);
      });
  }, []);

  const setError = useCallback((key: string, message: string) => {
    setErrors((prev) => {
      if (!message) {
        if (!(key in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: message };
    });
  }, []);

  const { saving, handleToggle } = useFlagToggle(
    (updated) => setSettings(updated),
    setError
  );

  // Skeleton only while the first read is genuinely in flight — not after it
  // failed (settings is still null then, but a permanent skeleton would be worse
  // than an honest error).
  const loading = settings === null && !loadFailed;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Collection</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-[var(--muted-foreground)] text-sm">
          Choose which local agent tools Closedloop reads to populate your Agent
          Dashboard. Collection stays on your machine. Turn a tool off to stop
          reading its history entirely.
        </p>
        {loadFailed ? (
          <p className="text-[var(--destructive)] text-xs">
            Couldn't read your collection settings. Reopen Settings to try
            again.
          </p>
        ) : (
          <div className="space-y-3">
            {loading
              ? // Hold the switches behind a skeleton until getSettings resolves.
                // A privacy control must never assert a collection state it has
                // not actually read (the registry default would render every
                // tool ON, disabled — a small lie until the real values arrive).
                DATA_COLLECTION_FLAGS.map((flag) => (
                  <SettingsToggleRowSkeleton key={flag.key} />
                ))
              : DATA_COLLECTION_FLAGS.map((flag) => {
                  // Default ON: a freshly-loaded settings record may not yet carry
                  // the key, so fall back to the registry default rather than
                  // treating "absent" as off.
                  const raw = settings?.[flag.key];
                  const value = typeof raw === "boolean" ? raw : flag.default;
                  return (
                    <SettingsToggleRow
                      checked={value}
                      description={flag.description}
                      disabled={saving === flag.key}
                      error={errors[flag.key]}
                      key={flag.key}
                      label={flag.label}
                      onToggle={() => handleToggle(flag.key, value)}
                    />
                  );
                })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
