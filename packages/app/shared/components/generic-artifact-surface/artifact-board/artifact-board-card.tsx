"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { KanbanCardFrame } from "@repo/design-system/components/ui/layout/kanban-board";
import { cn } from "@repo/design-system/lib/utils";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  type ArtifactBoardFieldDefinition,
  type ArtifactBoardItem,
  type ArtifactBoardRenderers,
  ArtifactBoardSelectionIntent,
  artifactBoardFieldFallback,
} from "./artifact-board-model";

export type ArtifactBoardCardProps = ArtifactBoardRenderers & {
  fields: readonly ArtifactBoardFieldDefinition[];
  item: ArtifactBoardItem;
  onMove: Parameters<NonNullable<ArtifactBoardRenderers["renderActions"]>>[1];
  onOpen: (item: ArtifactBoardItem) => void;
  onSelect: (
    item: ArtifactBoardItem,
    intent: ArtifactBoardSelectionIntent
  ) => void;
  positionInSet?: number;
  selected: boolean;
  setSize?: number;
};

/**
 * Shared Artifact Board card. Domain adapters inject canonical cells, editors,
 * actions and navigation while this component owns geometry and interaction
 * boundaries.
 */
export function ArtifactBoardCard({
  fields,
  item,
  onMove,
  onOpen,
  onSelect,
  positionInSet,
  renderActions,
  renderField,
  renderTitle,
  renderTypeIcon,
  selected,
  setSize,
}: Readonly<ArtifactBoardCardProps>) {
  const primaryFields = fields.filter((field) => field.tier === "primary");
  const secondaryFields = fields.filter((field) => field.tier === "secondary");
  const handleSelect = (event: MouseEvent<HTMLElement>) => {
    if (
      isArtifactBoardInteractiveTarget(
        event.target,
        event.currentTarget.ownerDocument
      )
    ) {
      return;
    }
    let intent: ArtifactBoardSelectionIntent =
      ArtifactBoardSelectionIntent.Replace;
    if (event.shiftKey) {
      intent = ArtifactBoardSelectionIntent.Range;
    } else if (event.metaKey || event.ctrlKey) {
      intent = ArtifactBoardSelectionIntent.Toggle;
    }
    onSelect(item, intent);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      isArtifactBoardInteractiveTarget(
        event.target,
        event.currentTarget.ownerDocument
      )
    ) {
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onSelect(item, ArtifactBoardSelectionIntent.Replace);
    }
  };
  return (
    <KanbanCardFrame
      active={selected}
      className={cn(
        "group/artifact-card min-h-34 px-3 py-3 duration-100 ease-[cubic-bezier(0.05,0.4,0.2,1)]",
        "focus-within:border-primary/35 hover:border-foreground/20 hover:bg-muted/30"
      )}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: PRD-724 keeps the card group selectable while its nested title and actions retain their own controls. */}
      <fieldset
        aria-label={`${item.slug} ${item.title}${selected ? ", selected" : ""}`}
        className="m-0 flex min-h-28 min-w-0 cursor-pointer flex-col gap-3 border-0 p-0 outline-none"
        data-artifact-board-card={item.id}
        data-position-in-set={positionInSet}
        data-set-size={setSize}
        onClick={handleSelect}
        onKeyDown={handleKeyDown}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: PRD-724 card selection is keyboard-accessible without nesting its own controls in a button.
        tabIndex={0}
      >
        <div className="flex items-start gap-2">
          {renderTypeIcon ? (
            <div
              aria-label={item.typeLabel}
              className="mt-0.5 shrink-0 text-muted-foreground"
              data-artifact-board-field="type"
              data-artifact-board-interactive
              role="img"
            >
              {renderTypeIcon(item)}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs">{item.slug}</div>
            {renderTitle ? (
              <div data-artifact-board-interactive>
                {renderTitle(item, () => onOpen(item))}
              </div>
            ) : (
              <Button
                className="h-auto min-h-0 w-full justify-start whitespace-normal p-0 text-left font-semibold text-base leading-6 hover:no-underline"
                data-artifact-board-interactive
                onClick={() => onOpen(item)}
                variant="link"
              >
                {item.title}
              </Button>
            )}
          </div>
          {renderActions ? (
            <div
              className="opacity-0 transition-opacity group-focus-within/artifact-card:opacity-100 group-hover/artifact-card:opacity-100"
              data-artifact-board-interactive
            >
              {renderActions(item, onMove)}
            </div>
          ) : null}
        </div>
        <ArtifactBoardFieldTier
          fields={primaryFields}
          item={item}
          renderField={renderField}
        />
        <ArtifactBoardFieldTier
          fields={secondaryFields}
          item={item}
          renderField={renderField}
        />
      </fieldset>
    </KanbanCardFrame>
  );
}

function ArtifactBoardFieldTier({
  fields,
  item,
  renderField,
}: Readonly<{
  fields: readonly ArtifactBoardFieldDefinition[];
  item: ArtifactBoardItem;
  renderField?: ArtifactBoardRenderers["renderField"];
}>) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-xs">
      {fields.map((field) => {
        const content = renderField
          ? renderField(item, field)
          : artifactBoardFieldFallback(item.fieldValues[field.id] ?? null);
        if (content === null || content === undefined || content === "") {
          return null;
        }
        return (
          <div
            className="min-w-0"
            data-artifact-board-field={field.id}
            data-artifact-board-field-label={field.label}
            data-artifact-board-interactive
            key={field.id}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

function isArtifactBoardInteractiveTarget(
  target: EventTarget | null,
  ownerDocument: Document
) {
  const HTMLElementConstructor = ownerDocument.defaultView?.HTMLElement;
  return Boolean(
    HTMLElementConstructor &&
      target instanceof HTMLElementConstructor &&
      target.closest("[data-artifact-board-interactive]") !== null
  );
}
