"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useId, useMemo, useState } from "react";
import {
  type DevToolsSettingsState,
  useDevToolsSettings,
} from "../hooks/use-dev-tools-settings";
import {
  DEV_TOOLS_OVERRIDDEN_SETTING_LABELS,
  DEV_TOOLS_RESET_TO_PROD_LABEL,
  DEV_TOOLS_SETTING_LABELS,
  DEV_TOOLS_UNKNOWN_LABEL,
} from "../lib/dev-tools-copy";
import type {
  DevToolsControl,
  DevToolsSection,
} from "../lib/dev-tools-registry";
import {
  DEV_TOOLS_SETTING_ORDER,
  isDevToolsControlOverridden,
  isDevToolsDefaultSetting,
  isDevToolsSetting,
  resolveDevToolsSetting,
} from "../lib/dev-tools-settings";

/**
 * ISS-12048: one registered Dev Tools section. Each control is a segmented
 * radio group, so the current setting is announced as the checked option and
 * drawn as the filled segment, never by color alone, and arrow keys move
 * between options. A control shows its default until overridden, and the
 * section's reset clears every override. The header stays pinned while a long
 * control list scrolls.
 */
export function DevToolsSectionPanel({
  section,
}: {
  section: DevToolsSection;
}) {
  const settingsState = useDevToolsSettings(section.storageKey);
  const headingId = useId();
  const switchId = useId();
  const [showAll, setShowAll] = useState(false);

  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-1 border-b bg-popover px-4 pt-2 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-sm" id={headingId}>
            {section.title}
          </h3>
          {/* Described by the section title, so each section's reset is
              distinguishable when more than one section is registered. */}
          <Button
            aria-describedby={headingId}
            className="-mr-2 text-muted-foreground"
            onClick={settingsState.resetAll}
            size="sm"
            variant="ghost"
          >
            {DEV_TOOLS_RESET_TO_PROD_LABEL}
          </Button>
        </div>
        {section.highlight && (
          <div className="flex items-center gap-2">
            <Switch
              checked={showAll}
              id={switchId}
              onCheckedChange={setShowAll}
            />
            <Label className="font-normal text-xs" htmlFor={switchId}>
              {section.highlight.showAllLabel}
            </Label>
          </div>
        )}
      </div>
      <div className="flex flex-col px-2 pb-2">
        {section.highlight ? (
          <HighlightedControls
            highlight={section.highlight}
            section={section}
            settingsState={settingsState}
            showAll={showAll}
          />
        ) : (
          <ControlList
            controls={section.controls}
            section={section}
            settingsState={settingsState}
          />
        )}
      </div>
    </section>
  );
}

type SectionBodyProps = {
  section: DevToolsSection;
  settingsState: DevToolsSettingsState;
};

/**
 * The highlighted controls first. With the show-all toggle off, only those;
 * with it on, those under their heading, a divider, then every other control.
 */
function HighlightedControls({
  section,
  highlight,
  settingsState,
  showAll,
}: SectionBodyProps & {
  highlight: NonNullable<DevToolsSection["highlight"]>;
  showAll: boolean;
}) {
  const highlighted = highlight.useControls();
  const headingId = useId();
  const rest = useMemo(() => {
    const highlightedIds = new Set(highlighted.map((control) => control.id));
    return section.controls.filter(
      (control) => !highlightedIds.has(control.id)
    );
  }, [highlighted, section.controls]);

  return (
    <>
      {showAll && highlighted.length > 0 && (
        <h4
          className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs"
          id={headingId}
        >
          {highlight.heading}
        </h4>
      )}
      <ControlList
        aria-labelledby={showAll ? headingId : undefined}
        controls={highlighted}
        section={section}
        settingsState={settingsState}
      />
      {showAll && (
        <>
          {highlighted.length > 0 && (
            <Separator className="mx-2 my-2 data-[orientation=horizontal]:w-auto" />
          )}
          <ControlList
            controls={rest}
            section={section}
            settingsState={settingsState}
          />
        </>
      )}
    </>
  );
}

function ControlList({
  controls,
  section,
  settingsState,
  "aria-labelledby": ariaLabelledBy,
}: SectionBodyProps & {
  controls: readonly DevToolsControl[];
  "aria-labelledby"?: string;
}) {
  if (controls.length === 0) {
    return null;
  }
  return (
    <ul aria-labelledby={ariaLabelledBy} className="flex flex-col">
      {controls.map((control) => (
        <DevToolsControlRow
          control={control}
          key={control.id}
          onSettingChange={settingsState.setSetting}
          settings={settingsState.settings}
          useDefaultValue={section.useDefaultValue ?? defaultOff}
        />
      ))}
    </ul>
  );
}

function DevToolsControlRow({
  control,
  settings,
  useDefaultValue,
  onSettingChange,
}: {
  control: DevToolsControl;
  settings: DevToolsSettingsState["settings"];
  useDefaultValue: NonNullable<DevToolsSection["useDefaultValue"]>;
  onSettingChange: DevToolsSettingsState["setSetting"];
}) {
  const labelId = useId();
  const unknownId = useId();
  const defaultValue = useDefaultValue(control.id);
  const overridden = isDevToolsControlOverridden(settings, control.id);
  const setting = resolveDevToolsSetting(settings, control.id, defaultValue);

  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <span
        className="min-w-0 flex-1 break-words font-mono text-xs"
        id={labelId}
      >
        {control.label}
      </span>
      {setting === undefined && (
        <span className="shrink-0 text-muted-foreground text-xs" id={unknownId}>
          {DEV_TOOLS_UNKNOWN_LABEL}
        </span>
      )}
      <RadioGroup
        aria-describedby={setting === undefined ? unknownId : undefined}
        aria-labelledby={labelId}
        className="shrink-0"
        onValueChange={(value) => {
          if (isDevToolsSetting(value)) {
            onSettingChange(control.id, value, defaultValue);
          }
        }}
        value={setting ?? ""}
        variant="segmented"
      >
        {DEV_TOOLS_SETTING_ORDER.map((option) => (
          <RadioGroupItem
            aria-label={
              overridden && option === setting
                ? DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[option]
                : undefined
            }
            className={overridden ? OVERRIDDEN_CHECKED_CLASS : undefined}
            key={option}
            // Radix fires no value change for the checked item, so choosing
            // the prod value again on an override that now equals it is a click
            // (ISS-12048, A3: choosing the prod value clears the override).
            onClick={() => {
              if (
                overridden &&
                option === setting &&
                isDevToolsDefaultSetting(option, defaultValue)
              ) {
                onSettingChange(control.id, option, defaultValue);
              }
            }}
            value={option}
          >
            {DEV_TOOLS_SETTING_LABELS[option]}
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </li>
  );
}

function defaultOff(): boolean {
  return false;
}

/**
 * An overridden control fills its checked segment with the primary accent, so
 * overrides stand out in a long list while one at its default stays quiet.
 */
const OVERRIDDEN_CHECKED_CLASS =
  "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";
