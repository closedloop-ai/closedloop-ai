import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getImplementationPlanById } from "@/app/actions/implementation-plans";
import { ImplementationPlanEditor } from "./implementation-plan-editor";

type ImplementationPlanPageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: ImplementationPlanPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getImplementationPlanById(id);

  if (result.error || !result.data) {
    return { title: "Plan Not Found" };
  }

  return {
    title: result.data.title,
    description: `Implementation Plan: ${result.data.title}`,
  };
}

export default async function ImplementationPlanPage({ params }: ImplementationPlanPageProps) {
  const { id } = await params;
  const result = await getImplementationPlanById(id);

  if (result.error || !result.data) {
    notFound();
  }

  return <ImplementationPlanEditor plan={result.data} />;
}
