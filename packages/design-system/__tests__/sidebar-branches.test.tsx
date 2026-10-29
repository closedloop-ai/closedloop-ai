import {
  SIDEBAR_COOKIE_NAME,
  Sidebar,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenuAction,
  SidebarMenuSubButton,
  SidebarProvider,
  useSidebar,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useMobileMock = vi.fn(() => false);

vi.mock("@closedloop-ai/design-system/hooks/use-mobile", () => ({
  useIsMobile: () => useMobileMock(),
}));

const COOKIE_VALUE_PATTERN = /sidebar_state=([a-z]+)/;
const TOGGLE_BUTTON_NAME_PATTERN = /^state:/;

afterEach(() => {
  cleanup();
  useMobileMock.mockReturnValue(false);
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; mirrors SidebarProvider's own cookie write.
  document.cookie = `${SIDEBAR_COOKIE_NAME}=; path=/; max-age=0`;
});

/** Reads back the sidebar_state cookie value set by SidebarProvider's setOpen. */
function readSidebarCookie(): string | null {
  const match = COOKIE_VALUE_PATTERN.exec(document.cookie);
  return match ? match[1] : null;
}

function ToggleConsumer() {
  const { toggleSidebar, state } = useSidebar();
  return (
    <button onClick={toggleSidebar} type="button">
      state:{state}
    </button>
  );
}

function OpenSetter() {
  const { open, setOpen } = useSidebar();
  return (
    <button onClick={() => setOpen(true)} type="button">
      open:{String(open)}
    </button>
  );
}

describe("SidebarProvider setOpen", () => {
  it("writes the resolved open state to the sidebar cookie (uncontrolled)", () => {
    render(
      <SidebarProvider defaultOpen={false}>
        <OpenSetter />
      </SidebarProvider>
    );

    // Mount does not itself call setOpen, so no cookie exists yet.
    expect(readSidebarCookie()).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveTextContent("open:true");
    expect(readSidebarCookie()).toBe("true");
  });

  it("calls onOpenChange instead of updating internal state when controlled", () => {
    const onOpenChange = vi.fn();

    render(
      <SidebarProvider onOpenChange={onOpenChange} open={false}>
        <OpenSetter />
      </SidebarProvider>
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Controlled: the prop never changed, so the consumer still reads false.
    expect(screen.getByRole("button")).toHaveTextContent("open:false");
  });

  it("resolves a function updater against the current open value", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
      </SidebarProvider>
    );

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("state:expanded");

    fireEvent.click(button);

    expect(button).toHaveTextContent("state:collapsed");
    expect(readSidebarCookie()).toBe("false");
  });
});

describe("SidebarProvider toggleSidebar mobile routing", () => {
  it("toggles openMobile, not the desktop state, when isMobile is true", () => {
    useMobileMock.mockReturnValue(true);

    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
        <Sidebar>
          <span>Body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const toggleButton = screen.getByRole("button", {
      name: TOGGLE_BUTTON_NAME_PATTERN,
    });
    fireEvent.click(toggleButton);

    // Desktop `state` is unaffected by the mobile toggle.
    expect(toggleButton).toHaveTextContent("state:expanded");
    // The mobile Sheet is now open, proving setOpenMobile (not setOpen) fired.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("SidebarProvider keyboard shortcut", () => {
  it("toggles the sidebar on Cmd+B (metaKey)", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
      </SidebarProvider>
    );

    fireEvent.keyDown(window, { key: "b", metaKey: true });

    expect(screen.getByRole("button")).toHaveTextContent("state:collapsed");
  });

  it("toggles the sidebar on Ctrl+B (ctrlKey) when metaKey is absent", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
      </SidebarProvider>
    );

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, metaKey: false });

    expect(screen.getByRole("button")).toHaveTextContent("state:collapsed");
  });

  it("does not toggle on b alone, with no modifier key held", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
      </SidebarProvider>
    );

    fireEvent.keyDown(window, { key: "b" });

    expect(screen.getByRole("button")).toHaveTextContent("state:expanded");
  });

  it("does not toggle on a non-shortcut key even with metaKey held", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
      </SidebarProvider>
    );

    fireEvent.keyDown(window, { key: "x", metaKey: true });

    expect(screen.getByRole("button")).toHaveTextContent("state:expanded");
  });
});

describe("Sidebar mobile rendering", () => {
  beforeEach(() => {
    useMobileMock.mockReturnValue(true);
  });

  it("renders inside a Sheet dialog when isMobile is true", () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <ToggleConsumer />
        <Sidebar>
          <span>Mobile body</span>
        </Sidebar>
      </SidebarProvider>
    );

    // The mobile Sidebar tracks `openMobile`, which starts false regardless
    // of `defaultOpen` (that prop only seeds the desktop `open` state) — open
    // it via the same toggle a real trigger would use.
    fireEvent.click(
      screen.getByRole("button", { name: TOGGLE_BUTTON_NAME_PATTERN })
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Mobile body")).toBeInTheDocument();
  });
});

describe("Sidebar desktop side attribute", () => {
  it("renders data-side=left by default", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <span>Body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const outer = container.querySelector('[data-side="left"]');
    expect(outer).not.toBeNull();
    const sidebarContainer = container.querySelector(
      '[data-slot="sidebar-container"]'
    );
    expect(sidebarContainer).toHaveClass("left-0");
    expect(sidebarContainer).not.toHaveClass("right-0");
  });

  it("renders data-side=right and mirrors the container placement class", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar side="right">
          <span>Body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const outer = container.querySelector('[data-side="right"]');
    expect(outer).not.toBeNull();
    const sidebarContainer = container.querySelector(
      '[data-slot="sidebar-container"]'
    );
    expect(sidebarContainer).toHaveClass("right-0");
  });
});

describe("Sidebar variant width classes", () => {
  it("applies the floating/inset icon-collapse width on the floating variant", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar variant="floating">
          <span>Body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const gap = container.querySelector('[data-slot="sidebar-gap"]');
    expect(gap?.className).toContain(
      "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
    );
  });

  it("applies the plain icon-collapse width on the default sidebar variant", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar variant="sidebar">
          <span>Body</span>
        </Sidebar>
      </SidebarProvider>
    );

    const gap = container.querySelector('[data-slot="sidebar-gap"]');
    expect(gap?.className).toContain(
      "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
    );
    expect(gap?.className).not.toContain(
      "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
    );
  });
});

describe("SidebarGroupLabel asChild", () => {
  it("renders through Slot onto the child element instead of a div", () => {
    render(
      <SidebarProvider>
        <SidebarGroupLabel asChild>
          <span>Group</span>
        </SidebarGroupLabel>
      </SidebarProvider>
    );

    const el = screen.getByText("Group");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveAttribute("data-slot", "sidebar-group-label");
  });
});

describe("SidebarGroupAction asChild", () => {
  it("renders through Slot onto the child element instead of a button", () => {
    render(
      <SidebarProvider>
        <SidebarGroupAction asChild>
          <a href="/x">Action</a>
        </SidebarGroupAction>
      </SidebarProvider>
    );

    const el = screen.getByText("Action");
    expect(el.tagName).toBe("A");
    expect(el).toHaveAttribute("data-slot", "sidebar-group-action");
  });
});

describe("SidebarMenuAction asChild and showOnHover", () => {
  it("renders through Slot onto the child element instead of a button", () => {
    render(
      <SidebarProvider>
        <SidebarMenuAction asChild>
          <a href="/x">Action</a>
        </SidebarMenuAction>
      </SidebarProvider>
    );

    const el = screen.getByText("Action");
    expect(el.tagName).toBe("A");
  });

  it("adds the hover-reveal classes when showOnHover is set", () => {
    render(
      <SidebarProvider>
        <SidebarMenuAction showOnHover>Action</SidebarMenuAction>
      </SidebarProvider>
    );

    const el = screen.getByText("Action");
    expect(el.className).toContain("md:opacity-0");
  });

  it("omits the hover-reveal classes when showOnHover is not set", () => {
    render(
      <SidebarProvider>
        <SidebarMenuAction>Action</SidebarMenuAction>
      </SidebarProvider>
    );

    const el = screen.getByText("Action");
    expect(el.className).not.toContain("md:opacity-0");
  });
});

describe("SidebarMenuSubButton size classes", () => {
  it("applies the small text class when size is sm", () => {
    render(
      <SidebarProvider>
        <SidebarMenuSubButton href="/x" size="sm">
          Sub
        </SidebarMenuSubButton>
      </SidebarProvider>
    );

    expect(screen.getByText("Sub")).toHaveClass("text-xs");
  });

  it("applies the default text class, not the small one, when size is md", () => {
    render(
      <SidebarProvider>
        <SidebarMenuSubButton href="/x" size="md">
          Sub
        </SidebarMenuSubButton>
      </SidebarProvider>
    );

    const el = screen.getByText("Sub");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });
});
