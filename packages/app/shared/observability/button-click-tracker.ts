import { toDataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
  UnknownSessionVolume,
  UnknownSyncChoice,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
  type SurfaceAnalyticsProperties,
} from "@repo/api/src/types/surface-analytics";
import {
  hasLabelSource,
  hasReferencedLabelSource,
  normalizeLabel as normalized,
} from "./trusted-button-label";

const ACTION_SELECTOR =
  'button,a[href],input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[data-analytics-action]';
const DISABLED_SELECTOR =
  ':disabled,[aria-disabled="true"],[data-disabled]:not([data-disabled="false"]),[inert]';
const EDITABLE_SELECTOR =
  'textarea,input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]),[contenteditable="true"]';
const EARLY_POINTER_SELECTOR =
  '[data-slot="dropdown-menu-trigger"],[data-slot="select-trigger"]';
const INVISIBLE_TEXT_SELECTOR =
  'svg,script,style,[hidden],[aria-hidden="true"],.sr-only';

export type ClickPageContext = {
  pageName: OnboardingAnalyticsPageName;
  /** Local navigation identity only. Never emitted. */
  entry: string;
};

export type ButtonClickTracker = {
  recordPageView: (properties: SurfaceAnalyticsProperties) => void;
  dispose: () => void;
};

/** One listener per surface, including portals; capture precedes handlers that navigate or remove the control. */
export function installButtonClickTracker(input: {
  document: Document;
  capture: SurfaceAnalyticsCapture;
  surface: Surface;
  getPage: () => ClickPageContext;
}): ButtonClickTracker {
  let viewed:
    | { entry: string; properties: SurfaceAnalyticsProperties }
    | undefined;
  let earlyControl: Element | undefined;
  let keyboardTabList: Element | null = null;

  function findControl(event: Event): Element | undefined {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) {
        continue;
      }
      // Editable comboboxes are text fields, including cmdk's CommandInput.
      if (node.matches(EDITABLE_SELECTOR)) {
        return undefined;
      }
      if (node.matches(ACTION_SELECTOR)) {
        return node;
      }
    }
    return undefined;
  }

  function emit(control: Element | undefined, selectionEvent?: KeyboardEvent) {
    if (!control || control.closest(DISABLED_SELECTOR)) {
      return;
    }
    try {
      const page = input.getPage();
      const context =
        viewed?.entry === page.entry &&
        viewed.properties[OnboardingAnalyticsProperty.PageName] ===
          page.pageName
          ? viewed.properties
          : {};
      const dashboardDefaults =
        page.pageName === OnboardingAnalyticsPageName.Dashboard &&
        input.surface === Surface.Desktop
          ? {
              [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
                UnknownSessionVolume,
              [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
                UnknownSessionVolume,
            }
          : {};
      const properties: SurfaceAnalyticsProperties = {
        ...dashboardDefaults,
        ...context,
        [OnboardingAnalyticsProperty.PageName]: page.pageName,
        [OnboardingAnalyticsProperty.ButtonName]: buttonName(control),
        [OnboardingAnalyticsProperty.Surface]: input.surface,
        ...downloadClickProperties(control),
      };
      const syncChoice = control.getAttribute("data-analytics-sync-choice");
      if (syncChoice !== null) {
        // ISS-12228: empty means no selection; unrecognized values are unknown.
        properties[OnboardingAnalyticsProperty.SyncChoiceSelected] =
          syncChoice === ""
            ? null
            : (toDataSyncLevel(syncChoice) ?? UnknownSyncChoice);
      }
      const send = () => {
        try {
          input.capture(OnboardingAnalyticsEvent.ButtonClicked, properties);
        } catch {
          // Keep an unavailable analytics sink from interrupting the action.
        }
      };
      if (selectionEvent) {
        // Radix prevents Space only when it activates; typeahead consumes it
        // without prevention. Preserve the source page/label before handlers.
        globalThis.queueMicrotask(() => {
          if (selectionEvent.defaultPrevented) {
            send();
          }
        });
      } else {
        send();
      }
    } catch {
      // Analytics is best-effort: a failing sink must not stop the control's action.
    }
  }

  const click = (event: MouseEvent) => {
    const control = findControl(event);
    const alreadyEmitted = control === earlyControl;
    earlyControl = undefined;
    if (!alreadyEmitted) {
      emit(control);
    }
  };
  const emitEarly = (control: Element | undefined) => {
    earlyControl = control;
    emit(control);
  };
  const pointerDown = (event: PointerEvent) => {
    earlyControl = undefined;
    keyboardTabList = null;
    const control = findControl(event);
    if (
      event.button === 0 &&
      !event.ctrlKey &&
      control?.matches(EARLY_POINTER_SELECTOR) &&
      (!control.matches('[data-slot="select-trigger"]') ||
        event.pointerType === "mouse")
    ) {
      emitEarly(control);
    }
  };
  const mouseDown = (event: MouseEvent) => {
    const control = findControl(event);
    // Radix selects tabs on mousedown, before click (which may never arrive
    // if the new panel removes the trigger). Other controls use click.
    if (
      event.button === 0 &&
      !event.ctrlKey &&
      control?.getAttribute("role") === "tab"
    ) {
      emitEarly(control);
    }
  };
  const keyDown = (event: KeyboardEvent) => {
    earlyControl = undefined;
    keyboardTabList = null;
    keyboardTabList = automaticTabList(event);
    const target = event.target;
    if (
      event.key === "Enter" &&
      !event.repeat &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      target instanceof Element &&
      target.matches("[cmdk-input]")
    ) {
      const command = target.closest("[cmdk-root]");
      emitEarly(
        command?.querySelector('[cmdk-item][aria-selected="true"]') ?? undefined
      );
      return;
    }
    const opensPopup =
      target instanceof Element &&
      ((event.key === "ArrowDown" && target.matches(EARLY_POINTER_SELECTOR)) ||
        (event.key === "ArrowUp" &&
          target.matches('[data-slot="select-trigger"]')));
    if (
      event.repeat ||
      (event.key !== "Enter" && event.key !== " " && !opensPopup)
    ) {
      return;
    }
    if (
      target instanceof Element &&
      target.matches(
        `[data-analytics-keyboard="true"],[role="tab"],[role="option"],[role="button"]:not(button):not(input),${EARLY_POINTER_SELECTOR}`
      )
    ) {
      if (
        event.key === " " &&
        target.matches('[data-slot="select-trigger"],[data-slot="select-item"]')
      ) {
        earlyControl = target;
        emit(target, event);
      } else {
        emitEarly(target);
      }
    }
  };
  const focusIn = (event: FocusEvent) => {
    const target = event.target;
    if (
      keyboardTabList &&
      target instanceof Element &&
      target.matches('[role="tab"]') &&
      target.closest('[role="tablist"]') === keyboardTabList
    ) {
      keyboardTabList = null;
      emit(target);
    }
  };
  input.document.addEventListener("focusin", focusIn, true);
  input.document.addEventListener("click", click, true);
  input.document.addEventListener("pointerdown", pointerDown, true);
  input.document.addEventListener("mousedown", mouseDown, true);
  input.document.addEventListener("keydown", keyDown, true);
  const clearPage = () => {
    if (viewed?.entry !== input.getPage().entry) {
      viewed = undefined;
    }
  };
  input.document.defaultView?.addEventListener("hashchange", clearPage);
  input.document.defaultView?.addEventListener("popstate", clearPage);
  return {
    recordPageView(properties) {
      viewed = { entry: input.getPage().entry, properties: { ...properties } };
    },
    dispose() {
      input.document.removeEventListener("focusin", focusIn, true);
      input.document.removeEventListener("click", click, true);
      input.document.removeEventListener("pointerdown", pointerDown, true);
      input.document.removeEventListener("mousedown", mouseDown, true);
      input.document.removeEventListener("keydown", keyDown, true);
      input.document.defaultView?.removeEventListener("hashchange", clearPage);
      input.document.defaultView?.removeEventListener("popstate", clearPage);
      viewed = undefined;
    },
  };
}

function visibleText(element: Element): string {
  if (element.matches(INVISIBLE_TEXT_SELECTOR)) {
    return "";
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style?.display === "none" || style?.visibility === "hidden") {
    return "";
  }
  return Array.from(element.childNodes, (child) => {
    if (child.nodeType === 3) {
      return child.textContent ?? "";
    }
    return child instanceof Element ? visibleText(child) : "";
  }).join("");
}

function referencedText(element: Element, attribute: string): string {
  const ids = normalized(element.getAttribute(attribute)).split(" ");
  return ids
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** ISS-11615: only product-owned copy is emitted verbatim, never arbitrary DOM/customer text. */
export function buttonName(control: Element): string {
  const override = normalized(control.getAttribute("data-analytics-label"));
  if (override && hasLabelSource(control, "label", override)) {
    return override;
  }
  const visible = normalized(
    control instanceof HTMLInputElement
      ? inputLabel(control)
      : visibleText(control)
  );
  if (visible) {
    return hasVisibleLabelSource(control, visible)
      ? visible
      : genericActionName(control);
  }
  const accessible = normalized(
    normalized(referencedText(control, "aria-labelledby")) ||
      control.getAttribute("aria-label") ||
      control.querySelector(".sr-only")?.textContent
  );
  if (accessible) {
    return hasAccessibleLabelSource(control, accessible)
      ? accessible
      : genericActionName(control);
  }
  const tooltip = normalized(
    control.getAttribute("title") || referencedText(control, "aria-describedby")
  );
  return tooltip &&
    (hasLabelSource(control, "tooltip", tooltip) ||
      hasReferencedLabelSource(control, "aria-describedby", tooltip))
    ? tooltip
    : genericActionName(control);
}

function genericActionName(control: Element): string {
  const role = control.getAttribute("role");
  if (role === "tab") {
    return "Select tab";
  }
  if (role === "option" || role === "combobox") {
    return "Select option";
  }
  if (
    role === "checkbox" ||
    role === "switch" ||
    control.matches('input[type="checkbox"]')
  ) {
    return "Toggle selection";
  }
  if (role === "radio" || control.matches('input[type="radio"]')) {
    return "Select option";
  }
  if (control.matches("a[href]")) {
    return linkedActionName(control);
  }
  if (control.matches("summary,[aria-expanded]")) {
    return "Toggle details";
  }
  if (role?.startsWith("menuitem")) {
    return "Select menu action";
  }
  for (const icon of control.querySelectorAll("svg")) {
    for (const className of icon.classList) {
      const label = ICON_ACTIONS.get(className);
      if (label) {
        return label;
      }
    }
  }
  return "Activate action";
}

function inputLabel(control: HTMLInputElement): string {
  if (
    control.type === "button" ||
    control.type === "submit" ||
    control.type === "reset"
  ) {
    return control.value;
  }
  return Array.from(
    control.labels ?? [],
    (label) => label.textContent ?? ""
  ).join(" ");
}

const LINK_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["sessions", "Open session"],
  ["branches", "Open branch"],
  ["projects", "Open project"],
  ["issues", "Open issue"],
  ["documents", "Open document"],
  ["prds", "Open PRD"],
  ["implementation-plans", "Open implementation plan"],
  ["agents", "Open agent"],
  ["packs", "Open pack"],
  ["users", "Open user"],
]);

function linkedActionName(control: Element): string {
  try {
    const url = new URL(
      control.getAttribute("href") ?? "",
      control.ownerDocument.baseURI
    );
    if (url.origin !== new URL(control.ownerDocument.baseURI).origin) {
      return "Open link";
    }
    const parts = url.pathname.split("/").filter(Boolean);
    return LINK_ACTIONS.get(parts.at(-2) ?? "") ?? "Open item";
  } catch {
    return "Open link";
  }
}

const ICON_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["lucide-x", "Close"],
  ["lucide-plus", "Add"],
  ["lucide-trash", "Delete"],
  ["lucide-trash-2", "Delete"],
  ["lucide-pencil", "Edit"],
  ["lucide-copy", "Copy"],
  ["lucide-ellipsis", "More options"],
  ["lucide-more-horizontal", "More options"],
  ["lucide-chevron-down", "Expand"],
  ["lucide-chevron-up", "Collapse"],
  ["lucide-arrow-left", "Back"],
  ["lucide-arrow-right", "Next"],
  ["lucide-refresh-cw", "Refresh"],
  ["lucide-search", "Search"],
]);

function hasVisibleLabelSource(control: Element, label: string): boolean {
  if (hasLabelSource(control, "visible", label)) {
    return true;
  }
  if (
    control instanceof HTMLInputElement &&
    ["checkbox", "radio"].includes(control.type)
  ) {
    const labels = Array.from(control.labels ?? []);
    return labels.length === 1 && hasLabelSource(labels[0], "text", label);
  }
  return false;
}

function hasAccessibleLabelSource(control: Element, label: string): boolean {
  if (control.hasAttribute("aria-labelledby")) {
    return hasReferencedLabelSource(control, "aria-labelledby", label);
  }
  if (control.hasAttribute("aria-label")) {
    return hasLabelSource(control, "accessible", label);
  }
  const screenReaderLabel = control.querySelector(".sr-only");
  return (
    screenReaderLabel !== null &&
    hasLabelSource(screenReaderLabel, "text", label)
  );
}

function automaticTabList(event: KeyboardEvent): Element | null {
  const target = event.target;
  if (!(target instanceof Element && target.matches('[role="tab"]'))) {
    return null;
  }
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  ) {
    return null;
  }
  return target
    .closest('[data-slot="tabs"]')
    ?.getAttribute("data-analytics-tab-activation") === "manual"
    ? null
    : target.closest('[role="tablist"]');
}

function downloadClickProperties(control: Element): SurfaceAnalyticsProperties {
  const value = control.getAttribute("data-analytics-download-clicked");
  return value === "true" || value === "false"
    ? { [OnboardingAnalyticsProperty.DownloadClicked]: value === "true" }
    : {};
}
