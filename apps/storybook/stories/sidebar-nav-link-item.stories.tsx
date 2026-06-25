import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarNavLinkItem,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import type { Meta, StoryObj } from "@storybook/react";
import { BellIcon, BotIcon, LockIcon } from "lucide-react";
import { useState } from "react";

function SidebarNavLinkItemDemo() {
  const [activeKey, setActiveKey] = useState("notifications");

  return (
    <SidebarProvider>
      <div className="flex min-h-[260px] w-[320px] rounded-lg border">
        <Sidebar>
          <SidebarContent>
            <div className="p-2">
              <SidebarNavLinkItem
                href="#notifications"
                icon={<BellIcon />}
                isActive={activeKey === "notifications"}
                title="Notifications"
                tooltip="Notifications"
                trailing={<SidebarCountBadge count={6} />}
              />
              <SidebarNavLinkItem
                href="#agents"
                icon={<BotIcon />}
                isActive={activeKey === "agents"}
                title="Agents"
                tooltip="Agents"
                trailing={
                  <span className="rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] text-sidebar-accent-foreground uppercase tracking-wide">
                    Beta
                  </span>
                }
              />
              <SidebarNavLinkItem
                disabled
                icon={<LockIcon />}
                title="Restricted"
                tooltip="Restricted"
              />
            </div>
          </SidebarContent>
        </Sidebar>
        <SidebarInset />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="rounded border px-2 py-1 text-xs"
          onClick={() => setActiveKey("notifications")}
          type="button"
        >
          Activate Notifications
        </button>
        <button
          className="rounded border px-2 py-1 text-xs"
          onClick={() => setActiveKey("agents")}
          type="button"
        >
          Activate Agents
        </button>
      </div>
    </SidebarProvider>
  );
}

const meta = {
  title: "Design System/Navigation & Shell/Sidebar Nav Link Item",
  component: SidebarNavLinkItemDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SidebarNavLinkItemDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {};
