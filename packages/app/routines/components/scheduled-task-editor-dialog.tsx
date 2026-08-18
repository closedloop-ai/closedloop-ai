"use client";

import {
  type CascadeStep,
  PassKind,
  type ScheduledTask,
  TaskRoute,
} from "@repo/crewd/model";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { formatDateTimeOrFallback } from "../../shared/lib/date-utils";
import { parseScheduleText, SCHEDULE_PRESETS } from "../lib/schedule-parse";
import { CascadeEditor } from "./cascade-editor";
import type { RoutinesDataSource } from "./routines-view";

/**
 * The create/edit routine modal (PRD-566 / FEA-4348; formerly the Scheduled
 * Task editor, FEA-3853), one screen:
 *   1. Name
 *   2. Schedule — a natural-language input ("every weekday at 9am") with preset
 *      chips (Daily / Weekdays / Weekly / Hourly) and a live "next 3 runs"
 *      preview validated by the crewd cron primitive through the data source.
 *   3. Task body — a prompt (custom) or a named pass.
 *   4. The agnostic `(harness, model)` cascade — an ordered, reorderable list
 *      (see CascadeEditor). Models come from the FEA-3855 enumeration, never a
 *      hardcoded list.
 *
 * Save routes through `dataSource.create` / `dataSource.update`; the payload is
 * re-validated at the IPC boundary with the crewd schema, so this form is the
 * ergonomic layer, not the trust boundary. Surface-agnostic: the desktop wires
 * `dataSource` to `window.desktopApi.scheduledTasks.*` (that IPC channel name is
 * the preserved, version-skew-safe wire contract).
 */

const PASS_KIND_OPTIONS = [
  { value: PassKind.Custom, label: "Prompt" },
  { value: PassKind.Review, label: "Review" },
  { value: PassKind.Apply, label: "Apply" },
] as const;

/**
 * FEA-3816 (PRD-553 M4): the capability broker's per-task route options. Run
 * locally through the crewd cascade (the default, how every task ran before M4),
 * or hand the task to a Claude cloud routine.
 */
const TASK_ROUTE_OPTIONS = [
  { value: TaskRoute.LocalCascade, label: "Run locally (cascade)" },
  { value: TaskRoute.ClaudeRoutine, label: "Hand to Claude routine" },
] as const;

const PREVIEW_DEBOUNCE_MS = 250;

type PreviewState = {
  status: "idle" | "loading" | "valid" | "invalid";
  error: string | null;
  nextRuns: string[];
};

const IDLE_PREVIEW: PreviewState = {
  status: "idle",
  error: null,
  nextRuns: [],
};

export function ScheduledTaskEditorDialog({
  dataSource,
  open,
  onOpenChange,
  task,
}: {
  dataSource: RoutinesDataSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The routine being edited, or null to create a new one. */
  task: ScheduledTask | null;
}) {
  const nameId = useId();
  const scheduleId = useId();
  const bodyId = useId();
  const routeId = useId();

  const [name, setName] = useState("");
  const [scheduleText, setScheduleText] = useState("");
  const [kind, setKind] = useState<PassKind>(PassKind.Custom);
  const [body, setBody] = useState("");
  const [cascade, setCascade] = useState<CascadeStep[]>([]);
  const [route, setRoute] = useState<TaskRoute>(TaskRoute.LocalCascade);
  const [preview, setPreview] = useState<PreviewState>(IDLE_PREVIEW);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate the form from the task on open (edit) or reset it (create). Keyed on
  // the task identity + open so reopening on a different row never shows stale
  // fields.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(task?.name ?? "");
    setScheduleText(task?.cron ?? "");
    setKind(task?.kind ?? PassKind.Custom);
    setBody(taskBody(task));
    setCascade(task?.harnessCascade ?? []);
    setRoute(task?.route ?? TaskRoute.LocalCascade);
    setPreview(IDLE_PREVIEW);
    setSaving(false);
    setSaveError(null);
  }, [open, task]);

  const parsedCron = useMemo(
    () => parseScheduleText(scheduleText),
    [scheduleText]
  );

  // Live "next 3 runs" preview: parse the phrase to a cron, then ask the data
  // source to validate it and return its next fire times. Debounced so typing
  // doesn't fire a request per keystroke; the timer is cleared on change/unmount.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (scheduleText.trim().length === 0) {
      setPreview(IDLE_PREVIEW);
      return;
    }
    if (parsedCron === null) {
      setPreview({
        status: "invalid",
        error: 'Not a schedule we recognize. Try "every weekday at 9am".',
        nextRuns: [],
      });
      return;
    }
    setPreview((prev) => ({ ...prev, status: "loading" }));
    let active = true;
    const timer = setTimeout(() => {
      dataSource
        .previewSchedule({ cron: parsedCron, count: 3 })
        .then((result) => {
          if (!active) {
            return;
          }
          setPreview({
            status: result.valid ? "valid" : "invalid",
            error: result.error,
            nextRuns: result.nextRuns,
          });
        })
        .catch(() => {
          if (active) {
            setPreview({
              status: "invalid",
              error: "Could not validate this schedule.",
              nextRuns: [],
            });
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [dataSource, open, parsedCron, scheduleText]);

  const canSave =
    name.trim().length > 0 && parsedCron !== null && preview.status === "valid";

  const onSave = useCallback(async () => {
    if (!(canSave && parsedCron)) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const isCustom = kind === PassKind.Custom;
    const payload = {
      id: task?.id,
      name: name.trim(),
      cron: parsedCron,
      kind,
      prompt: isCustom ? body : "",
      pass: isCustom ? undefined : body.trim() || undefined,
      harnessCascade: cascade,
      route,
      timezone: task?.timezone ?? "",
      enabled: task?.enabled ?? true,
    };
    try {
      if (task) {
        await dataSource.update(payload);
      } else {
        await dataSource.create(payload);
      }
      onOpenChange(false);
    } catch (error) {
      // `dataSource` is an injected port (desktop IPC), not a React Query
      // mutation, so there is no global onError toast here — a rejection would
      // otherwise become an unhandled rejection with no user feedback. Surface
      // it inline and keep the dialog open so the user's input is never lost.
      setSaveError(
        error instanceof Error && error.message
          ? error.message
          : "Could not save this routine. Please try again."
      );
    } finally {
      setSaving(false);
    }
  }, [
    body,
    canSave,
    cascade,
    dataSource,
    kind,
    name,
    onOpenChange,
    parsedCron,
    route,
    task,
  ]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{task ? "Edit routine" : "New routine"}</DialogTitle>
          <DialogDescription>
            Schedule a routine and set the steps it runs through.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nightly review"
              value={name}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={scheduleId}>Schedule</Label>
            <Input
              aria-describedby={`${scheduleId}-preview`}
              id={scheduleId}
              onChange={(event) => setScheduleText(event.target.value)}
              placeholder="every weekday at 9am"
              value={scheduleText}
            />
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((preset) => (
                <Chip asChild interactive key={preset.id} variant="outline">
                  <button
                    onClick={() => setScheduleText(preset.label.toLowerCase())}
                    type="button"
                  >
                    {preset.label}
                  </button>
                </Chip>
              ))}
            </div>
            <SchedulePreview id={`${scheduleId}-preview`} preview={preview} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={bodyId}>Prompt</Label>
            <ToggleGroup
              aria-label="Prompt kind"
              onValueChange={(value) => {
                if (value) {
                  setKind(value as PassKind);
                }
              }}
              type="single"
              value={kind}
              variant="outline"
            >
              {PASS_KIND_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Textarea
              id={bodyId}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                kind === PassKind.Custom
                  ? "Review the open PRs and leave findings."
                  : "cutter-carl"
              }
              rows={kind === PassKind.Custom ? 3 : 1}
              value={body}
            />
          </div>

          <CascadeEditor onChange={setCascade} steps={cascade} />

          <div className="flex flex-col gap-2">
            <Label htmlFor={routeId}>Run through</Label>
            <ToggleGroup
              aria-label="Where this routine runs"
              id={routeId}
              onValueChange={(value) => {
                if (value) {
                  setRoute(value as TaskRoute);
                }
              }}
              type="single"
              value={route}
              variant="outline"
            >
              {TASK_ROUTE_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-muted-foreground text-xs">
              {route === TaskRoute.ClaudeRoutine
                ? "Handed to a Claude cloud routine; the local daemon won't run it."
                : "Runs on this machine, one step at a time down the list above."}
            </p>
          </div>
        </div>

        {saveError ? (
          <p className="text-destructive text-sm" role="alert">
            {saveError}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button disabled={!canSave || saving} onClick={onSave} type="button">
            {task ? "Save changes" : "Create routine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchedulePreview({
  preview,
  id,
}: {
  preview: PreviewState;
  id: string;
}) {
  if (preview.status === "idle") {
    return (
      <p className="text-muted-foreground text-xs" id={id}>
        Type a schedule to preview its next runs.
      </p>
    );
  }
  if (preview.status === "loading") {
    return (
      <p className="text-muted-foreground text-xs" id={id}>
        Checking schedule…
      </p>
    );
  }
  if (preview.status === "invalid") {
    return (
      <p className="text-destructive text-xs" id={id}>
        {preview.error ?? "Invalid schedule."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" id={id}>
      <span className="text-muted-foreground text-xs">Next runs</span>
      <ul className="flex flex-col gap-0.5">
        {preview.nextRuns.map((iso) => (
          <li className="text-sm tabular-nums" key={iso}>
            {formatDateTimeOrFallback(iso)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The editable body text for a task: its prompt (custom) or its pass id. */
function taskBody(task: ScheduledTask | null): string {
  if (!task) {
    return "";
  }
  return task.kind === PassKind.Custom ? task.prompt : (task.pass ?? "");
}
