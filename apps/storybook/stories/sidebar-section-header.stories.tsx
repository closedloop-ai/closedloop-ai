import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
  SidebarSectionHeader,
} from "@repo/design-system/components/ui/sidebar";
import type { Meta, StoryObj } from "@storybook/react";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

function SidebarSectionHeaderDemo() {
  const [expanded, setExpanded] = useState(true);
  const [count, setCount] = useState(0);

  return (
    <SidebarProvider>
      <div className="flex min-h-[220px] w-[320px] rounded-lg border">
        <Sidebar>
          <SidebarContent>
            <div className="p-2">
              <SidebarSectionHeader
                action={
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
                    onClick={() => setCount((current) => current + 1)}
                    type="button"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span className="sr-only">Add favorite</span>
                  </button>
                }
                title={`Favorites (${count})`}
              />
              <SidebarSectionHeader
                action={
                  <button
                    aria-expanded={expanded}
                    className="rounded-sm p-0.5 hover:bg-sidebar-accent"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                  >
                    <ChevronRightIcon
                      className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                    <span className="sr-only">Toggle teams</span>
                  </button>
                }
                className="mt-2"
                title="Your Teams"
              />
            </div>
          </SidebarContent>
        </Sidebar>
        <SidebarInset />
      </div>
    </SidebarProvider>
  );
}

const meta = {
  title: "Design System/Navigation & Shell/Sidebar Section Header",
  component: SidebarSectionHeaderDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SidebarSectionHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {};

export const WithLongTitle: Story = {
  render: () => (
    <SidebarProvider>
      <div className="flex min-h-[220px] w-[320px] rounded-lg border">
        <Sidebar>
          <SidebarContent>
            <div className="p-2">
              <SidebarSectionHeader
                action={
                  <button
                    className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
                    type="button"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span className="sr-only">Add team</span>
                  </button>
                }
                title="Recently Favorited Projects With A Very Long Sidebar Label"
              />
            </div>
          </SidebarContent>
        </Sidebar>
        <SidebarInset />
      </div>
    </SidebarProvider>
  ),
};
