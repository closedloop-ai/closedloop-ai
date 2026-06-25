import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import type { Meta, StoryObj } from "@storybook/react";
import { FileIcon, FlaskConicalIcon, PlusIcon, UsersIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

const ARTIFACT_ITEMS = ["PRDs", "Implementation Plans", "Features"];

function SectionItems({ items }: { items: readonly string[] }) {
  return (
    <SidebarMenu>
      {items.map((label) => (
        <SidebarMenuItem key={label}>
          <SidebarMenuButton>
            <FileIcon />
            <span className="truncate">{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function SidebarFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-[360px] w-[320px] rounded-lg border">
        <Sidebar>
          <SidebarContent>{children}</SidebarContent>
        </Sidebar>
        <SidebarInset />
      </div>
    </SidebarProvider>
  );
}

function SidebarCollapsibleSectionDemo(
  props: ComponentProps<typeof SidebarCollapsibleSection>
) {
  return (
    <SidebarFrame>
      <SidebarCollapsibleSection {...props} />
    </SidebarFrame>
  );
}

const meta = {
  title: "Design System/Navigation & Shell/Sidebar Collapsible Section",
  component: SidebarCollapsibleSectionDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    title: "Artifacts",
    defaultOpen: true,
    children: <SectionItems items={ARTIFACT_ITEMS} />,
  },
} satisfies Meta<typeof SidebarCollapsibleSectionDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CollapsedByDefault: Story = {
  args: { defaultOpen: false },
};

export const WithTrailingAction: Story = {
  args: {
    title: "Your Teams",
    action: (
      <button
        className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
        type="button"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        <span className="sr-only">Add Team</span>
      </button>
    ),
    children: <SectionItems items={["Platform", "Growth", "Design"]} />,
  },
};

export const Stacked: Story = {
  render: () => (
    <SidebarFrame>
      <SidebarCollapsibleSection title="Artifacts">
        <SectionItems items={ARTIFACT_ITEMS} />
      </SidebarCollapsibleSection>
      <SidebarCollapsibleSection
        action={
          <button
            className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
            type="button"
          >
            <UsersIcon className="h-3.5 w-3.5" />
            <span className="sr-only">Manage teams</span>
          </button>
        }
        title="Your Teams"
      >
        <SectionItems items={["Platform", "Growth"]} />
      </SidebarCollapsibleSection>
      <SidebarCollapsibleSection defaultOpen={false} title="Labs">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <FlaskConicalIcon />
              <span className="truncate">Experiments</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarCollapsibleSection>
    </SidebarFrame>
  ),
};
