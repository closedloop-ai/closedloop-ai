import {
  PrototypeStatus,
  type PrototypeStatus as PrototypeStatusValue,
} from "../../../lib/registry";

export type Person = {
  id: string;
  name: string;
  initials: string;
  color: string;
};

export type NavIconName =
  | "dashboard"
  | "inbox"
  | "my-issues"
  | "documents"
  | "issues"
  | "sessions"
  | "branches"
  | "prototypes"
  | "agents"
  | "insights"
  | "loops"
  | "agent-monitoring"
  | "judges";

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export type TeamItem = {
  id: string;
  name: string;
  favorites?: readonly { id: string; name: string }[];
};

export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard" },
  { label: "Inbox", icon: "inbox", count: 8 },
  { label: "My Issues", icon: "my-issues" },
];

export const artifactsNav: readonly NavItem[] = [
  { label: "Documents", icon: "documents" },
  { label: "Issues", icon: "issues" },
  { label: "Sessions", icon: "sessions" },
  { label: "Branches", icon: "branches" },
  { label: "Prototypes", icon: "prototypes", isActive: true },
  { label: "Agents", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
    favorites: [
      { id: "fav-night-crew", name: "Night Crew" },
      { id: "fav-parker-triage", name: "Parker Triage" },
      { id: "fav-sprint", name: "6/29-7/2" },
    ],
  },
  { id: "team-platform", name: "Platform Engineering" },
  { id: "team-pe-test", name: "PE TEST" },
];

export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Loops", icon: "loops" },
  { label: "Agent Monitoring", icon: "agent-monitoring" },
  { label: "Judges", icon: "judges" },
];

export const people = {
  parker: {
    id: "parker",
    name: "Parker Byrd",
    initials: "PB",
    color: "bg-blue-100 text-blue-700",
  },
  andrew: {
    id: "andrew",
    name: "Andrew Eye",
    initials: "AE",
    color: "bg-emerald-100 text-emerald-700",
  },
  thadeus: {
    id: "thadeus",
    name: "Thadeus Burgess",
    initials: "TB",
    color: "bg-amber-100 text-amber-700",
  },
  jordan: {
    id: "jordan",
    name: "Jordan Lee",
    initials: "JL",
    color: "bg-violet-100 text-violet-700",
  },
  sara: {
    id: "sara",
    name: "Sara Chen",
    initials: "SC",
    color: "bg-rose-100 text-rose-700",
  },
  alex: {
    id: "alex",
    name: "Alex Rivera",
    initials: "AR",
    color: "bg-cyan-100 text-cyan-700",
  },
  priya: {
    id: "priya",
    name: "Priya Shah",
    initials: "PS",
    color: "bg-orange-100 text-orange-700",
  },
  morgan: {
    id: "morgan",
    name: "Morgan Kim",
    initials: "MK",
    color: "bg-lime-100 text-lime-700",
  },
} satisfies Record<string, Person>;

export type PrototypeRow = {
  id: string;
  name: string;
  description: string;
  owner: Person;
  collaborators: Person[];
  project: string;
  tags: string[];
  status: PrototypeStatusValue;
  version: number;
  openComments: number;
  updated: string;
  updatedAt: number;
  updatedBy: Person;
  previewUrl: string;
};

export const prototypes: PrototypeRow[] = [
  {
    id: "branches-v2",
    name: "Hello world app",
    description:
      "A simple multi-page app used to demonstrate prototype review.",
    owner: people.parker,
    collaborators: [
      people.andrew,
      people.jordan,
      people.sara,
      people.alex,
      people.priya,
      people.morgan,
      people.thadeus,
    ],
    project: "Ideas Triage",
    tags: ["example", "review"],
    status: PrototypeStatus.ReadyForReview,
    version: 8,
    openComments: 2,
    updated: "12 min ago",
    updatedAt: 1_775_000_000_000,
    updatedBy: people.jordan,
    previewUrl: "https://prototypes.preview.closedloop-stage.ai/p/hello-world",
  },
  {
    id: "document-comments",
    name: "Document comments",
    description: "Inline threads, mentions, and resolved comment states.",
    owner: people.parker,
    collaborators: [people.thadeus],
    project: "Documents",
    tags: ["comments", "documents"],
    status: PrototypeStatus.InProgress,
    version: 5,
    openComments: 6,
    updated: "Yesterday",
    updatedAt: 1_774_900_000_000,
    updatedBy: people.parker,
    previewUrl:
      "https://prototypes.preview.closedloop-stage.ai/p/document-comments",
  },
  {
    id: "sessions",
    name: "Sessions",
    description: "Session list and trace detail with linked artifacts.",
    owner: people.parker,
    collaborators: [people.andrew, people.jordan],
    project: "Symphony Alpha",
    tags: ["sessions", "trace"],
    status: PrototypeStatus.HandedOff,
    version: 12,
    openComments: 0,
    updated: "Jul 26",
    updatedAt: 1_774_800_000_000,
    updatedBy: people.andrew,
    previewUrl: "https://prototypes.preview.closedloop-stage.ai/p/sessions",
  },
  {
    id: "agent-profile",
    name: "Agent profile",
    description: "Agent capability inventory and related activity.",
    owner: people.andrew,
    collaborators: [people.parker],
    project: "Agents",
    tags: ["agents", "profile"],
    status: PrototypeStatus.Draft,
    version: 2,
    openComments: 1,
    updated: "Jul 24",
    updatedAt: 1_774_700_000_000,
    updatedBy: people.parker,
    previewUrl: "https://prototypes.preview.closedloop-stage.ai/p/agents",
  },
  {
    id: "desktop-onboarding",
    name: "Desktop onboarding",
    description: "First-run setup and compute target selection.",
    owner: people.thadeus,
    collaborators: [people.parker, people.sara],
    project: "Desktop",
    tags: ["desktop", "onboarding"],
    status: PrototypeStatus.InProgress,
    version: 4,
    openComments: 4,
    updated: "Jul 22",
    updatedAt: 1_774_600_000_000,
    updatedBy: people.sara,
    previewUrl:
      "https://prototypes.preview.closedloop-stage.ai/p/desktop-onboarding",
  },
];

export type Annotation = {
  id: number;
  displayNumber: number;
  version: number;
  author: Person;
  body: string;
  anchorId: string;
  target: string;
  selector: string;
  route: string;
  createdAt: string;
  proposedChanges?: AnnotationEdits;
  replies?: AnnotationReply[];
  resolved?: boolean;
};

export type AnnotationReply = {
  id: number;
  author: Person;
  body: string;
  createdAt: string;
};

export const initialAnnotations: Annotation[] = [
  {
    id: 1,
    displayNumber: 1,
    version: 8,
    author: people.andrew,
    body: "Can we make the primary action more prominent?",
    anchorId: "hello-primary-action",
    target: "Get started button",
    selector: "button[data-anno-id='hello-primary-action']",
    route: "/home",
    createdAt: "8 min ago",
  },
  {
    id: 2,
    displayNumber: 2,
    version: 8,
    author: people.parker,
    body: "This team description should be shorter and friendlier.",
    anchorId: "hello-team-copy",
    target: "Team description",
    selector: "p[data-anno-id='hello-team-copy']",
    route: "/about",
    createdAt: "3 min ago",
  },
  {
    id: 701,
    displayNumber: 1,
    version: 7,
    author: people.andrew,
    body: "Can we make this introduction a little more welcoming?",
    anchorId: "hello-team-copy",
    target: "Team description",
    selector: "p[data-anno-id='hello-team-copy']",
    route: "/about",
    createdAt: "Jul 24",
  },
];

export type PrototypeVersion = {
  number: number;
  label: string;
  createdAt: string;
  createdBy: Person;
  status: PrototypeVersionStatus;
  changeSummary: string;
};

export const PrototypeVersionStatus = {
  Current: "Current",
  Superseded: "Superseded",
} as const;

export type PrototypeVersionStatus =
  (typeof PrototypeVersionStatus)[keyof typeof PrototypeVersionStatus];

export const prototypeVersions: readonly PrototypeVersion[] = [
  {
    number: 8,
    label: "v8",
    createdAt: "12 min ago",
    createdBy: people.jordan,
    status: PrototypeVersionStatus.Current,
    changeSummary: "Added the Contact page.",
  },
  {
    number: 7,
    label: "v7",
    createdAt: "Jul 24",
    createdBy: people.parker,
    status: PrototypeVersionStatus.Superseded,
    changeSummary: "Added the About page.",
  },
  {
    number: 6,
    label: "v6",
    createdAt: "Jul 21",
    createdBy: people.andrew,
    status: PrototypeVersionStatus.Superseded,
    changeSummary: "Initial Hello World landing page.",
  },
];

export type AnnotationTarget = {
  anchorId: string;
  target: string;
  selector: string;
  route: string;
  tagName?: string;
  text?: string;
  textColor?: string;
  background?: string;
  opacity?: string;
  font?: string;
  html?: string;
};

export type AnnotationEdits = Pick<
  AnnotationTarget,
  "background" | "font" | "html" | "opacity" | "text" | "textColor"
>;
