import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import { authPageAppearance } from "./appearance";

export const SignIn = () => <ClerkSignIn appearance={authPageAppearance} />;
