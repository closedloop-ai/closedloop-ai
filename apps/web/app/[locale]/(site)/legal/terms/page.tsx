import type { Metadata } from "next";
import { createPageMetadata, localize } from "@/lib/site";
import {
  LegalConfirmation,
  LegalDocument,
  LegalSection,
} from "../_components/legal-document";

// ISS-11397: NOINDEX while the page still carries TO CONFIRM BEFORE PUBLICATION
// blocks. A pre-publication draft indexed under our name is worse than no result,
// and a crawler that takes it now may keep serving it after the final language
// lands. `follow` stays true: the directive is about THIS page, not its links.
//
// DELETE THIS BLOCK when the confirmations below are resolved.
export const generateMetadata = (): Metadata => ({
  ...createPageMetadata(
    "Terms of Service",
    "Read the terms governing use of the Closedloop.ai website, desktop application, and software development platform.",
    "/legal/terms"
  ),
  robots: { follow: true, index: false },
});

export default async function TermsOfServicePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  return (
    <LegalDocument
      lastUpdated="September 2026"
      title="Closedloop.ai Terms of Service"
    >
      <p>
        These Terms govern your use of the Closedloop.ai website, desktop
        application, and software development platform (the “Service”) operated
        by Closedloop.ai, Inc. (“Closedloop,” “we,” or “us”). They do not govern
        Healthy or other products with separate terms. By using the Service, you
        agree to these Terms. If you use it for an organization, you confirm
        that you are authorized to act for that organization; otherwise, you
        agree personally. A signed order form or agreement with Closedloop
        controls if it expressly conflicts with these Terms.
      </p>

      <LegalSection title="1. The Service">
        <p>
          The Service helps individuals and teams plan, build, review, and
          deliver software using tools such as PRDs, implementation plans,
          sessions, branches, transcripts, GitHub integration, collaboration,
          and AI-assisted workflows. Features may change. We will use reasonable
          efforts to give notice of material changes that substantially reduce a
          paid feature during an active subscription.
        </p>
      </LegalSection>

      <LegalSection title="2. Accounts and access">
        <p>
          You must provide accurate account information, protect your
          credentials, and promptly tell us about suspected unauthorized access.
          You are responsible for activity under your account and for managing
          the people you authorize to use your workspace. You must be at least
          18 or the age of majority where you live.
        </p>
      </LegalSection>

      <LegalSection title="3. Your content and permissions">
        <p>
          You and your licensors retain your rights in code, prompts, documents,
          repository material, and other content you submit to the Service
          (“Your Content”). You grant Closedloop a nonexclusive, worldwide,
          royalty-free license to host, process, transmit, display, and
          otherwise use Your Content only as needed to provide, secure, support,
          and maintain the Service and to comply with law. This license ends
          when Your Content is deleted from our systems, subject to permitted
          retention under the Privacy Policy and applicable law.
        </p>
        <p>
          You must have the rights and permissions needed to submit Your Content
          and connect repositories or other services. You are responsible for
          deciding what information your team sends to the Service and for
          reviewing access granted to teammates, integrations, and agents. We
          will handle personal information as described in the{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={localize(locale, "/legal/privacy")}
          >
            Privacy Policy
          </a>
          .
        </p>
        <LegalConfirmation>
          [TO CONFIRM BEFORE PUBLICATION: Align model-training language with the
          Privacy Policy and actual provider settings.]
        </LegalConfirmation>
      </LegalSection>

      <LegalSection title="4. Closedloop intellectual property">
        <p>
          Closedloop and its licensors retain rights in the Service, including
          software, design, documentation, and trademarks. We grant you a
          limited, nonexclusive, nontransferable right to use the Service during
          your account or subscription term in accordance with these Terms.
          Feedback you choose to give us may be used to improve the Service
          without an obligation to you, but it does not transfer ownership of
          Your Content.
        </p>
      </LegalSection>

      <LegalSection title="5. Acceptable use">
        <p>
          You may not use the Service to violate law or others’ rights, access
          accounts or systems without authorization, introduce malware,
          interfere with the Service, evade security or usage controls, or
          extract the Service’s underlying code except where law permits. You
          may not use the Service to harass, exploit, or harm others. We may
          investigate credible misuse and take proportionate steps, including
          limiting access, when needed to protect the Service or others.
        </p>
      </LegalSection>

      <LegalSection title="6. AI features and integrations">
        <p>
          AI-generated plans, code, reviews, and other outputs may be
          inaccurate, incomplete, or similar to outputs generated for others.
          You are responsible for reviewing and testing outputs before using,
          merging, deploying, or sharing them. You remain responsible for
          decisions about your software, permissions, and compliance with
          third-party licenses. The Service may interact with external tools
          only within the permissions you or your organization provide.
          Third-party services, including GitHub, have their own terms and
          practices; we are not responsible for their independent operation.
        </p>
      </LegalSection>

      <LegalSection title="7. Fees and subscriptions">
        <p>
          If you choose a paid plan, the price, billing cycle, and scope shown
          at checkout or in an applicable order form govern. You authorize the
          stated charges and applicable taxes. Unless an order form says
          otherwise, subscriptions renew for successive periods of the same
          length until canceled. You may cancel renewal through available
          account controls or by contacting{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:billing@closedloop.ai"
          >
            billing@closedloop.ai
          </a>{" "}
          before the next renewal. Cancellation takes effect at the end of the
          paid period. Fees already paid are not refundable except as required
          by law or an applicable agreement. We may suspend paid features after
          reasonable notice of an overdue payment.
        </p>
      </LegalSection>

      <LegalSection title="8. Confidentiality">
        <p>
          Each party will protect the other party’s nonpublic information
          disclosed in connection with the Service using reasonable care and
          will use it only to perform under these Terms. This does not cover
          information that becomes public without breach, was already lawfully
          known, is independently developed, or is lawfully received from
          another source. A party may disclose information when required by law,
          with notice when legally permitted. These duties continue for three
          years after disclosure, and for trade secrets as long as they remain
          protected by law. A separate signed confidentiality agreement controls
          if it conflicts.
        </p>
      </LegalSection>

      <LegalSection title="9. Service availability and disclaimers">
        <p>
          We aim to keep the Service useful and available, but it may have
          interruptions and errors. To the extent permitted by law, the Service
          is provided “as is” and “as available,” without implied warranties of
          merchantability, fitness for a particular purpose, or noninfringement.
          We do not promise that AI output is accurate, that the Service will be
          uninterrupted, or that it will meet a particular requirement. These
          disclaimers do not limit express commitments in a signed agreement.
        </p>
      </LegalSection>

      <LegalSection title="10. Liability">
        <p>
          To the extent permitted by law, neither party is liable to the other
          for indirect, incidental, special, consequential, or punitive damages,
          or lost profits or business opportunities, arising from the Service.
          Each party’s total liability under these Terms is limited to the
          greater of $100 or the amount paid or payable for the Service in the
          12 months before the event giving rise to the claim. These limits do
          not apply to payment obligations, fraud, willful misconduct, or
          liability that cannot legally be limited. A signed agreement may set
          different limits.
        </p>
      </LegalSection>

      <LegalSection title="11. Third-party claims">
        <p>
          You will defend and indemnify Closedloop against a third-party claim
          that Your Content infringes that party’s intellectual property rights
          or that your unlawful use of the Service harmed that party, including
          reasonable costs and damages finally awarded or agreed in settlement.
          We will promptly notify you, let you control the defense, and
          cooperate reasonably at your expense. You may not settle a claim that
          imposes obligations on us without our consent, which we will not
          unreasonably withhold.
        </p>
      </LegalSection>

      <LegalSection title="12. Suspension and termination">
        <p>
          You may stop using the Service or close an individual account at any
          time, subject to an organization’s control of its workspace and any
          paid commitment. We may suspend access when reasonably necessary for
          security, unlawful activity, material breach, or nonpayment, and will
          give notice when practical. Either party may terminate for a material
          breach that remains uncured 30 days after written notice; we may act
          sooner where delay would cause harm or violate law. On termination,
          access ends. Provisions that by their nature should survive, including
          payment, ownership, confidentiality, disclaimers, liability, and
          disputes, will survive. Data retention is described in the Privacy
          Policy or an applicable agreement.
        </p>
      </LegalSection>

      <LegalSection title="13. Disputes and governing law">
        <p>
          These Terms are governed by Delaware law, excluding conflict-of-law
          rules. Before starting formal proceedings, the parties will try in
          good faith to resolve a dispute through written notice to{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:legal@closedloop.ai"
          >
            legal@closedloop.ai
          </a>{" "}
          and a reasonable opportunity to discuss it. If unresolved, disputes
          will be resolved by binding arbitration in accordance with applicable
          law, except that either party may seek temporary injunctive relief in
          court to protect confidential information or intellectual property,
          and either party may bring an eligible claim in small claims court.
          Claims that cannot lawfully be arbitrated may be brought in the state
          or federal courts in Delaware. Mandatory consumer rights remain
          unaffected.
        </p>
      </LegalSection>

      <LegalSection title="14. Changes and general terms">
        <p>
          We may update these Terms. We will provide reasonable advance notice
          of material changes, such as by email or in-product notice, when
          practical. Changes apply prospectively; continuing to use the Service
          after their effective date means you accept them. If you do not agree,
          stop using the Service and cancel any renewal. These Terms and
          applicable order forms are the entire agreement about the Service. If
          a provision is unenforceable, the rest remains in effect. Failure to
          enforce a provision is not a waiver. You may not assign these Terms
          without our consent; we may assign them in connection with a merger,
          reorganization, or sale of substantially all relevant assets.
        </p>
      </LegalSection>

      <LegalSection title="15. Contact">
        <p>
          Questions about these Terms:{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:legal@closedloop.ai"
          >
            legal@closedloop.ai
          </a>
          . Billing and cancellation:{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:billing@closedloop.ai"
          >
            billing@closedloop.ai
          </a>
          .
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
