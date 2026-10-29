import {
  Sidebar,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSkeleton,
  SidebarMenuSubButton,
  SidebarNavLinkItem,
  SidebarProvider,
  SidebarSectionHeader,
  SidebarTrigger,
  useSidebar,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@closedloop-ai/design-system/components/ui/sidebar-collapsible-section";
import type {
  NavigationAdapter,
  NavigationLinkProps,
} from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@closedloop-ai/design-system/hooks/use-mobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

afterEach(cleanup);

describe("useSidebar", () => {
  it("throws when read outside a SidebarProvider", () => {
    // React logs the render error to console in addition to rethrowing it;
    // silence that expected noise for the duration of this one assertion.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(() => render(<SidebarConsumer />)).toThrow(
      "useSidebar must be used within a SidebarProvider."
    );

    consoleError.mockRestore();
  });
});

describe("SidebarProvider", () => {
  describe.each([true, false])(
    "keyboard shortcuts with defaultOpen=%s",
    (defaultOpen) => {
      it.each([{ metaKey: true }, { ctrlKey: true }])(
        "leaves text editing to the focused field (%j)",
        (modifier) => {
          const { container } = render(
            <SidebarProvider defaultOpen={defaultOpen}>
              <Sidebar />
              <input aria-label="Title" />
              <textarea aria-label="Description" />
              <div contentEditable suppressContentEditableWarning>
                <span>Editable text</span>
              </div>
              <div
                contentEditable="plaintext-only"
                suppressContentEditableWarning
              >
                Plain text
              </div>
            </SidebarProvider>
          );
          const sidebar = container.querySelector('[data-slot="sidebar"]');
          for (const target of [
            screen.getByRole("textbox", { name: "Title" }),
            screen.getByRole("textbox", { name: "Description" }),
            screen.getByText("Editable text"),
            screen.getByText("Plain text"),
          ]) {
            const event = new KeyboardEvent("keydown", {
              key: "b",
              bubbles: true,
              cancelable: true,
              ...modifier,
            });
            fireEvent(target, event);
            expect(event.defaultPrevented).toBe(false);
            expect(sidebar).toHaveAttribute(
              "data-state",
              defaultOpen ? "expanded" : "collapsed"
            );
          }
        }
      );

      it.each([{ metaKey: true }, { ctrlKey: true }])(
        "preserves shortcuts in text-entry input types (%j)",
        (modifier) => {
          const inputTypes = [
            undefined,
            "text",
            "TEXT",
            "invalid-type",
            "search",
            "email",
            "tel",
            "url",
            "password",
            "number",
          ];
          const { container } = render(
            <SidebarProvider defaultOpen={defaultOpen}>
              <Sidebar />
              {inputTypes.map((type) => (
                <input
                  aria-label={type ?? "Default type"}
                  key={type ?? "default"}
                  type={type}
                />
              ))}
            </SidebarProvider>
          );
          const sidebar = container.querySelector('[data-slot="sidebar"]');
          for (const type of inputTypes) {
            const target = screen.getByLabelText(type ?? "Default type");
            target.focus();
            const event = new KeyboardEvent("keydown", {
              key: "b",
              bubbles: true,
              cancelable: true,
              ...modifier,
            });
            fireEvent(target, event);
            expect(event.defaultPrevented).toBe(false);
            expect(target).toHaveFocus();
            expect(sidebar).toHaveAttribute(
              "data-state",
              defaultOpen ? "expanded" : "collapsed"
            );
          }
        }
      );

      it.each([{ metaKey: true }, { ctrlKey: true }])(
        "still toggles from non-text input controls (%j)",
        (modifier) => {
          const inputTypes = [
            "checkbox",
            "radio",
            "range",
            "button",
            "submit",
            "reset",
            "color",
            "file",
          ];
          const { container } = render(
            <SidebarProvider defaultOpen={defaultOpen}>
              <Sidebar />
              {inputTypes.map((type) => (
                <input aria-label={type} key={type} type={type} />
              ))}
            </SidebarProvider>
          );
          const sidebar = container.querySelector('[data-slot="sidebar"]');
          for (const type of inputTypes) {
            const target = screen.getByLabelText(type);
            target.focus();
            fireEvent.keyDown(target, { key: "b", ...modifier });
            expect(sidebar).toHaveAttribute(
              "data-state",
              defaultOpen ? "collapsed" : "expanded"
            );
            fireEvent.keyDown(target, { key: "b", ...modifier });
            expect(sidebar).toHaveAttribute(
              "data-state",
              defaultOpen ? "expanded" : "collapsed"
            );
          }
        }
      );

      it("respects an already handled shortcut outside editable elements", () => {
        const { container } = render(
          <SidebarProvider defaultOpen={defaultOpen}>
            <Sidebar />
            <button onKeyDown={(event) => event.preventDefault()} type="button">
              Handled shortcut
            </button>
          </SidebarProvider>
        );
        fireEvent.keyDown(
          screen.getByRole("button", { name: "Handled shortcut" }),
          { key: "b", metaKey: true }
        );
        expect(
          container.querySelector('[data-slot="sidebar"]')
        ).toHaveAttribute("data-state", defaultOpen ? "expanded" : "collapsed");
      });

      it.each([{ metaKey: true }, { ctrlKey: true }])(
        "still toggles outside text editing (%j)",
        (modifier) => {
          const { container } = render(
            <SidebarProvider defaultOpen={defaultOpen}>
              <Sidebar />
              <button type="button">Outside editor</button>
            </SidebarProvider>
          );
          const target = screen.getByRole("button", { name: "Outside editor" });
          const sidebar = container.querySelector('[data-slot="sidebar"]');
          fireEvent.keyDown(target, { key: "b", ...modifier });
          expect(sidebar).toHaveAttribute(
            "data-state",
            defaultOpen ? "collapsed" : "expanded"
          );
          fireEvent.keyDown(target, { key: "b", ...modifier });
          expect(sidebar).toHaveAttribute(
            "data-state",
            defaultOpen ? "expanded" : "collapsed"
          );
        }
      );
    }
  );

  it("renders its children", () => {
    render(
      <SidebarProvider>
        <div>Provider content</div>
      </SidebarProvider>
    );

    expect(screen.getByText("Provider content")).toBeInTheDocument();
  });

  it("defaults to the expanded state", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <div>Body</div>
        </Sidebar>
      </SidebarProvider>
    );

    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "expanded"
    );
  });

  it("honors a controlled open prop over the uncontrolled default", () => {
    const { container } = render(
      <SidebarProvider onOpenChange={vi.fn()} open={false}>
        <Sidebar>
          <div>Body</div>
        </Sidebar>
      </SidebarProvider>
    );

    expect(container.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed"
    );
  });
});

describe("SidebarTrigger", () => {
  it("renders a labeled toggle button that flips the sidebar state", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <div>Body</div>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).toHaveAttribute("data-state", "expanded");

    fireEvent.click(trigger);

    expect(sidebar).toHaveAttribute("data-state", "collapsed");
  });
});

describe("Sidebar", () => {
  it("renders a plain div with no data-state when collapsible is none", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <span>Fixed body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const sidebar = container.querySelector('[data-slot="sidebar"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar).not.toHaveAttribute("data-state");
    expect(screen.getByText("Fixed body")).toBeInTheDocument();
  });
});

describe("SidebarGroupLabel", () => {
  it("renders a div by default", () => {
    render(
      <SidebarProvider>
        <SidebarGroupLabel>Group</SidebarGroupLabel>
      </SidebarProvider>
    );

    expect(screen.getByText("Group").tagName).toBe("DIV");
  });
});

describe("SidebarSectionHeader", () => {
  it("renders the title, and only renders an action slot when one is given", () => {
    const { rerender } = render(
      <SidebarProvider>
        <SidebarSectionHeader title="Section" />
      </SidebarProvider>
    );

    expect(screen.getByText("Section")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <SidebarProvider>
        <SidebarSectionHeader
          action={<button type="button">Action</button>}
          title="Section"
        />
      </SidebarProvider>
    );

    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });
});

describe("SidebarNavLinkItem", () => {
  it("renders a disabled item as inert, non-navigating text", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarNavLinkItem disabled href="/settings" title="Settings" />
        </SidebarMenu>
      </SidebarProvider>
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveClass("pointer-events-none");
  });

  it("renders through the navigation Link when enabled with an href", () => {
    render(
      <NavigationProvider adapter={fakeNavigationAdapter}>
        <SidebarProvider>
          <SidebarMenu>
            <SidebarNavLinkItem href="/settings" title="Settings" />
          </SidebarMenu>
        </SidebarProvider>
      </NavigationProvider>
    );

    const link = screen.getByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings");
  });
});

describe("SidebarMenuSkeleton", () => {
  it("renders an icon skeleton when showIcon is set", () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuSkeleton showIcon />
      </SidebarProvider>
    );

    expect(
      container.querySelector('[data-sidebar="menu-skeleton-icon"]')
    ).not.toBeNull();
  });

  it("renders only the text skeleton when showIcon is not set", () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuSkeleton />
      </SidebarProvider>
    );

    expect(
      container.querySelector('[data-sidebar="menu-skeleton-icon"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar="menu-skeleton-text"]')
    ).not.toBeNull();
  });
});

describe("SidebarMenuButton", () => {
  it("returns the button directly when no tooltip is supplied", () => {
    render(
      <SidebarProvider>
        <SidebarMenuButton>Label</SidebarMenuButton>
      </SidebarProvider>
    );

    const button = screen.getByRole("button", { name: "Label" });
    expect(button).toHaveAttribute("data-slot", "sidebar-menu-button");
  });
});

/**
 * ISS-10057 retuned `--sidebar-ring` against the sidebar surfaces, and
 * `app/test/a11y/sidebar-ring-contrast.test.ts` measures it as a straight
 * token-against-surface read. An opacity modifier at ANY call site would
 * composite the ring back down — 1.68:1 on a hovered item is what this ticket
 * fixed — while that sweep went on reporting the full-strength ratio and
 * stayed green. So every component that paints the token is pinned here, not
 * just the menu button.
 *
 * What this does NOT catch: a SEVENTH call site added later with an opacity
 * modifier, since the table below is hand-kept and a unit test may not
 * text-scan `sidebar.tsx` to derive it (`no-raw-text-source-scan`). Adding a
 * `ring-sidebar-ring` call site means adding its row.
 */
describe("sidebar focus ring", () => {
  it.each(sidebarRingCallSites())(
    "draws $slot from --sidebar-ring at full strength",
    ({ slot, element }) => {
      const { container } = render(
        <SidebarProvider>{element}</SidebarProvider>
      );

      const target = container.querySelector(`[data-slot="${slot}"]`);
      expect(target, slot).not.toBeNull();
      expect(target).toHaveClass("ring-sidebar-ring");
      expect(target).toHaveClass("focus-visible:ring-2");
      expect(target?.className).not.toMatch(SIDEBAR_RING_OPACITY_MODIFIER);
    }
  );
});

describe("SidebarInset", () => {
  it("renders a main landmark", () => {
    render(<SidebarInset>Content</SidebarInset>);

    expect(screen.getByRole("main")).toHaveTextContent("Content");
  });
});

function SidebarConsumer() {
  useSidebar();
  return null;
}

/**
 * Minimal navigation adapter — only `Link` is exercised by
 * `SidebarNavLinkItem`; the rest of the port surface is stubbed so a
 * mistaken call fails loudly instead of resolving to a plausible default.
 */
function FakeLink({ href, children, ...rest }: NavigationLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

const fakeNavigationAdapter: NavigationAdapter = {
  Link: FakeLink,
  useNavigationActions: () => {
    throw new Error("not used by this test");
  },
  usePathValue: () => "",
  useRouteParamsValue: () => ({}),
  useSearchParamsSnapshot: () => new URLSearchParams(),
  useOrgPathBuilder: () => (path: string) => path,
};

/** A Tailwind opacity modifier on the sidebar's focus-ring colour. */
const SIDEBAR_RING_OPACITY_MODIFIER = /ring-sidebar-ring\//;

/**
 * Every element in this package that paints `ring-sidebar-ring`: five in
 * `sidebar.tsx` and the collapsible section's trigger. A function declaration
 * rather than a const so `it.each` can read it from above.
 */
function sidebarRingCallSites(): readonly {
  slot: string;
  element: ReactNode;
}[] {
  return [
    {
      slot: "sidebar-group-label",
      element: <SidebarGroupLabel>Group</SidebarGroupLabel>,
    },
    {
      slot: "sidebar-group-action",
      element: <SidebarGroupAction>Action</SidebarGroupAction>,
    },
    {
      slot: "sidebar-menu-button",
      element: <SidebarMenuButton>Label</SidebarMenuButton>,
    },
    {
      slot: "sidebar-menu-action",
      element: <SidebarMenuAction>Action</SidebarMenuAction>,
    },
    {
      slot: "sidebar-menu-sub-button",
      element: <SidebarMenuSubButton href="/x">Sub</SidebarMenuSubButton>,
    },
    {
      slot: "collapsible-trigger",
      element: (
        <SidebarCollapsibleSection title="Section">
          Body
        </SidebarCollapsibleSection>
      ),
    },
  ];
}
