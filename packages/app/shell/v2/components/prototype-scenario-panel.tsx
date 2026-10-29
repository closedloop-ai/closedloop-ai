"use client";

import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import type { LucideIcon } from "lucide-react";
import { RotateCcwIcon } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const VIEWPORT_PADDING = 8;
const KEYBOARD_MOVE_STEP = 16;
const TRAILING_COLON = /:$/;

export type ScenarioPanelOption = {
  readonly value: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly icon?: LucideIcon;
};

export type ScenarioPanelCondition = {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon?: LucideIcon;
  /** Persists this condition's value; omit to keep it session-only. */
  readonly storageKey?: string;
  readonly options: readonly ScenarioPanelOption[];
  readonly default: string;
  readonly onChange?: (value: string) => void;
};

export type ScenarioPanelAction = {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly onClick: () => void;
};

export type PrototypeScenarioPanelProps = {
  /** The panel's own accessible name, e.g. "Prototype developer controls". */
  readonly ariaLabel: string;
  /** Persists this panel instance's dragged position; unique per prototype. */
  readonly positionStorageKey: string;
  /** Rendered as one toggle group per condition, in array order. */
  readonly conditions: readonly ScenarioPanelCondition[];
  /** Footer buttons rendered after the built-in reset control, in order. */
  readonly actions?: readonly ScenarioPanelAction[];
};

type MenuPosition = { x: number; y: number };
type DragState = {
  offsetX: number;
  offsetY: number;
  pointerId: number;
};

/**
 * Prototype-only floating panel (ISS-12518) that renders a declarative list
 * of scenario conditions as toggle groups, so a reviewer can switch between
 * preset states without reading code. Persists each condition and the
 * panel's dragged position to its caller-supplied storage keys, and resets
 * every condition back to its declared default.
 */
export function PrototypeScenarioPanel({
  ariaLabel,
  positionStorageKey,
  conditions,
  actions,
}: PrototypeScenarioPanelProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      conditions.map((condition) => [condition.id, condition.default])
    )
  );
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<MenuPosition | null>(null);
  // A ref, not an effect dependency: a caller that re-creates the conditions
  // array would otherwise re-read storage and re-notify every onChange.
  const initialConditionsRef = useRef(conditions);

  const updatePosition = useCallback(
    (next: MenuPosition, persist: boolean) => {
      positionRef.current = next;
      setPosition(next);
      if (persist) {
        globalThis.window.localStorage.setItem(
          positionStorageKey,
          JSON.stringify(next)
        );
      }
    },
    [positionStorageKey]
  );

  useEffect(() => {
    const initialValues: Record<string, string> = {};
    for (const condition of initialConditionsRef.current) {
      const stored = condition.storageKey
        ? globalThis.window.localStorage.getItem(condition.storageKey)
        : null;
      const resolved = isKnownOption(condition, stored)
        ? stored
        : condition.default;
      initialValues[condition.id] = resolved;
      condition.onChange?.(resolved);
    }
    setValues(initialValues);

    const storedPosition = readStoredPosition(positionStorageKey);
    const menu = menuRef.current;
    if (storedPosition && menu) {
      updatePosition(clampPosition(storedPosition, menu), false);
    }

    const keepInsideViewport = () => {
      const current = positionRef.current;
      const currentMenu = menuRef.current;
      if (current && currentMenu) {
        updatePosition(clampPosition(current, currentMenu), true);
      }
    };
    globalThis.window.addEventListener("resize", keepInsideViewport);
    return () =>
      globalThis.window.removeEventListener("resize", keepInsideViewport);
  }, [positionStorageKey, updatePosition]);

  const selectCondition = useCallback(
    (condition: ScenarioPanelCondition, next: string) => {
      if (!isKnownOption(condition, next)) {
        return;
      }
      setValues((prev) => ({ ...prev, [condition.id]: next }));
      if (condition.storageKey) {
        globalThis.window.localStorage.setItem(condition.storageKey, next);
      }
      condition.onChange?.(next);
    },
    []
  );

  const resetConditions = useCallback(() => {
    const defaults: Record<string, string> = {};
    for (const condition of conditions) {
      defaults[condition.id] = condition.default;
      if (condition.storageKey) {
        globalThis.window.localStorage.setItem(
          condition.storageKey,
          condition.default
        );
      }
      condition.onChange?.(condition.default);
    }
    setValues(defaults);
  }, [conditions]);

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest("button") &&
      !target.closest('[data-prototype-drag-handle="true"]')
    ) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsDragging(true);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const menu = menuRef.current;
    if (!(drag && menu && drag.pointerId === event.pointerId)) {
      return;
    }
    updatePosition(
      clampPosition(
        { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
        menu
      ),
      false
    );
  };

  const finishDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);
    if (positionRef.current) {
      updatePosition(positionRef.current, true);
    }
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Partial<Record<string, MenuPosition>> = {
      ArrowDown: { x: 0, y: KEYBOARD_MOVE_STEP },
      ArrowLeft: { x: -KEYBOARD_MOVE_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_MOVE_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_MOVE_STEP },
    };
    const delta = deltas[event.key];
    const menu = menuRef.current;
    if (!(delta && menu)) {
      return;
    }
    event.preventDefault();
    const rect = menu.getBoundingClientRect();
    const current = positionRef.current ?? { x: rect.left, y: rect.top };
    updatePosition(
      clampPosition({ x: current.x + delta.x, y: current.y + delta.y }, menu),
      true
    );
  };

  assertDistinctActionLabels(actions);
  const [dragHandleCondition, ...restConditions] = conditions;

  return (
    <aside
      aria-label={ariaLabel}
      className={`pointer-events-auto fixed top-4 right-4 isolate z-[2147483647] flex w-72 touch-none select-none flex-col items-stretch gap-1 rounded-xl border border-background/20 border-dashed bg-foreground p-1.5 text-background shadow-lg ${
        isDragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      data-dragging={isDragging || undefined}
      onPointerCancel={finishDrag}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      ref={menuRef}
      style={
        position
          ? { left: position.x, right: "auto", top: position.y }
          : undefined
      }
    >
      {dragHandleCondition ? (
        <ConditionRow
          condition={dragHandleCondition}
          dragHandle
          moveWithKeyboard={moveWithKeyboard}
          onSelect={selectCondition}
          value={values[dragHandleCondition.id] ?? dragHandleCondition.default}
        />
      ) : null}
      {restConditions.map((condition) => (
        <Fragment key={condition.id}>
          <RowSeparator />
          <ConditionRow
            condition={condition}
            onSelect={selectCondition}
            value={values[condition.id] ?? condition.default}
          />
        </Fragment>
      ))}
      <RowSeparator />
      <FooterButton
        icon={RotateCcwIcon}
        label="Reset"
        onClick={resetConditions}
      />
      {actions?.map((action) => (
        <Fragment key={action.label}>
          <RowSeparator />
          <FooterButton
            icon={action.icon}
            label={action.label}
            onClick={action.onClick}
          />
        </Fragment>
      ))}
    </aside>
  );
}

function ConditionRow({
  condition,
  value,
  onSelect,
  dragHandle = false,
  moveWithKeyboard,
}: {
  condition: ScenarioPanelCondition;
  value: string;
  onSelect: (condition: ScenarioPanelCondition, next: string) => void;
  dragHandle?: boolean;
  moveWithKeyboard?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const Icon = condition.icon;
  return (
    <div className="flex items-center gap-2">
      {dragHandle ? (
        <button
          aria-label={`Move ${condition.label.replace(TRAILING_COLON, "")}`}
          className={`flex w-28 shrink-0 cursor-grab items-center gap-1.5 rounded-md px-1.5 py-1 text-background/70 text-xs hover:bg-background/10 hover:text-background active:cursor-grabbing ${CHIP_FOCUS_RING_CLASS}`}
          data-prototype-drag-handle="true"
          onKeyDown={moveWithKeyboard}
          title="Drag to move · Arrow keys also work"
          type="button"
        >
          {Icon ? <Icon className="size-3.5" /> : null}
          <span className="font-medium">{condition.label}</span>
        </button>
      ) : (
        <div className="flex w-28 shrink-0 items-center gap-1.5 px-1.5 text-background/70 text-xs">
          {Icon ? <Icon className="size-3.5" /> : null}
          <span className="font-medium">{condition.label}</span>
        </div>
      )}
      <ToggleGroup
        aria-label={condition.ariaLabel}
        className="min-w-0 flex-1 border-background/20 bg-transparent"
        onValueChange={(next) => onSelect(condition, next)}
        type="single"
        value={value}
        variant="outline"
      >
        {condition.options.map((option) => {
          const OptionIcon = option.icon;
          return (
            <ToggleGroupItem
              aria-label={option.ariaLabel ?? option.label}
              className="h-7 flex-1 cursor-pointer gap-1.5 border-0 px-2 text-background/70 text-xs hover:bg-background/10 hover:text-background data-[state=on]:bg-background data-[state=on]:text-foreground"
              key={option.value}
              value={option.value}
            >
              {OptionIcon ? <OptionIcon className="size-3.5" /> : null}
              {option.label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

function FooterButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-background/70 text-xs hover:bg-background/10 hover:text-background ${CHIP_FOCUS_RING_CLASS}`}
      onClick={onClick}
      type="button"
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {label}
    </button>
  );
}

function RowSeparator() {
  return <span aria-hidden="true" className="mx-1 h-px bg-background/20" />;
}

function isKnownOption(
  condition: ScenarioPanelCondition,
  value: string | null
): value is string {
  return (
    value !== null && condition.options.some((option) => option.value === value)
  );
}

function clampPosition(
  position: MenuPosition,
  menu: HTMLElement
): MenuPosition {
  const rect = menu.getBoundingClientRect();
  return {
    x: Math.min(
      Math.max(position.x, VIEWPORT_PADDING),
      Math.max(
        VIEWPORT_PADDING,
        globalThis.window.innerWidth - rect.width - VIEWPORT_PADDING
      )
    ),
    y: Math.min(
      Math.max(position.y, VIEWPORT_PADDING),
      Math.max(
        VIEWPORT_PADDING,
        globalThis.window.innerHeight - rect.height - VIEWPORT_PADDING
      )
    ),
  };
}

/**
 * Actions are keyed by label, so two sharing one label make React collide them
 * rather than render two buttons. A duplicate is also two footer controls with
 * one accessible name, so it is rejected at the caller instead of deduplicated.
 */
function assertDistinctActionLabels(
  actions: readonly ScenarioPanelAction[] | undefined
) {
  const seen = new Set<string>();
  for (const action of actions ?? []) {
    if (seen.has(action.label)) {
      throw new Error(
        `PrototypeScenarioPanel: duplicate action label "${action.label}"`
      );
    }
    seen.add(action.label);
  }
}

function readStoredPosition(storageKey: string): MenuPosition | null {
  try {
    const value = globalThis.window.localStorage.getItem(storageKey);
    if (!value) {
      return null;
    }
    const parsed = JSON.parse(value) as Partial<MenuPosition>;
    return Number.isFinite(parsed.x) && Number.isFinite(parsed.y)
      ? { x: parsed.x as number, y: parsed.y as number }
      : null;
  } catch {
    return null;
  }
}
