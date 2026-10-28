import { seedInboxNotifications } from "../core/base-seed-inbox";
import { seedArchivedProject } from "../domain/archived-project";
import { seedCatalogPacks } from "../domain/catalog-packs";
import { seedCustomFieldReferences } from "../domain/custom-field-references";
import { seedDistributions } from "../domain/distributions";
import { seedDocumentActivity } from "../domain/document-activity";
import { seedFavorites } from "../domain/favorites";
import { seedGridPreferences } from "../domain/grid-preferences";
import { seedOrgDocuments } from "../domain/org-documents";
import { seedTags } from "../domain/tags";
import type { VibeSeedStage } from "../stage";

/**
 * Web-only domain rows. Most fill models the base seed leaves empty; the
 * first two only add rows to models the base seed owns (their coverage files
 * name `base-seed`), so they claim none.
 */
export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "org-documents",
    models: [],
    run: seedOrgDocuments,
  },
  {
    name: "archived-project",
    models: [],
    run: seedArchivedProject,
  },
  {
    name: "document-activity",
    models: ["ArtifactActivityEvent"],
    run: seedDocumentActivity,
  },
  {
    name: "inbox-notifications",
    models: [],
    run: seedInboxNotifications,
  },
  {
    name: "tags",
    models: ["Tag", "TagArtifact", "TagProject"],
    run: seedTags,
  },
  {
    name: "favorites",
    models: ["FavoriteArtifact", "FavoriteProject"],
    run: seedFavorites,
  },
  {
    name: "grid-preferences",
    models: ["GridPreference"],
    run: seedGridPreferences,
  },
  {
    name: "custom-field-references",
    models: ["CustomFieldValueReference"],
    run: seedCustomFieldReferences,
  },
  {
    name: "catalog-packs",
    models: [
      "CatalogItemVersion",
      "Distribution",
      "DistributionTargetingEntry",
      "DistributionTargetStatus",
    ],
    run: async (context) => {
      await seedDistributions(context, await seedCatalogPacks(context));
    },
  },
];
