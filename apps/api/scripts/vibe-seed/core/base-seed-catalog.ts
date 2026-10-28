import { Priority } from "@repo/api/src/types/common";

/**
 * ISS-12135 (bug 23): the vibe org's projects and the work inside them. Each
 * topic is one feature with its own PRD, plan, supporting doc and issues, all
 * filed under the project whose name fits it. Seeded data, not product copy.
 */

/** Where a topic is in its life; statuses and dates derive from it. */
export const TopicStage = {
  Shipped: "shipped",
  Building: "building",
  Reviewing: "reviewing",
  Drafting: "drafting",
  Revising: "revising",
  Shelved: "shelved",
} as const;
export type TopicStage = (typeof TopicStage)[keyof typeof TopicStage];

/** Who leads or writes a piece of work; mapped to seeded people by role. */
export const SeedRole = {
  Pm: "pm",
  Engineer: "engineer",
  Designer: "designer",
  /** The signed-in person: on Vercel the person running the session adopts this row. */
  Admin: "admin",
} as const;
export type SeedRole = (typeof SeedRole)[keyof typeof SeedRole];

export const SupportingDocKind = {
  Design: "design",
  Decision: "decision",
} as const;
export type SupportingDocKind =
  (typeof SupportingDocKind)[keyof typeof SupportingDocKind];

export type CatalogTopic = {
  readonly title: string;
  readonly stage: TopicStage;
  readonly priority: Priority;
  readonly doc: SupportingDocKind | null;
  readonly issues: readonly string[];
  /** The signed-in person writes the PRD and takes some of the issues. */
  readonly adminOwned?: boolean;
};

export type CatalogProject = {
  /**
   * The base seed's key for the project this one replaces: its row id is
   * `deterministicUuid("project:<org>:<key>")`, which survives the relabel.
   */
  readonly baseKey: string;
  readonly name: string;
  readonly description: string;
  readonly lead: SeedRole;
  readonly priority: Priority;
  readonly topics: readonly CatalogTopic[];
};

export const PROJECT_CATALOG: readonly CatalogProject[] = [
  {
    baseKey: "platform-foundation",
    name: "Platform Foundation",
    description:
      "Core infrastructure, authentication, and shared service layer.",
    lead: SeedRole.Engineer,
    priority: Priority.High,
    topics: [
      {
        title: "SAML certificate rotation",
        stage: TopicStage.Shipped,
        priority: Priority.High,
        doc: SupportingDocKind.Decision,
        issues: [
          "Rotate SAML signing certificates without downtime",
          "Email admins 30 days before a certificate expires",
          "Accept both certificates during the rotation window",
        ],
      },
      {
        title: "Rate limits for the public API",
        stage: TopicStage.Building,
        priority: Priority.Urgent,
        doc: SupportingDocKind.Decision,
        issues: [
          "Return Retry-After on 429 responses",
          "Per-key rate limit counters in Redis",
          "Rate limit usage panel for admins",
          "Document rate limits in the API reference",
        ],
      },
      {
        title: "Data retention settings",
        stage: TopicStage.Reviewing,
        priority: Priority.Medium,
        doc: SupportingDocKind.Decision,
        issues: [
          "Nightly job to purge expired activity",
          "Retention settings API",
        ],
      },
    ],
  },
  {
    baseKey: "developer-experience",
    name: "Developer Experience",
    description:
      "Tooling, documentation, and workflows that accelerate engineering velocity.",
    lead: SeedRole.Engineer,
    priority: Priority.Medium,
    topics: [
      {
        title: "Faster project switching",
        stage: TopicStage.Shipped,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Cache the project list in the switcher",
          "Keyboard shortcut to open the project switcher",
          "Preload the last three projects",
        ],
      },
      {
        title: "Webhook delivery dashboard",
        stage: TopicStage.Building,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "List recent webhook deliveries with status",
          "Retry a failed delivery from the dashboard",
          "Filter deliveries by event type",
          "Show the response body for failed deliveries",
        ],
      },
      {
        title: "Release notes generator",
        stage: TopicStage.Drafting,
        priority: Priority.Low,
        doc: SupportingDocKind.Decision,
        issues: ["Collect merged pull request titles per release"],
      },
    ],
  },
  {
    baseKey: "scaled-3",
    name: "Checkout Redesign",
    description:
      "Fewer steps from cart to paid order, starting with saved cards.",
    lead: SeedRole.Pm,
    priority: Priority.High,
    topics: [
      {
        title: "Saved cards at checkout",
        stage: TopicStage.Shipped,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "Store card tokens with the payment provider",
          "Show saved cards on the payment step",
          "Remove a saved card from account settings",
        ],
      },
      {
        title: "One-page checkout",
        stage: TopicStage.Building,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "Merge shipping and payment into one step",
          "Inline address validation",
          "Keep the order summary visible while scrolling",
          "Tax total rounds differently on the summary",
        ],
      },
      {
        title: "Promo codes at checkout",
        stage: TopicStage.Reviewing,
        priority: Priority.Medium,
        doc: SupportingDocKind.Decision,
        issues: [
          "Promo code field on the payment step",
          "Reject expired promo codes with a clear error",
        ],
      },
    ],
  },
  {
    baseKey: "scaled-4",
    name: "Mobile Onboarding",
    description: "First-run flow for the iOS and Android apps.",
    lead: SeedRole.Designer,
    priority: Priority.Medium,
    topics: [
      {
        title: "First-run tour for the mobile apps",
        stage: TopicStage.Building,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "Three-screen intro carousel",
          "Skip button on every intro screen",
          "Android back button closes the app during the tour",
          "Record tour completion in analytics",
        ],
      },
      {
        title: "Push permission prompt timing",
        stage: TopicStage.Reviewing,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Ask for push permission after the first project is created",
          "Link to system settings when push is denied",
        ],
      },
      {
        title: "Sign in with Apple",
        stage: TopicStage.Drafting,
        priority: Priority.Medium,
        doc: SupportingDocKind.Decision,
        issues: ["Apple sign-in on iOS"],
      },
    ],
  },
  {
    baseKey: "scaled-5",
    name: "Search Relevance",
    description: "Ranking and typo tolerance for workspace search.",
    lead: SeedRole.Engineer,
    priority: Priority.Medium,
    topics: [
      {
        title: "Typo tolerance in workspace search",
        stage: TopicStage.Shipped,
        priority: Priority.Medium,
        doc: SupportingDocKind.Decision,
        issues: [
          "Fuzzy matching for document titles",
          "Highlight matched terms in results",
          "Measure search latency after fuzzy matching",
        ],
      },
      {
        title: "Org-wide search shortcuts",
        stage: TopicStage.Building,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Cmd+K opens search from any page",
          "Recent searches in the search menu",
          "Group search results by type",
          "Escape closes search and restores focus",
        ],
      },
      {
        title: "Search ranking by recent activity",
        stage: TopicStage.Reviewing,
        priority: Priority.Low,
        doc: SupportingDocKind.Decision,
        issues: [
          "Boost recently updated documents",
          "Ranking weights behind an admin setting",
        ],
      },
    ],
  },
  {
    baseKey: "scaled-6",
    name: "Billing Platform",
    description: "Usage metering, invoices and plan changes in one service.",
    lead: SeedRole.Admin,
    priority: Priority.High,
    topics: [
      {
        title: "Invoice PDF redesign",
        stage: TopicStage.Shipped,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "New invoice PDF layout",
          "Company tax ID on invoices",
          "Download past invoices from billing settings",
        ],
      },
      {
        title: "Usage-based billing meter",
        stage: TopicStage.Building,
        priority: Priority.Urgent,
        doc: SupportingDocKind.Decision,
        adminOwned: true,
        issues: [
          "Meter API calls per workspace",
          "Hourly usage rollup job",
          "Usage chart on the billing page",
          "Invoice line items for metered usage",
        ],
      },
      {
        title: "Seat-based plan upgrades",
        stage: TopicStage.Reviewing,
        priority: Priority.High,
        doc: SupportingDocKind.Decision,
        adminOwned: true,
        issues: [
          "Prorate seat changes mid-cycle",
          "Upgrade prompt when seats run out",
        ],
      },
    ],
  },
  {
    baseKey: "scaled-7",
    name: "Notifications Overhaul",
    description: "One preference center for email, push and in-app alerts.",
    lead: SeedRole.Pm,
    priority: Priority.Medium,
    topics: [
      {
        title: "Slack digest for weekly activity",
        stage: TopicStage.Shipped,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Post the weekly digest to a chosen channel",
          "Include top closed issues in the digest",
          "Disconnect Slack from digest settings",
        ],
      },
      {
        title: "Granular email preferences",
        stage: TopicStage.Building,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "Per-project email settings",
          "Unsubscribe link for each notification type",
          "Migrate existing email preferences",
          "Weekly digest opt-in",
        ],
      },
      {
        title: "Mobile push for mentions",
        stage: TopicStage.Drafting,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: ["Push notification when mentioned in a comment"],
      },
    ],
  },
  {
    baseKey: "scaled-8",
    name: "Admin Console",
    description: "Member management, roles and audit history for org admins.",
    lead: SeedRole.Engineer,
    priority: Priority.High,
    topics: [
      {
        title: "Audit log export",
        stage: TopicStage.Shipped,
        priority: Priority.High,
        doc: SupportingDocKind.Decision,
        issues: [
          "Export the audit log as CSV",
          "Filter the audit log by actor",
          "Keep audit entries for 400 days",
        ],
      },
      {
        title: "Guest access for shared projects",
        stage: TopicStage.Building,
        priority: Priority.High,
        doc: SupportingDocKind.Decision,
        issues: [
          "Invite a guest to a single project",
          "Hide org-wide search results from guests",
          "Guest badge in member lists",
          "Remove guest access when a project is archived",
        ],
      },
      {
        title: "Two-factor recovery codes",
        stage: TopicStage.Reviewing,
        priority: Priority.Urgent,
        doc: SupportingDocKind.Decision,
        issues: [
          "Generate ten recovery codes at two-factor setup",
          "Let admins reset a member's two-factor",
        ],
      },
    ],
  },
  {
    baseKey: "scaled-9",
    name: "Data Export API",
    description: "Scheduled and on-demand exports for enterprise customers.",
    lead: SeedRole.Engineer,
    priority: Priority.Medium,
    topics: [
      {
        title: "Export to FTP servers",
        stage: TopicStage.Shelved,
        priority: Priority.Low,
        doc: SupportingDocKind.Decision,
        issues: ["FTP export target"],
      },
      {
        title: "Read-only share links",
        stage: TopicStage.Reviewing,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Create a read-only link for a project",
          "Revoke a share link",
        ],
      },
      {
        title: "Bulk import from CSV",
        stage: TopicStage.Revising,
        priority: Priority.Medium,
        doc: null,
        issues: ["Validate CSV headers before import"],
      },
      {
        title: "Scheduled exports",
        stage: TopicStage.Drafting,
        priority: Priority.High,
        doc: SupportingDocKind.Decision,
        issues: ["Daily export to a customer S3 bucket"],
      },
    ],
  },
  {
    baseKey: "scaled-10",
    name: "Accessibility Audit",
    description: "WCAG 2.2 AA fixes across the web app.",
    lead: SeedRole.Designer,
    priority: Priority.Medium,
    topics: [
      {
        title: "Keyboard navigation for the board view",
        stage: TopicStage.Shipped,
        priority: Priority.High,
        doc: SupportingDocKind.Design,
        issues: [
          "Arrow keys move focus between cards",
          "Visible focus ring on cards",
          "Skip link to the main content",
        ],
      },
      {
        title: "Screen reader labels for icon buttons",
        stage: TopicStage.Building,
        priority: Priority.Medium,
        doc: SupportingDocKind.Design,
        issues: [
          "Accessible names for toolbar icon buttons",
          "Announce status changes in a live region",
          "Muted text fails contrast in dark mode",
          "Tie form errors to their fields",
        ],
      },
      {
        title: "Reduced motion support",
        stage: TopicStage.Drafting,
        priority: Priority.Low,
        doc: SupportingDocKind.Design,
        issues: ["Respect reduced motion in page transitions"],
      },
    ],
  },
];
