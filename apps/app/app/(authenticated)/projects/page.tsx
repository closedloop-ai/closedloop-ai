import { Header } from "@/app/(authenticated)/components/header";
import { getProjects } from "@/app/actions/projects";

export default async function ProjectsPage() {
  const result = await getProjects();

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
          <h3 className="mb-2 font-semibold text-lg">No projects yet</h3>
          <p className="mb-4 text-muted-foreground text-sm">
            Create your first project to get started
          </p>
        </div>
      );
    }

    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {result.data.map((project) => (
          <div className="rounded-lg border p-4" key={project.id}>
            <h3 className="font-medium">{project.name}</h3>
            {project.description ? (
              <p className="mt-1 text-muted-foreground text-sm">
                {project.description}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <Header page="Projects" pages={["Projects"]} />
      <main className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-2xl">Projects</h1>
            <p className="text-muted-foreground">
              Manage your projects and repositories
            </p>
          </div>
        </div>
        {renderContent()}
      </main>
    </>
  );
}
