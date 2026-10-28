import { WebMasterSettingsRoute } from "@repo/app/shell/v2/components/web-master-preview/routes/web-master-page-routes";

const WebMasterSettingsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) => {
  const { section } = await searchParams;

  return <WebMasterSettingsRoute section={section} />;
};

export default WebMasterSettingsPage;
