export type { ReposResponse } from "@/lib/git/repos";
export { reposOptions } from "@/lib/git/repos";

/* ---------- Mutation helpers ---------- */

export async function addRepo(path: string) {
  const response = await fetch("/api/engineer/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to add repository");
  }
  return data;
}

export async function removeRepo(path: string) {
  const response = await fetch(
    `/api/engineer/repos?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to remove repository");
  }
  return data;
}

export async function updateRepoSettings(settings: {
  worktreeParentDir?: string;
  worktreeParentDirConfirmed?: boolean;
}) {
  const response = await fetch("/api/engineer/repos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to update settings");
  }
  return data;
}
