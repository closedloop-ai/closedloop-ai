/**
 * @file audit-run-controls.tsx
 * @description FEA-3850 (PRD-556 M4) / FEA-4013 — the Audit Bot run controls: the
 * character picker, the scope-preset selector, the repo picker, and the Run
 * button.
 *
 * The character picker ({@link AuditCharacterPicker}) offers the FULL cast of
 * review characters, searchable by name or focus; the scope selector chooses
 * what the run reviews (docs / changed-since-main / whole-repo). Both are driven
 * off the shared `audit-contract`, so a new character file (after a roster
 * regenerate) or a new scope surfaces here with no change to this file.
 * Presentational only — all state (selected character/scope, repo dir) lives in
 * the parent view.
 */

import { AuditScope, type CascadeStep } from "@repo/crewd/model";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@closedloop-ai/design-system/components/ui/select";
import { FolderOpenIcon, PlayIcon, ShieldAlertIcon } from "lucide-react";
import {
  AUDIT_SCOPE_META,
  type AuditCharacterId,
  characterMetaFor,
} from "../../../shared/audit-contract";
import { DashboardCard } from "../layout/page-shell";
import { AuditCascadePicker } from "./audit-cascade-picker";
import { AuditCharacterPicker } from "./audit-character-picker";

/** The scope presets offered in the selector, in display order. */
const SCOPE_OPTIONS: readonly AuditScope[] = [
  AuditScope.WholeRepo,
  AuditScope.ChangedSinceMain,
  AuditScope.Docs,
];

export type AuditRunControlsProps = {
  character: AuditCharacterId;
  scope: AuditScope;
  /** The operator-selected harness cascade (FEA-4009); empty ⇒ default order. */
  cascade: readonly CascadeStep[];
  repoDir: string | null;
  repoWarning: string | null;
  running: boolean;
  onCharacterChange: (character: AuditCharacterId) => void;
  onScopeChange: (scope: AuditScope) => void;
  onCascadeChange: (cascade: CascadeStep[]) => void;
  onPick: () => void;
  onRun: () => void;
};

/**
 * The character + scope pickers, the harness / model / cascade-order control
 * (FEA-4009), the repo picker, and the Run button for one audit.
 */
export function AuditRunControls({
  character,
  scope,
  cascade,
  repoDir,
  repoWarning,
  running,
  onCharacterChange,
  onScopeChange,
  onCascadeChange,
  onPick,
  onRun,
}: AuditRunControlsProps) {
  const characterMeta = characterMetaFor(character);
  return (
    <DashboardCard title="Run an audit">
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-character">Review character</Label>
            <AuditCharacterPicker
              disabled={running}
              id="audit-character"
              onChange={onCharacterChange}
              value={character}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-scope">Scope</Label>
            <Select
              disabled={running}
              onValueChange={(value) => onScopeChange(value as AuditScope)}
              value={scope}
            >
              <SelectTrigger className="w-full" id="audit-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {AUDIT_SCOPE_META[option].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-[var(--muted-foreground)] text-sm">
          {characterMeta
            ? `${characterMeta.description} `
            : "This review character isn't available in this build — pick another. "}
          {AUDIT_SCOPE_META[scope].description}
        </p>

        <AuditCascadePicker
          cascade={cascade}
          disabled={running}
          onCascadeChange={onCascadeChange}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={running}
            onClick={onPick}
            type="button"
            variant="outline"
          >
            <FolderOpenIcon aria-hidden />
            {repoDir ? "Change repo" : "Choose repo"}
          </Button>
          <Button disabled={!repoDir || running} onClick={onRun} type="button">
            <PlayIcon aria-hidden />
            {running ? "Running…" : "Run audit"}
          </Button>
          {repoDir ? (
            <span className="truncate font-mono text-[var(--muted-foreground)] text-xs">
              {repoDir}
            </span>
          ) : null}
        </div>
        {repoWarning ? (
          <Badge variant="warning">
            <ShieldAlertIcon aria-hidden />
            {repoWarning}
          </Badge>
        ) : null}
      </div>
    </DashboardCard>
  );
}
