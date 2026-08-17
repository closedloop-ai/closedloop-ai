/**
 * @file audit-cascade-picker.tsx
 * @description FEA-4009 — the Audit Bot harness / model / cascade-order control.
 *
 * Lets the operator choose WHICH harnesses run (codex / claude / opencode), the
 * MODEL each drives with, and the ORDER they cascade in — instead of the fixed
 * codex → opencode → claude order. The available harnesses and their models are
 * sourced from crewd's canonical, renderer-safe registry data (`HarnessName` /
 * `AVAILABLE_MODELS` / `DEFAULT_MODEL` in `@repo/crewd/model`), NOT a hardcoded
 * list here, so the picker cannot offer a harness or model the runner does not
 * know about. (These are the exact maps `harness/capabilities.ts` reads from, so
 * importing them from the model leaf keeps this renderer-safe — no `node:` graph
 * — while staying the same SSOT.)
 *
 * The control is a reorderable, per-row checklist: each harness row has an
 * include toggle, a model picker, and up/down reorder buttons. The parent owns
 * the value as an ordered `CascadeStep[]` (only the INCLUDED harnesses, in
 * cascade order); disabled harnesses are shown below the enabled ones so they
 * can be re-added. Presentational only — no state lives here.
 *
 * Additive by design: an empty selection means "use the default cascade" and the
 * main process falls back accordingly, so this never breaks an older payload.
 */

import {
  AVAILABLE_MODELS,
  type CascadeStep,
  DEFAULT_MODEL,
  HarnessName,
} from "@repo/crewd/model";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { Label } from "@closedloop-ai/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@closedloop-ai/design-system/components/ui/select";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

/** Every harness the cascade can drive, in canonical display order. */
const ALL_HARNESSES: readonly HarnessName[] = [
  HarnessName.Codex,
  HarnessName.Opencode,
  HarnessName.Claude,
];

/** Human labels for each harness (display only; ids come from the registry). */
const HARNESS_LABEL: Record<HarnessName, string> = {
  [HarnessName.Codex]: "Codex",
  [HarnessName.Opencode]: "OpenCode",
  [HarnessName.Claude]: "Claude",
};

export type AuditCascadePickerProps = {
  /** The current ordered cascade — only the INCLUDED harnesses, in run order. */
  cascade: readonly CascadeStep[];
  /** Whether the controls are disabled (a run is in flight). */
  disabled?: boolean;
  /** Called with the next ordered cascade whenever the operator edits it. */
  onCascadeChange: (cascade: CascadeStep[]) => void;
};

/** One display row: an included, ordered step, or an available-but-off harness. */
type CascadeRow = {
  harness: HarnessName;
  /** The step's model, or the harness default when unset (⇒ shown selected). */
  model: string;
  /** True when this harness is part of the cascade (checked + ordered). */
  included: boolean;
};

/**
 * The reorderable harness / model / order control. Included steps render first
 * in cascade order; unincluded harnesses follow so they can be toggled on.
 */
export function AuditCascadePicker({
  cascade,
  disabled = false,
  onCascadeChange,
}: AuditCascadePickerProps) {
  const rows = buildRows(cascade);
  const includedCount = cascade.length;

  const toggle = (harness: HarnessName, next: boolean) => {
    onCascadeChange(toggleHarness(cascade, harness, next));
  };
  const changeModel = (harness: HarnessName, model: string) => {
    onCascadeChange(setModel(cascade, harness, model));
  };
  const move = (index: number, delta: number) => {
    onCascadeChange(moveStep(cascade, index, delta));
  };

  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <Label asChild>
        <legend>Harness cascade</legend>
      </Label>
      <p className="text-[var(--muted-foreground)] text-xs">
        Pick which harnesses run and the order they cascade in — the first to
        succeed wins. Leave all off to use the default order.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <CascadeRowItem
            canMoveDown={row.included && index < includedCount - 1}
            canMoveUp={row.included && index > 0}
            disabled={disabled}
            key={row.harness}
            onModelChange={(model) => changeModel(row.harness, model)}
            onMoveDown={() => move(index, 1)}
            onMoveUp={() => move(index, -1)}
            onToggle={(next) => toggle(row.harness, next)}
            position={row.included ? index + 1 : null}
            row={row}
          />
        ))}
      </ul>
    </fieldset>
  );
}

/** One harness row: include toggle + model picker + reorder buttons. */
function CascadeRowItem({
  row,
  position,
  canMoveUp,
  canMoveDown,
  disabled,
  onToggle,
  onModelChange,
  onMoveUp,
  onMoveDown,
}: {
  row: CascadeRow;
  /** 1-based cascade position when included, else null. */
  position: number | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  onModelChange: (model: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const label = HARNESS_LABEL[row.harness];
  const models = AVAILABLE_MODELS[row.harness];
  const checkboxId = `audit-harness-${row.harness}`;
  const modelId = `audit-model-${row.harness}`;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-5 text-center font-mono text-[var(--muted-foreground)] text-xs">
        {position ?? ""}
      </span>
      <Checkbox
        checked={row.included}
        disabled={disabled}
        id={checkboxId}
        onCheckedChange={(next) => onToggle(next === true)}
      />
      <Label className="min-w-24 font-normal" htmlFor={checkboxId}>
        {label}
      </Label>
      <Select
        disabled={disabled || !row.included}
        onValueChange={onModelChange}
        value={row.model}
      >
        <SelectTrigger
          aria-label={`${label} model`}
          className="w-52"
          id={modelId}
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model} value={model}>
              {model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="ml-auto flex items-center gap-1">
        <Button
          aria-label={`Move ${label} earlier`}
          disabled={disabled || !canMoveUp}
          onClick={onMoveUp}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronUpIcon aria-hidden />
        </Button>
        <Button
          aria-label={`Move ${label} later`}
          disabled={disabled || !canMoveDown}
          onClick={onMoveDown}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronDownIcon aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/**
 * Build the display rows: the included steps first (in cascade order, carrying
 * their chosen or default model), then every not-yet-included harness (in
 * canonical order) so it can be toggled on. A step whose harness is unknown to
 * THIS build is dropped from the display rather than crashing the picker
 * (version-skew safety), but it stays in the parent value untouched.
 */
function buildRows(cascade: readonly CascadeStep[]): CascadeRow[] {
  const included = new Set<HarnessName>();
  const rows: CascadeRow[] = [];
  for (const step of cascade) {
    if (!isKnownHarness(step.harness) || included.has(step.harness)) {
      continue;
    }
    included.add(step.harness);
    rows.push({
      harness: step.harness,
      model: step.model ?? DEFAULT_MODEL[step.harness],
      included: true,
    });
  }
  for (const harness of ALL_HARNESSES) {
    if (!included.has(harness)) {
      rows.push({ harness, model: DEFAULT_MODEL[harness], included: false });
    }
  }
  return rows;
}

/** Whether a harness id is one THIS build knows how to render/drive. */
function isKnownHarness(harness: string): harness is HarnessName {
  return (ALL_HARNESSES as readonly string[]).includes(harness);
}

/** Add or remove a harness from the ordered cascade, preserving its model. */
function toggleHarness(
  cascade: readonly CascadeStep[],
  harness: HarnessName,
  next: boolean
): CascadeStep[] {
  if (next) {
    if (cascade.some((step) => step.harness === harness)) {
      return [...cascade];
    }
    // A newly-included harness starts on its default model, appended last so it
    // cascades AFTER the already-chosen harnesses.
    return [...cascade, { harness }];
  }
  return cascade.filter((step) => step.harness !== harness);
}

/** Set the model for an included harness (default model ⇒ omit `model`). */
function setModel(
  cascade: readonly CascadeStep[],
  harness: HarnessName,
  model: string
): CascadeStep[] {
  return cascade.map((step) => {
    if (step.harness !== harness) {
      return step;
    }
    // Persist the default as an omitted model so the wire step matches "bare
    // harness" semantics (⇒ the harness's default model), keeping the payload
    // minimal and identical to the historical default cascade.
    return model === DEFAULT_MODEL[harness] ? { harness } : { harness, model };
  });
}

/** Move the step at `index` by `delta` within the included range (clamped). */
function moveStep(
  cascade: readonly CascadeStep[],
  index: number,
  delta: number
): CascadeStep[] {
  const target = index + delta;
  if (
    index < 0 ||
    index >= cascade.length ||
    target < 0 ||
    target >= cascade.length
  ) {
    return [...cascade];
  }
  const next = [...cascade];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}
