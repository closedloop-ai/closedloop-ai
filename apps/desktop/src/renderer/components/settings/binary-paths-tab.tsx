import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { useEffect, useState } from "react";
import {
  type BinaryResolveSource,
  CLI_BINARY_TOOLS,
} from "../../../shared/cli-binary-tools";
import { cleanIpcError } from "../../clean-ipc-error";
import { DataCollectionCard } from "./data-collection-card";

// One tool's resolved state, as returned by `detectCliTools()`. `source`
// mirrors the resolver's BinaryResolveResult.source: a real path was found via
// an override, the login-shell PATH, or a known install location — or nothing
// was found ("fallback").
type BinaryDetectEntry = {
  name: string;
  override: string | null;
  source: BinaryResolveSource;
  resolvedPath: string | null;
};

// Single edge for the CLI-tool text column: both the resolved mono path line
// and the not-found guidance cap at this width so they share one column edge
// (rather than two hand-picked pixel widths). `max-w-xs` is the on-scale
// Tailwind token (20rem), not an arbitrary value. FEA-3742.
const CLI_TEXT_COLUMN = "max-w-xs";

/**
 * ISS-7043: Settings → Binary Paths — the per-tool collector toggles
 * (DataCollectionCard, FEA-3741) above the CLI-tool resolution list and its
 * per-tool override editor.
 *
 * Moved out of SettingsPanel.tsx so that file
 * trends smaller per the repo file-size discipline. The body moved unchanged
 * EXCEPT for the editor / resolved-path / not-found ternary chain, which became
 * the `cliToolStatusColumn` helper below — the one place this move could have
 * changed behavior, so re-derive that helper rather than the rest when auditing
 * the split.
 */
export function BinaryPathsTab() {
  const [detected, setDetected] = useState<Record<string, BinaryDetectEntry>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Run detection (login-shell PATH + known-location probe) so the tab shows
  // the actual resolved binary, not just manually-set overrides. FEA-3742.
  useEffect(() => {
    window.desktopApi
      .detectCliTools()
      .then((result) => {
        setDetected(coerceDetectMap(result));
        setLoading(false);
      })
      .catch(() => {
        // IPC rejected: stop showing the loading placeholder so the tab does
        // not hang on "Detecting tools...".
        setLoading(false);
      });
  }, []);

  const handleDetect = async () => {
    setLoading(true);
    try {
      const result = await window.desktopApi.detectCliTools();
      setDetected(coerceDetectMap(result));
    } catch {
      // IPC rejected: leave state as-is but stop the loading placeholder.
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (tool: string) => {
    setEditing(tool);
    setEditValue(
      detected[tool]?.override ?? detected[tool]?.resolvedPath ?? ""
    );
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditError(null);
  };

  const handleSave = async (tool: string) => {
    try {
      // Empty input clears the override (null), which re-enables auto-detection
      // — this is the "clear it to auto-detect again" remedy the not-found copy
      // points users at. A non-empty value sets the override. FEA-3742.
      await window.desktopApi.patchBinaryPaths({
        [tool]: editValue ? editValue : null,
      });
      const result = await window.desktopApi.detectCliTools();
      setDetected(coerceDetectMap(result));
    } catch (err) {
      setEditError(cleanIpcError(err, "Failed to save binary path"));
      return;
    }
    setEditing(null);
    setEditError(null);
  };

  return (
    <div className="mt-4 space-y-4">
      <DataCollectionCard />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>CLI Tools</CardTitle>
            <Button
              disabled={loading}
              onClick={handleDetect}
              size="sm"
              variant="outline"
            >
              Detect Tools
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              Detecting tools...
            </p>
          ) : (
            CLI_BINARY_TOOLS.map((tool) => (
              <div
                className="flex items-start justify-between rounded border p-3"
                key={tool}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{tool}</p>
                  {cliToolStatusColumn({
                    editError,
                    editValue,
                    entry: detected[tool],
                    isEditing: editing === tool,
                    onCancel: cancelEdit,
                    onEditValueChange: setEditValue,
                    onSave: handleSave,
                    tool,
                  })}
                </div>
                <div className="ml-2 flex shrink-0 gap-2">
                  {editing === tool ? (
                    <>
                      <Button
                        onClick={() => handleSave(tool)}
                        size="sm"
                        variant="outline"
                      >
                        Save
                      </Button>
                      <Button onClick={cancelEdit} size="sm" variant="ghost">
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() => startEdit(tool)}
                      size="sm"
                      variant="outline"
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Actionable "why we couldn't resolve this CLI" status shown in place of a
// resolved path. Distinguishes a bad manual override from a genuine
// not-found-anywhere state, and points the user at the self-serve remedies
// (Detect Tools / Edit override / `which`). FEA-3742.
function BinaryNotFoundStatus({
  tool,
  overrideInvalid,
}: {
  tool: string;
  overrideInvalid: boolean;
}) {
  return (
    <div className="mt-0.5 space-y-0.5">
      <p className="font-medium text-[var(--destructive)] text-xs">
        {overrideInvalid ? "Override path is invalid" : "Not found"}
      </p>
      <p
        className={`${CLI_TEXT_COLUMN} text-[var(--muted-foreground)] text-xs leading-snug`}
      >
        {overrideInvalid ? (
          <>
            The path you set doesn&apos;t exist or isn&apos;t executable. Click{" "}
            <span className="font-medium">Edit</span> to correct it, or clear it
            to auto-detect again.
          </>
        ) : (
          <>
            Couldn&apos;t find {tool}. If it&apos;s installed, try{" "}
            <span className="font-medium">Detect Tools</span>, or{" "}
            <span className="font-medium">Edit</span> to set its full path (run{" "}
            <code className="font-mono">which {tool}</code> to find it).
          </>
        )}
      </p>
    </div>
  );
}

function coerceDetectMap(raw: unknown): Record<string, BinaryDetectEntry> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, BinaryDetectEntry> = {};
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === "object" && "source" in value) {
      out[tool] = value as BinaryDetectEntry;
    }
  }
  return out;
}

/**
 * The tool's editor / resolved-path / not-found column. A plain function rather
 * than a component so it inlines into the row exactly as the ternary chain it
 * replaced did, leaving reconciliation (and the editor's autoFocus) unchanged
 * while satisfying the repo's no-nested-ternary rule.
 */
function cliToolStatusColumn({
  editError,
  editValue,
  entry,
  isEditing,
  onCancel,
  onEditValueChange,
  onSave,
  tool,
}: {
  editError: string | null;
  editValue: string;
  entry: BinaryDetectEntry | undefined;
  isEditing: boolean;
  onCancel: () => void;
  onEditValueChange: (value: string) => void;
  onSave: (tool: string) => Promise<void>;
  tool: string;
}) {
  if (isEditing) {
    return (
      <>
        <Input
          aria-label={tool}
          autoFocus
          className="mt-1 w-full font-mono text-xs"
          onChange={(e) => onEditValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSave(tool).catch(() => {});
            }
            if (e.key === "Escape") {
              onCancel();
            }
          }}
          placeholder={`/usr/bin/${tool}`}
          type="text"
          value={editValue}
        />
        {editError && (
          <p className="mt-1 text-[var(--destructive)] text-xs">{editError}</p>
        )}
      </>
    );
  }
  const found =
    entry != null &&
    entry.source !== "fallback" &&
    entry.source !== "override_invalid" &&
    entry.resolvedPath != null;
  if (found) {
    return (
      <p
        className={`${CLI_TEXT_COLUMN} truncate font-mono text-[var(--muted-foreground)] text-xs`}
      >
        {entry.resolvedPath}
      </p>
    );
  }
  return (
    <BinaryNotFoundStatus
      overrideInvalid={entry?.source === "override_invalid"}
      tool={tool}
    />
  );
}
