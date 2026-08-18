import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FlaskConical } from "lucide-react";
import Image from "next/image";
import { brandMarkSrc } from "@/lib/brand-mark";
import { prototypes } from "@/lib/registry.generated";
import { PrototypeGallery } from "./prototype-gallery";

const PrototypesIndexPage = () => (
  <main className="mx-auto max-w-5xl px-6 py-10">
    <header className="mb-8">
      <div className="flex items-center gap-3">
        <Image
          alt=""
          className="size-6"
          height={24}
          src={brandMarkSrc}
          width={24}
        />
        <h1 className="font-semibold text-2xl tracking-tight">
          Closedloop Prototypes
        </h1>
      </div>
      <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
        An ideation sandbox built on the real design system. Everything here
        renders mock data only: no database, no auth, no API. Prototypes are
        working references for features that will be built properly in the main
        app.
      </p>
    </header>
    {prototypes.length > 0 ? (
      <PrototypeGallery />
    ) : (
      <EmptyState
        description="Scaffold one with the /prototype skill from Claude Code."
        icon={FlaskConical}
        title="No prototypes yet"
      />
    )}
  </main>
);

export default PrototypesIndexPage;
