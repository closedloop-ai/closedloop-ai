import { Header } from "@/app/(authenticated)/components/header";
import { getOrganizations } from "@/app/actions/organizations";

export default async function OrganizationPage() {
  const result = await getOrganizations();

  const renderContent = () => {
    if (!result.success) {
      return (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
          {result.error}
        </div>
      );
    }

    if (result.data.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
          <h3 className="mb-2 font-semibold text-lg">No organization found</h3>
          <p className="mb-4 text-muted-foreground text-sm">
            Set up your organization to get started
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {result.data.map((org) => (
          <div className="rounded-lg border p-4" key={org.id}>
            <h3 className="font-medium">{org.name}</h3>
            <p className="text-muted-foreground text-sm">Slug: {org.slug}</p>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <Header page="Organization" pages={["Organization"]} />
      <main className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-2xl">Organization</h1>
            <p className="text-muted-foreground">
              Manage your organization settings
            </p>
          </div>
        </div>
        {renderContent()}
      </main>
    </>
  );
}
