import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { usePath } from "@repo/navigation/use-path";
import type { Meta, StoryObj } from "@storybook/react";
import { LaptopIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";
import { V2GlobalNav } from "./v2-global-nav";

// Composites copy of stories/sidebar.stories.tsx (Composites/Navigation/
// Sidebar, v1.0), so v2.0 can change without touching v1.0. The sidebar is a
// section of every page, so it sits under Shared/Navigation (TAXONOMY.md, "The
// page tree").
//
// The Global Nav itself is in ./v2-global-nav.tsx, shared with Surfaces.

// The sr-only text inside SidebarTrigger, which is its accessible name.
const TOGGLE_SIDEBAR_LABEL = "Toggle Sidebar";

function GlobalNavDemo() {
  const pathname = usePath();
  // The preview's memory adapter starts at "/"; show Sessions as the active
  // view until an item is clicked so the default canvas matches the app.
  const activePath = pathname === "/" ? "/sessions" : pathname;

  return (
    <SidebarProvider>
      <V2GlobalNav activePath={activePath} />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <span className="text-muted-foreground text-sm">Sessions</span>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">
          <div className="grid auto-rows-min gap-4 md:grid-cols-3">
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
          </div>
          <div className="min-h-0 flex-1 rounded-xl bg-muted/50" />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const meta: Meta<typeof Sidebar> = {
  title: "Composites/Shared/Navigation/Sidebar",
  component: Sidebar,
  tags: ["stable", "autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj<typeof Sidebar>;

/**
 * `SidebarMenuButton`'s full `variant` (default/outline) × `size`
 * (sm/default/lg) axis — before this story, "outline" and "sm" never
 * rendered anywhere in this file's realistic `GlobalNav` demo, which only
 * ever shows the implicit defaults plus one explicit `size="lg"` row.
 */
export const MenuButtonSizesAndVariants: Story = {
  tags: ["!manifest"],
  render: () => (
    <SidebarProvider>
      <Sidebar className="static! h-auto min-h-0" collapsible="none">
        <SidebarContent className="gap-4 p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" tooltip="Small, default variant">
                <LaptopIcon />
                <span>Small, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Default size, default variant">
                <LaptopIcon />
                <span>Default size, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Large, default variant">
                <LaptopIcon />
                <span>Large, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                tooltip="Small, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Small, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Default size, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Default size, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="Large, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Large, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  ),
  parameters: { controls: { disable: true } },
};

export const GlobalNav: Story = {
  render: () => <GlobalNavDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Collapse and expand through the real control rather than the provider,
    // so the trigger's own wiring is what is under test.
    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "collapsed"
    );

    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Nav items are real links, so they are keyboard-reachable by construction
    // rather than by an onClick on a div — tabbing out of the search field at
    // the top of Labs lands on the first Labs item.
    //
    // Deliberately never clicked: the preview mounts ONE module-level memory
    // navigation adapter shared by every story in the sweep, so navigating
    // here would change the path the other stories render against.
    const dashboard = canvas.getByRole("link", { name: "Dashboard" });
    await expect(dashboard).toHaveAttribute("href", "/dashboard");

    const inbox = canvas.getByRole("link", { name: "Inbox" });
    canvas.getByPlaceholderText("Search").focus();
    await userEvent.tab();
    await expect(inbox).toHaveFocus();
  },
};

// The Sidebar root is the element carrying collapse state; it has no role or
// accessible name, so `data-slot` is the only handle for it.
function sidebarRoot(canvasElement: HTMLElement): Element {
  const root = canvasElement.querySelector('[data-slot="sidebar"]');
  if (root === null) {
    throw new Error("sidebar root did not render");
  }
  return root;
}
