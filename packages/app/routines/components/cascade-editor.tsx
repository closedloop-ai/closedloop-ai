"use client";

import {
  AVAILABLE_MODELS,
  type CascadeStep,
  DEFAULT_MODEL,
  HarnessName,
  harnessNameSchema,
} from "@repo/crewd/model";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

/**
 * The ordered, reorderable `(harness, model)` cascade editor (FEA-3853/3855).
 * Each step names a harness and the model to drive it with; the first step is
 * the default, later steps are fallbacks tried in order. Models come from the
 * crewd `AVAILABLE_MODELS` enumeration per harness (FEA-3855) — never a hardcoded
 * list here — with a leading "Default" option that leaves the step's `model`
 * unset (⇒ the harness default). Add / remove / move up / move down; the caller
 * owns the `steps` array and receives the reordered result on every change.
 *
 * Agnostic: nothing about a specific model is baked in. A harness with no listed
 * models still offers "Default", and switching a harness resets the model to its
 * default so a step never carries a model the new harness cannot drive.
 */

const HARNESS_OPTIONS = harnessNameSchema.options;
const MODEL_DEFAULT_VALUE = "__default__";

export function CascadeEditor({
  steps,
  onChange,
}: {
  steps: CascadeStep[];
  onChange: (next: CascadeStep[]) => void;
}) {
  const setStep = (index: number, step: CascadeStep) => {
    onChange(steps.map((existing, i) => (i === index ? step : existing)));
  };
  const removeStep = (index: number) => {
    onChange(steps.filter((_, i) => i !== index));
  };
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) {
      return;
    }
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const addStep = () => {
    onChange([...steps, { harness: HarnessName.Codex }]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Cascade</Label>
        <span className="text-muted-foreground text-xs">
          First step runs; later steps are fallbacks.
        </span>
      </div>
      {steps.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground text-sm">
          No cascade steps. The routine runs on the default harness order.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <CascadeStepRow
              canMoveDown={index < steps.length - 1}
              canMoveUp={index > 0}
              // biome-ignore lint/suspicious/noArrayIndexKey: cascade steps are an ordered positional list with no stable id; position IS the identity.
              key={index}
              onMoveDown={() => move(index, 1)}
              onMoveUp={() => move(index, -1)}
              onRemove={() => removeStep(index)}
              onStepChange={(next) => setStep(index, next)}
              position={index + 1}
              step={step}
            />
          ))}
        </ol>
      )}
      <div>
        <Button
          className="gap-1.5"
          onClick={addStep}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden className="size-3.5" />
          Add step
        </Button>
      </div>
    </div>
  );
}

function CascadeStepRow({
  step,
  position,
  canMoveUp,
  canMoveDown,
  onStepChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  step: CascadeStep;
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStepChange: (next: CascadeStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const models = AVAILABLE_MODELS[step.harness];
  const modelValue = step.model ?? MODEL_DEFAULT_VALUE;

  const onHarnessChange = (value: string) => {
    const parsed = harnessNameSchema.safeParse(value);
    if (parsed.success) {
      // Reset the model on a harness switch so a step never keeps a model the
      // new harness cannot drive.
      onStepChange({ harness: parsed.data });
    }
  };
  const onModelChange = (value: string) => {
    onStepChange({
      harness: step.harness,
      model: value === MODEL_DEFAULT_VALUE ? undefined : value,
    });
  };

  return (
    <li className="flex items-center gap-2 rounded-md border p-2">
      <span className="w-5 shrink-0 text-center text-muted-foreground text-xs tabular-nums">
        {position}
      </span>
      <Select onValueChange={onHarnessChange} value={step.harness}>
        <SelectTrigger aria-label={`Step ${position} harness`} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HARNESS_OPTIONS.map((harness) => (
            <SelectItem key={harness} value={harness}>
              {harness}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select onValueChange={onModelChange} value={modelValue}>
        <SelectTrigger
          aria-label={`Step ${position} model`}
          className="min-w-0 flex-1"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MODEL_DEFAULT_VALUE}>
            {`Default (${DEFAULT_MODEL[step.harness]})`}
          </SelectItem>
          {models.map((model) => (
            <SelectItem key={model} value={model}>
              {model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex shrink-0 items-center">
        <Button
          aria-label={`Move step ${position} up`}
          disabled={!canMoveUp}
          onClick={onMoveUp}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowUpIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          aria-label={`Move step ${position} down`}
          disabled={!canMoveDown}
          onClick={onMoveDown}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowDownIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          aria-label={`Remove step ${position}`}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
