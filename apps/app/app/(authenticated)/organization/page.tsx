import { Header } from "@/app/(authenticated)/components/header";
import { OrganizationList } from "./components/organization-list";

export default function OrganizationPage() {
  return (
    <>
      <Header breadcrumbs={[{ label: "Organization" }]} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-2xl">Organization</h1>
            <p className="text-muted-foreground">
              Manage your organization settings
            </p>
          </div>
        </div>
        <OrganizationList />
      </main>
    </>
  );
}
