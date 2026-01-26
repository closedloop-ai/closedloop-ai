import { Header } from "@/app/(authenticated)/components/header";
import { ProjectsList } from "./components/projects-list";

export default function ProjectsPage() {
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
        <ProjectsList />
      </main>
    </>
  );
}
