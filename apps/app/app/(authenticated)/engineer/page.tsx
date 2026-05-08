import type { Metadata } from "next";
import { EngineerGuard } from "./engineer-guard";

export const metadata: Metadata = {
  title: "Engineer View",
  description: "AI-assisted development workspace",
};

export default function EngineerPage() {
  return <EngineerGuard />;
}
