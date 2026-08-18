/**
 * @file audit-character-picker.tsx
 * @description FEA-4013 — the Audit Bot review-character picker: a searchable
 * Popover + Command typeahead over the FULL discovered cast
 * ({@link AUDIT_CHARACTER_ROSTER}, ~41 characters).
 *
 * The previous plain `Select` did not scale to the full cast: 41 flat options
 * filled the viewport and Radix Select only offers first-letter typeahead, so
 * finding one reviewer meant eyeballing seven author headings. This mirrors the
 * sibling in-feature picker (`ProjectSelectPopover`) — the same Command/Popover
 * pattern the audit filing dialog already uses — so typing "perf" lands on Perf
 * Pete and Perf Pathfinder, "a11y" on A11y Alex, "electron" on Electron Eli.
 *
 * The list is derived entirely from the roster (id → label/description/group),
 * so a new character file surfaces here after a roster regenerate with no change
 * to this component. Search matches label, description, and id, so a reviewer is
 * reachable by name OR by what they review. Groups keep authorship visible as a
 * heading (derived `groupLabel`, never a raw slug), but search — not the
 * grouping axis — is the primary way to find a reviewer. Presentational only.
 */

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@closedloop-ai/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@closedloop-ai/design-system/components/ui/popover";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AUDIT_CHARACTER_ROSTER,
  type AuditCharacterRosterEntry,
} from "../../../shared/audit-character-roster.generated";
import {
  type AuditCharacterId,
  characterMetaFor,
} from "../../../shared/audit-contract";

/** One rendered picker section: an author group and its characters. */
type CharacterGroup = {
  group: string;
  heading: string;
  entries: readonly AuditCharacterRosterEntry[];
};

export type AuditCharacterPickerProps = {
  /** The currently-selected character id. */
  value: AuditCharacterId;
  /** Fires with the picked character's roster id. */
  onChange: (character: AuditCharacterId) => void;
  /** Disable the control (e.g. while a run is in flight). */
  disabled?: boolean;
  /** Trigger element id, so a sibling `<Label htmlFor>` can point at it. */
  id?: string;
};

/** The field name announced on the trigger, in front of the current value. */
const FIELD_NAME = "Review character";

/**
 * The searchable review-character picker. The trigger shows the selected
 * character's label, or an explicit "unavailable" state when the selected id is
 * not in this build's roster (a version-skewed default) — never a blank field.
 */
export function AuditCharacterPicker({
  value,
  onChange,
  disabled = false,
  id,
}: AuditCharacterPickerProps) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(buildCharacterGroups, []);
  const selectedMeta = characterMetaFor(value);
  const triggerLabel = selectedMeta?.label ?? "Character unavailable";
  // A <button> is not labeled by a sibling <label htmlFor>, so name the trigger
  // explicitly ("Review character: Docs Darwin") for screen readers and tests.
  const triggerAriaLabel = `${FIELD_NAME}: ${triggerLabel}`;

  const handleSelect = (character: AuditCharacterId) => {
    onChange(character);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          className="w-full justify-between font-normal"
          disabled={disabled}
          id={id}
          role="combobox"
          variant="outline"
        >
          <span
            className={cn(
              "truncate",
              selectedMeta ? "" : "text-[var(--muted-foreground)]"
            )}
          >
            {triggerLabel}
          </span>
          <ChevronsUpDownIcon aria-hidden className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command label="Search review characters">
          <CommandInput placeholder="Search by name or focus…" />
          <CommandList>
            <CommandEmpty>No review character found.</CommandEmpty>
            {groups.map((section) => (
              <CommandGroup heading={section.heading} key={section.group}>
                {section.entries.map((entry) => (
                  <CommandItem
                    className="cursor-pointer"
                    key={entry.id}
                    // Search matches name, focus, and id so a reviewer is
                    // reachable by who they are or by what they review.
                    keywords={[entry.label, entry.description, entry.id]}
                    onSelect={() => handleSelect(entry.id)}
                    value={entry.id}
                  >
                    <div className="flex flex-col">
                      <span>{entry.label}</span>
                      <span className="text-[var(--muted-foreground)] text-xs">
                        {entry.description}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Partition the full cast into ordered picker sections. `core` sorts first; the
 * remaining author groups follow alphabetically by their heading. Entries keep
 * the roster's id sort within each group. Derived entirely from the roster, so a
 * new character (and even a new author folder) appears with no edit here.
 */
function buildCharacterGroups(): readonly CharacterGroup[] {
  const byGroup = new Map<string, AuditCharacterRosterEntry[]>();
  for (const entry of AUDIT_CHARACTER_ROSTER) {
    const bucket = byGroup.get(entry.group) ?? [];
    bucket.push(entry);
    byGroup.set(entry.group, bucket);
  }
  const sections = [...byGroup.entries()].map(([group, entries]) => ({
    group,
    heading: entries[0]?.groupLabel ?? group,
    entries,
  }));
  return sections.sort((a, b) => {
    if (a.group === "core") {
      return -1;
    }
    if (b.group === "core") {
      return 1;
    }
    return a.heading.localeCompare(b.heading);
  });
}
