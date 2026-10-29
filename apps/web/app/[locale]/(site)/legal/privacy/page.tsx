import type { Metadata } from "next";
import { createPageMetadata } from "@/lib/site";
import {
  LegalConfirmation,
  LegalDocument,
  LegalSection,
  LegalSubsection,
} from "../_components/legal-document";

export const generateMetadata = (): Metadata =>
  createPageMetadata(
    "Privacy Policy",
    "Learn how Closedloop.ai handles personal information through its website, desktop application, and software development platform.",
    "/legal/privacy"
  );

export default function PrivacyPolicyPage() {
  return (
    <LegalDocument
      lastUpdated="September 2026"
      title="Closedloop.ai Privacy Policy"
    >
      <p>
        This policy explains how Closedloop.ai, Inc. ("Closedloop," "we," or
        "us") handles personal information through the Closedloop.ai website,
        desktop application, and software development platform (the "Service").
        It does not cover Healthy or other products with separate policies. If
        an organization provides your workspace, it may control the content and
        settings in that workspace.
      </p>

      <LegalSection title="Information we collect">
        <LegalSubsection title="Account and workspace information">
          <p>
            We collect information you or your organization provide, such as
            your name, email address, authentication identifiers, workspace
            name, membership, roles, permissions, and settings.
          </p>
        </LegalSubsection>
        <LegalSubsection title="Content and integrations">
          <p>
            The Service may process PRDs, implementation plans, code references,
            repository information, prompts, sessions, branches, transcripts,
            comments, outputs, and other material you or your team submit or
            generate ("Workspace Content"). What we process depends on the
            features you use. If you connect GitHub, we receive information
            authorized through that integration, such as account and repository
            identifiers and content needed for connected features.
          </p>
        </LegalSubsection>
        <LegalSubsection title="Usage and technical information">
          <p>
            We collect information about use of the Service, such as feature
            interactions, timestamps, device and browser information, IP
            addresses, diagnostic data, and error logs. Cookies or similar
            technologies may support authentication, preferences, security, and
            usage measurement.
          </p>
        </LegalSubsection>
      </LegalSection>

      <LegalSection title="How we use information">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Provide the Service, including accounts, collaboration,
            integrations, AI features, and support.
          </li>
          <li>
            Maintain security, troubleshoot problems, prevent misuse, and
            enforce our terms.
          </li>
          <li>
            Understand and improve performance and features using usage
            information and feedback.
          </li>
          <li>Communicate about the Service and meet legal obligations.</li>
        </ul>
        <p>
          Where a legal basis is required, we process information to provide the
          Service or perform a contract, for legitimate interests in operating
          and securing it, to comply with law, or with consent when required.
          Where an organization controls Workspace Content, we generally process
          it on that organization’s instructions.
        </p>
      </LegalSection>

      <LegalSection title="AI processing and model training">
        <p>
          AI features may send relevant Workspace Content to model providers to
          perform requested tasks.
        </p>
        <LegalConfirmation>
          [TO CONFIRM BEFORE PUBLICATION: State whether Closedloop or its model
          providers use Workspace Content for model training, and describe any
          applicable settings and provider retention.]
        </LegalConfirmation>
      </LegalSection>

      <LegalSection title="When we share information">
        <p>
          We share information with providers that help operate the Service,
          including Clerk for authentication, AWS for hosting, and AI model or
          other technical providers used for features you choose. We share
          information with GitHub when you authorize its integration. Providers
          receive information as needed for their services and subject to
          applicable agreements.
        </p>
        <p>
          We may disclose information to comply with law or valid legal process,
          protect rights or safety, investigate abuse, or in connection with a
          merger, financing, acquisition, or sale of assets. We do not sell
          personal information.
        </p>
        <LegalConfirmation>
          [TO CONFIRM BEFORE PUBLICATION: Verify whether analytics or
          advertising activity constitutes “sharing” under California law.]
        </LegalConfirmation>
      </LegalSection>

      <LegalSection title="Retention">
        <p>
          We keep information as reasonably needed to provide the Service, meet
          legal obligations, resolve disputes, and protect the Service. Deletion
          from active systems and backups may follow different schedules.
          Confirm these periods against the actual product and infrastructure
          before publication:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Account and workspace data after account or workspace deletion:
            [CONFIRM RETENTION PERIOD AND DELETION TRIGGER].
          </li>
          <li>
            Transcripts or conversation content, if stored: [CONFIRM DEFAULT
            RETENTION, WHETHER STORAGE IS ON BY DEFAULT, AND USER CONTROLS].
          </li>
          <li>Activity logs and telemetry: [CONFIRM RETENTION PERIOD].</li>
          <li>Backup copies after deletion: [CONFIRM RECOVERY WINDOW].</li>
        </ul>
      </LegalSection>

      <LegalSection title="Security">
        <p>
          We use reasonable technical and organizational measures designed to
          protect information, including access controls and safeguards
          appropriate to the Service. No system is completely secure. We will
          give notice of a security incident as required by applicable law.
        </p>
      </LegalSection>

      <LegalSection title="Your choices and rights">
        <p>
          You may be able to manage account details, workspace settings,
          integrations, and cookies through the Service or your browser. To
          request access to, correction of, or deletion of personal information,
          email{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:privacy@closedloop.ai"
          >
            privacy@closedloop.ai
          </a>
          . Depending on where you live, additional rights may include
          portability, objection, restriction, or appeal. We will respond as
          required by law and may verify your identity. For
          organization-controlled Workspace Content, we may direct your request
          to the organization.
        </p>
        <p>
          California residents may have rights under applicable California law,
          including to know, correct, and delete certain information and to opt
          out of covered sale or sharing if applicable. Residents of the EEA or
          UK may have rights under applicable law and may complain to their data
          protection authority. Exceptions may apply.
        </p>
      </LegalSection>

      <LegalSection title="International use">
        <p>
          Closedloop is based in the United States. Information may be processed
          in the United States and other places where we or our providers
          operate. Where required, we use appropriate mechanisms for
          international transfers.
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>
          The Service is intended for adults and professional use, not children
          under 13. We do not knowingly collect personal information from
          children under 13. If you believe a child has provided information,
          contact us.
        </p>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <p>
          We may update this policy as the Service changes. We will post the
          updated version with a revised date and provide additional notice when
          required by law or when changes materially affect how we handle
          information.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          For privacy questions or requests, email{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="mailto:privacy@closedloop.ai"
          >
            privacy@closedloop.ai
          </a>
          . Closedloop.ai, Inc.
        </p>
        <LegalConfirmation>
          [CONFIRM BUSINESS MAILING ADDRESS BEFORE PUBLICATION].
        </LegalConfirmation>
      </LegalSection>
    </LegalDocument>
  );
}
