import { vi } from "vitest";

export const useFavoriteArtifacts = () => ({ data: [], isLoading: false });
export const useIsFavoriteArtifact = () => false;
export const useToggleFavoriteArtifact = (): {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
} => ({
  mutate: vi.fn(),
  isPending: false,
});
