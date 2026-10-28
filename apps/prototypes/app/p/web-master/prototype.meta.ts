import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

// Owner of the signed-in first-run onboarding gate on both Desktop and Web; the
// older `web-onboarding-flow` prototype is superseded for that flow and its meta
// records the same boundary.
//
// Presumed production data contract (none of this exists on today's DTOs; each
// line is an API change this prototype assumes before it can be built):
// - Organization discovery: Clerk membership/invitation authority answers
//   whether an existing organization is available to join. The user's email
//   domain may only prefill the proposed name and slug for a new organization.
//   The mocked member count also drives the invite step's social proof.
// - Local analysis counts: a desktop-local progress feed carrying total sessions
//   discovered and analyzed, per source (Claude Code / Codex / Cursor), including
//   a "not detected" state for a source that is absent.
// - GitHub connection: the existing GitHub App install state, read as a boolean
//   plus the account login, and the ability to start the install from onboarding.
// - Desktop install: a latest-release download URL per platform. The prototype
//   links at `desktop-latest` release assets and detects the visitor's OS in the
//   browser; production is assumed to serve the same per-platform assets.
// - Invites: a batch invite endpoint taking a list of email addresses and
//   returning which were accepted, so the confirmation can name a count.
// - Sync policy: one per-device policy (full sessions / metadata only / local
//   only) that onboarding sets and Settings edits. Whether a policy can be
//   changed from any client and pushed to an offline desktop, or must be edited
//   on the device itself, is the open question annotated in Settings; until it is
//   answered the prototype only lets you edit THIS device.
// - Sync choice made (ISS-12363 web setup gate): a per-USER fact, "has made an
//   explicit sync choice", on any device or on the web sync step. The policy
//   itself stays per-device. Unset (never chosen) is distinct from Off, which is
//   a choice. The first explicit choice on ANY device releases the web gate;
//   later devices still default per-device. No DTO carries this today
//   (`dataSyncLevel` lives only on SessionDetail), so it needs an API field.
// - Desktop availability notification (ISS-12364): an endpoint that records
//   "email me when Desktop ships for <platform>" for an address and a platform,
//   and later sends that email. Neither exists; the download step's email
//   capture resolves a mock request (developer menu: Platform).
export const meta = {
  slug: "web-master",
  title: "Web Master",
  summary:
    "Launch-flow master and the owner of signed-in first-run onboarding: begins on the Dashboard with a blocking onboarding gate, then enters the simplified web shell with Sessions and Branches. Supersedes web-onboarding-flow for the onboarding flow. Also the PRD-595 demo master for shared artifact and project screens, including four-level project hierarchies, root-scoped grouping and sorting, ancestor-preserving filters, and root-only boards.",
  author: "Pascoe",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Master, PrototypeTag.Feature],
  createdAt: "2026-07-29",
  linearIssue: null,
  closedloopDoc: "ISS-6560",
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
