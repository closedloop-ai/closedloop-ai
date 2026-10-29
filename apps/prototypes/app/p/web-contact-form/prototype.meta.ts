import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-contact-form",
  title: "Web contact form",
  summary:
    "ISS-11492's missing destination. The marketing footer's Company > Contact link points at /contact, which has never existed — a live 404 on every marketing page, and the reason the web boot smoke could not reach networkidle. The operator's 2026-09-30 instruction supplies the destination: a contact form that sends to info@closedloop.ai, collecting first / last / email / company / # of engineers / message, with no captcha. This is the mock host for the real ContactForm surface in packages/app; the scenario switcher forces the send into both outcomes, because the failure panel is a state a production build owes and nothing renders today.",
  author: "Marisol Ashgrove",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-09-30",
  linearIssue: null,
  closedloopDoc: "ISS-11492",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). Every field is collected by
  // the surface and carried to the payload; `contact-form.test.tsx` pins that.
  //
  // NO API CHANGE IS PRESUMED, and no producer exists yet either. There is no
  // transport for this form today: `@repo/email` is keys-only (RESEND_TOKEN,
  // RESEND_FROM, both `.optional()`), nothing in the repo constructs a Resend
  // client, and `apps/web` has no route handler or server action. The only
  // outbound mail today is Clerk's organization invitation
  // (`apps/api/app/organizations/invitations/service.ts`), which Clerk itself
  // sends from its own templates and cannot carry an arbitrary form. So
  // `simulateSend` in mock.ts stands in for a transport the production PR has
  // to build, and that PR is blocked on a provisioned Resend key plus a
  // verified sender domain.
  //
  // COPY IS NOT SETTLED AND THIS SANDBOX DOES NOT PROPOSE IT. The six field
  // labels are the operator's own words and live in the surface. Every other
  // string — heading, submit label, success / failure / validation sentences —
  // is a REQUIRED prop of `ContactForm` with no default, and the values here
  // are `[copy TBD]`-prefixed placeholders. A production host therefore cannot
  // mount the surface without supplying copy a human ruled on, which is the
  // Human Provenance rule made structural rather than remembered.
  //
  // ONE THING THIS SANDBOX CANNOT EXPRESS: abuse control. The captcha was
  // dropped by the operator on 2026-09-30, and this repo has no rate limiter to
  // reuse, so the production endpoint is unauthenticated and sends to a human
  // inbox. That is a product call already made; it is recorded here because the
  // screen shows no trace of it.
  //
  // Production-bound: this route mounts its `main` landmark and the portable
  // `ContactFormDemo` host in `packages/app/marketing/contact`, and authors no
  // markup of its own. The scenario switcher lives in that host because
  // `scripts/lint/production-bound-prototype-route.ts` allows a production-bound
  // route no other rendered tag; the sandbox supplies its words as props.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
