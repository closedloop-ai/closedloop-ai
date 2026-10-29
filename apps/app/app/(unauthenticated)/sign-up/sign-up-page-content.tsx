import dynamic from "next/dynamic";
import type { DesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";
import { DesktopBootstrapSignUpGate } from "./desktop-bootstrap-sign-up-gate";

const SignUp = dynamic(() =>
  import("@repo/auth/components/sign-up").then((mod) => mod.SignUp)
);

/** Render shared by the server route and its request-independent stories. */
export function SignUpPageContent({
  browserRun,
}: {
  readonly browserRun: DesktopBootstrapBrowserRun | null;
}) {
  return (
    <DesktopBootstrapSignUpGate browserRun={browserRun}>
      <SignUp />
    </DesktopBootstrapSignUpGate>
  );
}
