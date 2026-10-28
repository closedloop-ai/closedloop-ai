"use client";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  BadgeCheckIcon,
  Building2Icon,
  ChevronDownIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  LaptopIcon,
  type LucideIcon,
  PuzzleIcon,
  SlidersHorizontalIcon,
  TagsIcon,
  UserRoundIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import {
  MemberSettings,
  OrganizationSettings,
  PluginsSettings,
  ProfileSettings,
} from "./settings-account-panels";
import {
  ConnectedDevicesSettings,
  LocalComputeTargetsSettings,
} from "./settings-device-panels";
import {
  ApiKeysSettings,
  ComplianceSettings,
  CustomFieldsSettings,
  OtherLabsSettings,
  TagsSettings,
} from "./settings-labs-panels";

type SettingsPanel =
  | "profile"
  | "connected-devices"
  | "plugins"
  | "organization"
  | "members"
  | "custom-fields"
  | "tags"
  | "compliance"
  | "api-keys"
  | "other-labs"
  | "local-compute-targets";

type SettingsNavigationItem = {
  icon: LucideIcon;
  id: SettingsPanel;
  label: string;
};

const USER_SETTINGS: readonly SettingsNavigationItem[] = [
  { icon: UserRoundIcon, id: "profile", label: "Profile" },
  {
    icon: LaptopIcon,
    id: "connected-devices",
    label: "Connected Devices",
  },
  { icon: PuzzleIcon, id: "plugins", label: "Plugins" },
];

const ORGANIZATION_SETTINGS: readonly SettingsNavigationItem[] = [
  { icon: Building2Icon, id: "organization", label: "General" },
  { icon: UsersIcon, id: "members", label: "Members" },
];

const LABS_SETTINGS: readonly SettingsNavigationItem[] = [
  {
    icon: SlidersHorizontalIcon,
    id: "custom-fields",
    label: "Custom Fields",
  },
  { icon: TagsIcon, id: "tags", label: "Tags" },
  { icon: BadgeCheckIcon, id: "compliance", label: "Compliance" },
  { icon: KeyRoundIcon, id: "api-keys", label: "API Keys" },
  {
    icon: LaptopIcon,
    id: "local-compute-targets",
    label: "Local Compute Targets",
  },
  {
    icon: FlaskConicalIcon,
    id: "other-labs",
    label: "Other Labs Settings",
  },
];

export function SettingsSurface({
  initialPanel = "profile",
}: {
  initialPanel?: SettingsPanel;
} = {}) {
  const navigation = useNavigation();
  const [activePanel, setActivePanel] = useState<SettingsPanel>(initialPanel);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          navigation.navigate("/p/web-master/dashboard");
        }
      }}
      open
    >
      <DialogContent
        className="grid h-[min(880px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] max-w-none grid-cols-[240px_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your user and organization settings.
        </DialogDescription>

        <SettingsModalNavigation
          activePanel={activePanel}
          onClose={() => navigation.navigate("/p/web-master/dashboard")}
          onSelect={setActivePanel}
        />

        <div className="min-w-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl p-8 lg:p-10">
            <SettingsPanelContent activePanel={activePanel} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsModalNavigation({
  activePanel,
  onClose,
  onSelect,
}: {
  activePanel: SettingsPanel;
  onClose: () => void;
  onSelect: (panel: SettingsPanel) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r bg-muted/20 p-3">
      <Button
        aria-label="Close settings"
        className="mb-5 size-9"
        onClick={onClose}
        size="icon"
        variant="ghost"
      >
        <XIcon className="size-5" />
      </Button>

      <SettingsNavigationGroup
        activePanel={activePanel}
        items={USER_SETTINGS}
        label="User setting"
        onSelect={onSelect}
      />
      <SettingsNavigationGroup
        activePanel={activePanel}
        items={ORGANIZATION_SETTINGS}
        label="Organization settings"
        onSelect={onSelect}
      />

      <Collapsible className="mb-6">
        <CollapsibleTrigger asChild>
          <button
            className="group mb-2 flex w-full items-center gap-2 rounded-md px-3 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground"
            type="button"
          >
            <FlaskConicalIcon className="size-3.5" />
            <span className="flex-1">Labs</span>
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1">
          {LABS_SETTINGS.map((item) => (
            <SettingsNavigationButton
              active={activePanel === item.id}
              icon={item.icon}
              key={item.id}
              label={item.label}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </aside>
  );
}

function SettingsNavigationGroup({
  activePanel,
  items,
  label,
  onSelect,
}: {
  activePanel: SettingsPanel;
  items: readonly SettingsNavigationItem[];
  label: string;
  onSelect: (panel: SettingsPanel) => void;
}) {
  return (
    <div className="mb-6">
      <p className="mb-2 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </p>
      <div className="space-y-1">
        {items.map((item) => (
          <SettingsNavigationButton
            active={activePanel === item.id}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SettingsNavigationButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
      }`}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </button>
  );
}

function SettingsPanelContent({ activePanel }: { activePanel: SettingsPanel }) {
  if (activePanel === "profile") {
    return <ProfileSettings />;
  }
  if (activePanel === "connected-devices") {
    return <ConnectedDevicesSettings />;
  }
  if (activePanel === "plugins") {
    return <PluginsSettings />;
  }
  if (activePanel === "organization") {
    return <OrganizationSettings />;
  }
  if (activePanel === "members") {
    return <MemberSettings />;
  }
  if (activePanel === "custom-fields") {
    return <CustomFieldsSettings />;
  }
  if (activePanel === "tags") {
    return <TagsSettings />;
  }
  if (activePanel === "compliance") {
    return <ComplianceSettings />;
  }
  if (activePanel === "api-keys") {
    return <ApiKeysSettings />;
  }
  if (activePanel === "local-compute-targets") {
    return <LocalComputeTargetsSettings />;
  }
  return <OtherLabsSettings />;
}
