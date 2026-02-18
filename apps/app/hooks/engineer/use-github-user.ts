import { useQuery } from "@tanstack/react-query";

export function useGitHubUser() {
  const { data, isLoading } = useQuery<{ login: string }>({
    queryKey: ["github-user"],
    queryFn: async () => {
      const response = await fetch("/api/engineer/git/user");
      if (!response.ok) {
        throw new Error("Failed to fetch GitHub user");
      }
      return response.json();
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  return { login: data?.login ?? null, isLoading };
}
