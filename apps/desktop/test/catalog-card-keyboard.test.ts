import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  Children,
  type ComponentType,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { CatalogEntry } from "../src/shared/agent-db-contract";

type KeyboardActivationEvent = {
  key: string;
  currentTarget: object;
  target: object;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

type InspectableProps = {
  children?: ReactNode;
  href?: string;
  onKeyDown?: (event: KeyboardActivationEvent) => void;
  role?: string;
};

type InspectableElement = ReactElement<InspectableProps>;

type CatalogCardComponent = ComponentType<{
  entry: CatalogEntry;
  installing?: Record<string, boolean>;
  onClick: (packId: string) => void;
  onInstall: (packId: string, harness: string) => void;
  onUninstall: (packId: string, harness: string) => void;
}>;

const sampleEntry: CatalogEntry = {
  category: "Productivity",
  contents: null,
  contentsCache: null,
  description: "Installs a focused workflow pack.",
  descriptionLive: null,
  detectionPatterns: null,
  displayName: "Workflow Pack",
  forks: 12,
  githubUrl: "https://github.com/closedloop-ai/workflow-pack",
  harnessAgnostic: false,
  harnesses: ["codex"],
  history: [
    { fetchedAt: "2026-06-08T00:00:00.000Z", forks: 10, stars: 120 },
    { fetchedAt: "2026-06-08T01:00:00.000Z", forks: 12, stars: 125 },
  ],
  installCommands: { codex: "codex install workflow-pack" },
  installNotes: null,
  installedHarnesses: [],
  lastRelease: null,
  marketplaceUrl: null,
  packId: "workflow-pack",
  pinOrder: null,
  placeholderReason: null,
  postInstall: null,
  projectScoped: false,
  readmeExcerpt: null,
  seedVersion: 1,
  singleInstall: false,
  skillCount: 1,
  stars: 125,
  uninstallCommands: { codex: "codex uninstall workflow-pack" },
  usageCount: 0,
  verified: true,
};

describe("CatalogCard keyboard activation", () => {
  test("opens details from the focused card body without intercepting the GitHub link", async () => {
    const CatalogCard = await loadCatalogCard();
    const openedPackIds: string[] = [];
    const card = CatalogCard({
      entry: sampleEntry,
      onClick: (packId) => openedPackIds.push(packId),
      onInstall: () => {},
      onUninstall: () => {},
    });
    const detailsTarget = findElement(
      card,
      (element) => element.props.role === "button"
    );
    const githubLink = findElement(
      detailsTarget,
      (element) => element.props.href === sampleEntry.githubUrl
    );
    const handler = detailsTarget.props.onKeyDown;

    assert.ok(handler, "CatalogCard details target must handle keyboard input");

    const parentEnter = keyboardEvent("Enter", detailsTarget, detailsTarget);
    handler(parentEnter);

    assert.deepEqual(openedPackIds, [sampleEntry.packId]);
    assert.equal(parentEnter.defaultPrevented, true);

    const linkEnter = keyboardEvent("Enter", detailsTarget, githubLink);
    handler(linkEnter);

    assert.deepEqual(
      openedPackIds,
      [sampleEntry.packId],
      "Nested GitHub link Enter must not open details through the parent handler"
    );
    assert.equal(
      linkEnter.defaultPrevented,
      false,
      "Nested GitHub link Enter must keep the browser's link activation behavior"
    );
  });
});

async function loadCatalogCard(): Promise<CatalogCardComponent> {
  Reflect.set(globalThis, "React", { createElement });
  const module = await import(
    "../src/renderer/components/features/CatalogCard"
  );
  return module.CatalogCard;
}

function keyboardEvent(
  key: string,
  currentTarget: object,
  target: object
): KeyboardActivationEvent {
  return {
    currentTarget,
    defaultPrevented: false,
    key,
    preventDefault() {
      this.defaultPrevented = true;
    },
    target,
  };
}

function findElement(
  node: ReactNode,
  predicate: (element: InspectableElement) => boolean
): InspectableElement {
  const element = asInspectableElement(node);
  if (!element) {
    throw new Error("Unable to inspect a non-element React node");
  }
  if (predicate(element)) {
    return element;
  }
  for (const child of Children.toArray(element.props.children)) {
    try {
      return findElement(child, predicate);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
  }
  throw new Error("Unable to find matching React element");
}

function asInspectableElement(node: ReactNode): InspectableElement | null {
  return isValidElement<InspectableProps>(node) ? node : null;
}
