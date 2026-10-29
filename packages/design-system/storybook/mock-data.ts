// Generic, project-agnostic Storybook sample data only. The Closedloop domain
// fixtures that used to live here (loops, documents, issues, pull requests,
// compute targets) moved to `@repo/app/shared/lib/domain-mock-data` in FEA-4296
// — importing `@closedloop-ai/loops-api` status configs from this package is now gated.

export type MockUser = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  initials?: string;
};

export const mockUsers: MockUser[] = [
  {
    id: "user-1",
    name: "Avery Carter",
    email: "avery@example.com",
    initials: "AC",
  },
  {
    id: "user-2",
    name: "Jordan Lee",
    email: "jordan@example.com",
    initials: "JL",
  },
  {
    id: "user-3",
    name: "Samir Patel",
    email: "samir@example.com",
    initials: "SP",
  },
];

export const mockInvoiceRows = [
  {
    invoice: "INV001",
    paymentStatus: "Paid",
    totalAmount: "$250.00",
    paymentMethod: "Credit Card",
  },
  {
    invoice: "INV002",
    paymentStatus: "Pending",
    totalAmount: "$150.00",
    paymentMethod: "PayPal",
  },
  {
    invoice: "INV003",
    paymentStatus: "Unpaid",
    totalAmount: "$350.00",
    paymentMethod: "Bank Transfer",
  },
  {
    invoice: "INV004",
    paymentStatus: "Paid",
    totalAmount: "$450.00",
    paymentMethod: "Credit Card",
  },
];

export type MockProjectRow = {
  id: string;
  name: string;
  owner: string;
  status: "Backlog" | "Active" | "Paused";
  updatedAt: string;
};

export const mockProjectRows: MockProjectRow[] = [
  {
    id: "project-1",
    name: "Billing v2",
    owner: "Avery Carter",
    status: "Active",
    updatedAt: "2026-05-24",
  },
  {
    id: "project-2",
    name: "Mobile onboarding",
    owner: "Jordan Lee",
    status: "Backlog",
    updatedAt: "2026-05-18",
  },
  {
    id: "project-3",
    name: "Usage reporting",
    owner: "Samir Patel",
    status: "Paused",
    updatedAt: "2026-05-12",
  },
  {
    id: "project-4",
    name: "Editor refresh",
    owner: "Avery Carter",
    status: "Active",
    updatedAt: "2026-05-27",
  },
  {
    id: "project-5",
    name: "Compute target audit",
    owner: "Jordan Lee",
    status: "Backlog",
    updatedAt: "2026-05-09",
  },
];

export const mockTrafficByMonth = [
  { month: "January", desktop: 186, mobile: 80 },
  { month: "February", desktop: 305, mobile: 200 },
  { month: "March", desktop: 237, mobile: 120 },
  { month: "April", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "June", desktop: 214, mobile: 140 },
];

export const mockBrowserVisitors = [
  { browser: "chrome", visitors: 275, fill: "var(--color-chrome)" },
  { browser: "safari", visitors: 200, fill: "var(--color-safari)" },
  { browser: "other", visitors: 190, fill: "var(--color-other)" },
];
