import { WEB_MASTER_BASE_PATH } from "@repo/app/shell/v2/components/web-master-preview/mock";
import { redirect } from "next/navigation";

const SignUpPage = () => {
  redirect(`${WEB_MASTER_BASE_PATH}/dashboard`);
};

export default SignUpPage;
