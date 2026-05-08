import { SignUp as ClerkSignUp } from "@clerk/nextjs";
import { authPageAppearance } from "./appearance";

export const SignUp = () => <ClerkSignUp appearance={authPageAppearance} />;
