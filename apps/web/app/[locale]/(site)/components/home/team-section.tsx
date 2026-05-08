import Image from "next/image";

const rolePanels = [
  {
    title: "Product",
    description:
      "Define requirements that stay attached to execution, not scattered across docs and threads. Collaborate on implementation plans before code is written. Ship bug fixes and small features without consuming engineering sprints. See progress in real time with no status meetings required.",
    image: {
      src: "/illustrations/illustration-product.png",
      alt: "Compass illustration representing product direction",
    },
  },
  {
    title: "Design",
    description:
      "Skip dev handoff and ship visual improvements directly. Prototype new screens and features inside existing functional apps, polish and refine what engineering delivers, and edit components directly to enforce design system consistency.",
    image: {
      src: "/illustrations/illustration-design.png",
      alt: "Illustration representing design",
    },
  },
  {
    title: "Engineering",
    description:
      "Build from structured, team-reviewed implementation plans and run multiple agent workflows in parallel with shared context. Manage agent context, not just within produced artifacts like PRDs but also across them. Maintain quality through visible execution and receiving reviews from agents and teammates before merging.",
    image: {
      src: "/illustrations/illustration-engineering.png",
      alt: "Illustration representing engineering",
    },
  },
];

export const TeamSection = () => {
  return (
    <section className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10 md:py-24">
      <div className="max-w-3xl">
        <h2 className="text-balance font-semibold text-4xl tracking-tight md:text-5xl">
          <span className="text-primary">One system.</span> Requirements, plans,
          code, and validation, all shared across your team and agents.
        </h2>
      </div>
      <div className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3">
        {rolePanels.map(({ description, image, title }) => (
          <div className="flex flex-col gap-6" key={title}>
            <div className="relative h-64 overflow-hidden">
              <Image
                alt={image.alt}
                className="object-contain"
                fill
                sizes="(min-width: 768px) 33vw, 100vw"
                src={image.src}
              />
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold text-lg">{title}</h3>
              <p className="text-muted-foreground">{description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
