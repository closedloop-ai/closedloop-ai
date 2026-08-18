import {
  BuildingIcon,
  DownloadCloudIcon,
  type LucideIcon,
  PinIcon,
  UserRoundIcon,
} from "lucide-react";

// The viewer whose treatment the page renders. The production page picks this
// from the caller's org capability (FEA-4084 / FEA-4088 / FEA-4089); here it's
// a prototype toggle.
export const Viewer = {
  Admin: "admin",
  Member: "member",
} as const;
export type Viewer = (typeof Viewer)[keyof typeof Viewer];

// The states each treatment can be in. Real pages resolve these from data +
// request status; the prototype exposes them as a picker so /design-review can
// see every state without wiring.
export const PageState = {
  Populated: "populated",
  Loading: "loading",
  Empty: "empty",
} as const;
export type PageState = (typeof PageState)[keyof typeof PageState];

// How an admin is distributing a pack. Mirrors the real `DistributionMode`
// (`packages/api/src/types/distribution.ts`): auto_install = required/pushed,
// opt_in = offered/blessed.
export const DistributionMode = {
  AutoInstall: "auto_install",
  OptIn: "opt_in",
} as const;
export type DistributionMode =
  (typeof DistributionMode)[keyof typeof DistributionMode];

// The canonical member-facing install source (the FEA-4090 contract concept):
// how did I get this pack. Resolved from distribution mode + install-link
// state. An unknown/legacy value falls back to a generic "Installed" rather
// than guessing.
export const InstallSource = {
  Required: "required",
  Pushed: "pushed",
  OrgBlessed: "org_blessed",
  Self: "self",
} as const;
export type InstallSource = (typeof InstallSource)[keyof typeof InstallSource];

// The label contract: one truthful icon + text per source, never color alone.
// The `unknown` entry is the compat-safe fallback for an unmapped source.
type SourceMeta = {
  label: string;
  description: string;
  icon: LucideIcon;
};

export const installSourceMeta: Record<InstallSource, SourceMeta> = {
  [InstallSource.Required]: {
    label: "Required by your org",
    description: "Pushed by an admin and can't be removed.",
    icon: PinIcon,
  },
  [InstallSource.Pushed]: {
    label: "Pushed by admin",
    description: "Installed for you automatically by your org.",
    icon: DownloadCloudIcon,
  },
  [InstallSource.OrgBlessed]: {
    label: "Org-blessed",
    description: "Offered by your org and accepted by you.",
    icon: BuildingIcon,
  },
  [InstallSource.Self]: {
    label: "Self-installed",
    description: "You installed this yourself.",
    icon: UserRoundIcon,
  },
};

// Compat-safe fallback for a source value the client doesn't recognize (a
// newer/legacy contract value). Never render blank or guess a stronger claim.
export const unknownSourceMeta: SourceMeta = {
  label: "Installed",
  description: "Installed on your machine.",
  icon: DownloadCloudIcon,
};

export const sourceMetaFor = (source: InstallSource | string): SourceMeta =>
  // Own-key guard so an inherited key like `constructor` can't resolve to an
  // Object.prototype member instead of falling through to the safe fallback.
  Object.hasOwn(installSourceMeta, source)
    ? installSourceMeta[source as InstallSource]
    : unknownSourceMeta;

// Distribution-mode label for the admin table's Mode column, plus the plain
// gloss the row shows so the mode isn't jargon.
export const distributionModeMeta: Record<
  DistributionMode,
  { label: string; gloss: string; icon: LucideIcon }
> = {
  [DistributionMode.AutoInstall]: {
    label: "Required",
    gloss: "Auto-installed for every targeted member",
    icon: PinIcon,
  },
  [DistributionMode.OptIn]: {
    label: "Offered",
    gloss: "Members can accept and install",
    icon: BuildingIcon,
  },
};

// A pack an admin is distributing across the org.
export type DistributedPack = {
  id: string;
  name: string;
  publisher: string;
  version: string;
  mode: DistributionMode;
  installed: number;
  targeted: number;
  // Invocations over the last 30 days. `null` when usage telemetry hasn't
  // reported yet — shown as "Not reported", never a fake zero.
  invocations30d: number | null;
  // A pushed pack that failed to install on some targets (the strand state the
  // admin needs to see, not a hidden absence).
  failedInstalls?: number;
};

// A pack visible to a member, with its honest source when installed.
export type MemberPack = {
  id: string;
  name: string;
  publisher: string;
  description: string;
  version: string;
  source?: InstallSource;
  // True when this row is required but its push failed on this machine — the
  // honest "Required, install failed" strand, not a silent absence.
  installFailed?: boolean;
};

export const distributedPacks: readonly DistributedPack[] = [
  {
    id: "sec-baseline",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    mode: DistributionMode.AutoInstall,
    installed: 128,
    targeted: 132,
    invocations30d: 5400,
    failedInstalls: 4,
  },
  {
    id: "review-copilot",
    name: "Review Copilot",
    publisher: "Platform Eng",
    version: "2.1.3",
    mode: DistributionMode.AutoInstall,
    installed: 132,
    targeted: 132,
    invocations30d: 21_030,
  },
  {
    id: "release-notes",
    name: "Release Notes Writer",
    publisher: "DevEx",
    version: "1.4.0",
    mode: DistributionMode.OptIn,
    installed: 61,
    targeted: 132,
    invocations30d: 1890,
  },
  {
    id: "migration-guardrails",
    name: "Migration Guardrails",
    publisher: "Data Platform",
    version: "0.9.1",
    mode: DistributionMode.OptIn,
    // The strand state: distributed, offered, zero adoption. Shown, not hidden.
    installed: 0,
    targeted: 132,
    invocations30d: 0,
  },
  {
    id: "infra-linters",
    name: "Infra Linters",
    publisher: "Platform Eng",
    version: "3.0.0",
    mode: DistributionMode.OptIn,
    installed: 44,
    targeted: 132,
    // Usage telemetry not yet reporting for this pack.
    invocations30d: null,
  },
];

// Marketplace packs an admin could add to the catalog (secondary region).
export const catalogPacks: readonly MemberPack[] = [
  {
    id: "test-scaffolder",
    name: "Test Scaffolder",
    publisher: "DevEx",
    description: "Generates unit + integration test skeletons from a diff.",
    version: "2.6.0",
  },
  {
    id: "changelog-bot",
    name: "Changelog Bot",
    publisher: "Community",
    description: "Drafts a changelog entry from merged PRs on each release.",
    version: "1.1.2",
  },
  {
    id: "a11y-auditor",
    name: "Accessibility Auditor",
    publisher: "Community",
    description: "Flags WCAG issues in changed components during review.",
    version: "0.7.0",
  },
];

// The member's required packs (admin auto_install, non-removable).
export const memberRequired: readonly MemberPack[] = [
  {
    id: "sec-baseline",
    name: "Security Baseline",
    publisher: "Platform Eng",
    description: "Org security gates and secret scanning on every session.",
    version: "4.2.0",
    source: InstallSource.Required,
  },
  {
    id: "review-copilot",
    name: "Review Copilot",
    publisher: "Platform Eng",
    description: "Inline review suggestions tuned to your org's standards.",
    version: "2.1.3",
    source: InstallSource.Required,
  },
  {
    id: "migration-guardrails",
    name: "Migration Guardrails",
    publisher: "Data Platform",
    description: "Blocks unsafe schema migrations before they ship.",
    version: "0.9.1",
    source: InstallSource.Required,
    // Required but the push failed on this machine: honest strand row.
    installFailed: true,
  },
];

// The member's installed (non-required) packs, each with its honest source.
export const memberInstalled: readonly MemberPack[] = [
  {
    id: "release-notes",
    name: "Release Notes Writer",
    publisher: "DevEx",
    description: "Turns merged work into a readable release summary.",
    version: "1.4.0",
    // Dual-source in the data model (offered by org AND self-installed): the
    // treatment shows the strongest truthful label once, org-blessed.
    source: InstallSource.OrgBlessed,
  },
  {
    id: "infra-linters",
    name: "Infra Linters",
    publisher: "Platform Eng",
    description: "Lints Terraform and Helm changes against org policy.",
    version: "3.0.0",
    source: InstallSource.OrgBlessed,
  },
  {
    id: "onboarding-kit",
    name: "Onboarding Kit",
    publisher: "Platform Eng",
    description: "Sets up your workspace with the org's starter agents.",
    version: "1.2.0",
    // Pushed by an admin (auto-installed) but removable — distinct from the
    // non-removable Required source, so /design-review can see how the
    // "Pushed by admin" treatment renders.
    source: InstallSource.Pushed,
  },
  {
    id: "commit-summarizer",
    name: "Commit Summarizer",
    publisher: "Community",
    description: "Writes conventional-commit messages from staged changes.",
    version: "1.9.4",
    source: InstallSource.Self,
  },
  {
    id: "doc-linker",
    name: "Doc Linker",
    publisher: "Community",
    description: "Cross-links code symbols to the docs that describe them.",
    version: "0.5.2",
    source: InstallSource.Self,
  },
];

// Marketplace packs a member could install themselves (secondary region).
export const memberAvailable: readonly MemberPack[] = catalogPacks;

export const totalMembers = 132;

// Adoption percentage for the admin table, rounded for the ARIA value too.
export const adoptionPct = (pack: DistributedPack): number =>
  pack.targeted === 0 ? 0 : Math.round((pack.installed / pack.targeted) * 100);

export const formatCount = (value: number): string =>
  value.toLocaleString("en-US");
