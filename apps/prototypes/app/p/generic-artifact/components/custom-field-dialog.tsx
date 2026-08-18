"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ALargeSmallIcon,
  CalendarDaysIcon,
  ChevronDownIcon,
  CircleChevronDownIcon,
  Clock3Icon,
  HashIcon,
  Layers2Icon,
  Link2Icon,
  LinkIcon,
  PlusIcon,
  SquareCheckIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { ArtifactTypeIcons } from "./artifact-icons";

export const CUSTOM_FIELD_TYPES = [
  "Single-select",
  "Multi-select",
  "Date",
  "People",
  "Reference",
  "Reference (multi)",
  "Time",
  "Text",
  "Number",
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export type CustomFieldDefinition = {
  id: string;
  label: string;
  type: CustomFieldType;
  description?: string;
  options?: string[];
  optionColors?: string[];
  sources?: string[];
  timeFormat?: "decimal" | "duration" | "minutes";
};

type CustomFieldDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (field: CustomFieldDefinition) => void;
};

const typeIcons = {
  "Single-select": CircleChevronDownIcon,
  "Multi-select": SquareCheckIcon,
  Date: CalendarDaysIcon,
  People: UserRoundIcon,
  Reference: Link2Icon,
  "Reference (multi)": LinkIcon,
  Time: Clock3Icon,
  Text: ALargeSmallIcon,
  Number: HashIcon,
};

const referenceSources = [
  { label: "Sessions", icon: ArtifactTypeIcons.Session },
  { label: "Issues", icon: ArtifactTypeIcons.Issue },
  { label: "Branches", icon: ArtifactTypeIcons.Branch },
  { label: "Documents", icon: ArtifactTypeIcons.Document },
  { label: "Agentic Components", icon: ArtifactTypeIcons.Agent },
  { label: "Projects", icon: Layers2Icon },
] as const;

const optionColors = ["bg-emerald-600", "bg-orange-600", "bg-blue-600"];

export function CustomFieldDialog({
  open,
  onOpenChange,
  onCreate,
}: CustomFieldDialogProps) {
  const [title, setTitle] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [type, setType] = useState<CustomFieldType>("Single-select");
  const [options, setOptions] = useState(["", ""]);
  const [optionColorIndexes, setOptionColorIndexes] = useState([0, 1]);
  const [source, setSource] = useState("");
  const [timeFormat, setTimeFormat] = useState<
    "decimal" | "duration" | "minutes"
  >("duration");
  const TypeIcon = typeIcons[type];
  const canCreate =
    !!title.trim() &&
    (!type.includes("select") || options.some((option) => option.trim())) &&
    (!type.startsWith("Reference") || !!source);

  const createField = () => {
    if (!title.trim()) {
      return;
    }
    const fieldSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    onCreate({
      description: description.trim() || undefined,
      id: `custom-${fieldSlug}-${Date.now().toString(36)}`,
      label: title.trim(),
      type,
      options: type.includes("select") ? options.filter(Boolean) : undefined,
      optionColors: type.includes("select")
        ? options.flatMap((option, index) =>
            option ? [optionColors[optionColorIndexes[index] ?? 0]] : []
          )
        : undefined,
      sources: type.startsWith("Reference") ? [source] : undefined,
      timeFormat: type === "Time" ? timeFormat : undefined,
    });
    setTitle("");
    setDescription("");
    setDescriptionOpen(false);
    setSource("");
    setTimeFormat("duration");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-6 py-5">
          <DialogTitle>Add field</DialogTitle>
          <DialogDescription className="sr-only">
            Configure a custom artifact field.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="grid grid-cols-[minmax(0,1.75fr)_minmax(260px,1fr)] items-start gap-x-6">
            <div>
              <label className="font-medium text-sm" htmlFor="field-title">
                Field title <span className="text-destructive">*</span>
              </label>
              <Input
                className="mt-2"
                id="field-title"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Priority, Stage, Status…"
                value={title}
              />
              {descriptionOpen ? (
                <Input
                  aria-label="Field description"
                  className="mt-2"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Describe this field…"
                  value={description}
                />
              ) : (
                <button
                  className="mt-2 flex items-center gap-2 px-1 text-left text-muted-foreground text-sm hover:text-foreground"
                  onClick={() => setDescriptionOpen(true)}
                  type="button"
                >
                  <PlusIcon className="size-4" />
                  Add description
                </button>
              )}
            </div>

            <div>
              <div className="font-medium text-sm">Field type</div>
              <Select
                onValueChange={(value) => {
                  const nextType = value as CustomFieldType;
                  setType(nextType);
                  if (!nextType.startsWith("Reference")) {
                    setSource("");
                  }
                }}
                value={type}
              >
                <SelectTrigger className="mt-2 w-full">
                  <SelectValue>
                    <TypeIcon />
                    {type}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {CUSTOM_FIELD_TYPES.map((fieldType) => {
                    const Icon = typeIcons[fieldType];
                    return (
                      <SelectItem key={fieldType} value={fieldType}>
                        <Icon />
                        {fieldType}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          {type.includes("select") ? (
            <section className="mt-8">
              <h3 className="font-medium text-sm">
                Options <span className="text-destructive">*</span>
              </h3>
              <div className="mt-3 space-y-3">
                {options.map((option, index) => (
                  <div
                    className="grid grid-cols-[36px_minmax(0,1fr)_28px] items-center gap-2"
                    // Options are append-only in this visual prototype.
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable option position
                    key={index}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          aria-label={`Choose color for option ${index + 1}`}
                          className={`${optionColors[optionColorIndexes[index] ?? 0]} flex size-9 items-center justify-center rounded-md text-white`}
                          type="button"
                        >
                          <ChevronDownIcon className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-32">
                        {optionColors.map((color, colorIndex) => (
                          <DropdownMenuItem
                            key={color}
                            onSelect={() =>
                              setOptionColorIndexes((current) =>
                                current.map((value, optionIndex) =>
                                  optionIndex === index ? colorIndex : value
                                )
                              )
                            }
                          >
                            <span className={`size-4 rounded-sm ${color}`} />
                            Color {colorIndex + 1}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Input
                      onChange={(event) =>
                        setOptions((current) =>
                          current.map((value, optionIndex) =>
                            optionIndex === index ? event.target.value : value
                          )
                        )
                      }
                      placeholder="Type an option name"
                      value={option}
                    />
                    <button
                      aria-label={`Remove option ${index + 1}`}
                      className="flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setOptions((current) =>
                          current.filter(
                            (_, optionIndex) => optionIndex !== index
                          )
                        );
                        setOptionColorIndexes((current) =>
                          current.filter(
                            (_, optionIndex) => optionIndex !== index
                          )
                        );
                      }}
                      type="button"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="mt-3 flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
                onClick={() => {
                  setOptions((current) => [...current, ""]);
                  setOptionColorIndexes((current) => [
                    ...current,
                    current.length % optionColors.length,
                  ]);
                }}
                type="button"
              >
                <PlusIcon className="size-4" />
                Add an option
              </button>
            </section>
          ) : null}

          {type.startsWith("Reference") ? (
            <section className="mt-8">
              <h3 className="font-medium text-sm">
                Source <span className="text-destructive">*</span>
              </h3>
              <p className="mt-1 text-muted-foreground text-sm">
                Choose the artifact type this field can reference
                {type === "Reference (multi)"
                  ? " (multiple records of that type allowed)"
                  : ""}
                .
              </p>
              <RadioGroup
                className="mt-5 gap-4"
                onValueChange={setSource}
                value={source}
              >
                {referenceSources.map(({ label, icon: Icon }) => (
                  <label
                    className="flex w-fit items-center gap-3 text-sm"
                    htmlFor={`reference-source-${label}`}
                    key={label}
                  >
                    <RadioGroupItem
                      id={`reference-source-${label}`}
                      value={label}
                    />
                    <span className="flex items-center gap-2 rounded-lg bg-muted/55 px-3 py-1.5">
                      <Icon className="size-4 text-muted-foreground" />
                      {label}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </section>
          ) : null}

          {type === "Time" ? (
            <section className="mt-8">
              <h3 className="font-medium text-sm">Format</h3>
              <Select
                onValueChange={(value) =>
                  setTimeFormat(value as "decimal" | "duration" | "minutes")
                }
                value={timeFormat}
              >
                <SelectTrigger className="mt-2 w-48 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="duration">00h 00m</SelectItem>
                  <SelectItem value="decimal">0.00 hours</SelectItem>
                  <SelectItem value="minutes">000 minutes</SelectItem>
                </SelectContent>
              </Select>
            </section>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={createField} type="button">
            Create field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
