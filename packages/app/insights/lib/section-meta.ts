import { InsightsSection } from "@repo/api/src/types/insights";

export type SectionMeta = {
  title: string;
  blurb: string;
};

export const SECTION_META: Record<InsightsSection, SectionMeta> = {
  [InsightsSection.Delivery]: {
    title: "Delivery & Efficiency",
    blurb: "What's shipping and what it costs — output and unit economics.",
  },
  [InsightsSection.Utilization]: {
    title: "Utilization",
    blurb: "How busy people and agents are, and whether there's headroom.",
  },
  [InsightsSection.Agents]: {
    title: "Agents & Tools",
    blurb: "Which models and tools are used, and how much they consume.",
  },
};
