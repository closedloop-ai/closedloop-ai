import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRowActionsMenu } from "../agent-row-actions-menu";

// Render the Radix DropdownMenu inline so its items are queryable without
// driving the open interaction (which is flaky under jsdom), and wire
// `onSelect` to a click so the copy handler runs. The `asChild` "Open detail"
// item passes a `Link` child (a real anchor) with no `onSelect`, so it must
// render the child directly (the anchor) rather than wrapping it in a <button>.
// Mirrors the house mock precedent in
// branches/components/__tests__/branch-row-actions-menu.test.tsx.
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    asChild?: boolean;
    disabled?: boolean;
    onSelect?: () => void;
  }) =>
    isValidElement(children) && !onSelect ? (
      children
    ) : (
      <button disabled={disabled} onClick={() => onSelect?.()} type="button">
        {children}
      </button>
    ),
}));

const OPEN_DETAIL_RE = /open detail/i;

const ORIGINAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard"
);

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  if (ORIGINAL_CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(
      globalThis.navigator,
      "clipboard",
      ORIGINAL_CLIPBOARD_DESCRIPTOR
    );
    return;
  }
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
});

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "mcp::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Mcp,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgentRowActionsMenu", () => {
  it("exposes a keyboard-accessible, labelled kebab trigger", () => {
    render(<AgentRowActionsMenu item={makeComponent()} />);
    const trigger = screen.getByRole("button", { name: "Component actions" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("type", "button");
  });

  it("copies the component name when Copy component name is selected", async () => {
    const writeText = mockClipboard();
    render(
      <AgentRowActionsMenu
        item={makeComponent({ name: "mcp__closedloop__create-document" })}
      />
    );

    fireEvent.click(screen.getByText("Copy component name"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("mcp__closedloop__create-document")
    );
  });

  it("omits Open detail when no href factory is supplied", () => {
    render(<AgentRowActionsMenu item={makeComponent()} />);
    expect(screen.queryByText("Open detail")).not.toBeInTheDocument();
    // Copy is always offered.
    expect(screen.getByText("Copy component name")).toBeInTheDocument();
  });

  it("renders Open detail as a link to the per-component href when supplied", () => {
    const item = makeComponent({ id: "uuid-open-1", name: "My Agent" });
    const nav = createMemoryNavigation({ initialPath: "/agents" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <AgentRowActionsMenu
          getComponentHref={(component) =>
            `/agents/${encodeURIComponent(component.id)}`
          }
          item={item}
        />
      </NavigationProvider>
    );

    const link = screen.getByRole("link", { name: OPEN_DETAIL_RE });
    expect(link).toHaveAttribute("href", "/agents/uuid-open-1");
  });

  // Regression for the desktop no-op: a raw `<a>` reaches the Electron
  // navigation guard, which blocks the document navigation before the hash-store
  // adapter can honor it. Routing through the surface-agnostic `Link` drives the
  // active navigation adapter on a plain left-click, so "Open detail" actually
  // navigates on both surfaces. Assert the adapter's real state changed, not
  // just the rendered href string.
  it("drives the navigation adapter when Open detail is clicked (not a raw anchor)", () => {
    const item = makeComponent({ id: "uuid-open-2", name: "My Agent" });
    const nav = createMemoryNavigation({ initialPath: "/agents" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <AgentRowActionsMenu
          getComponentHref={(component) =>
            `/agents/${encodeURIComponent(component.id)}`
          }
          item={item}
        />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: OPEN_DETAIL_RE }));

    expect(nav.getCurrentHref()).toBe("/agents/uuid-open-2");
    expect(nav.getHistory()).toContain("/agents/uuid-open-2");
  });
});
