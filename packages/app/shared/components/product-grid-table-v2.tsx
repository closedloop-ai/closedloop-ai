"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useResponsiveNarrowGridviewEnabled } from "@repo/app/shared/feature-flags/use-responsive-narrow-gridview";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  GridInteractionContract,
  useGridInteractionContractEnabled,
} from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridTableListSurface } from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import { TableFavoriteCell } from "@repo/design-system/components/ui/table-cell-primitives";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import {
  useMediaQuery,
  useViewportWidth,
} from "@repo/design-system/hooks/use-media-query";
import { splitGridTracks } from "@repo/design-system/lib/column-fold";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { GRID_TABLE_V2_FAVORITE_TRACK } from "@repo/design-system/lib/grid-table-v2-constants";
import { GRID_TABLE_V2_NARROW_VIEWPORT_QUERY } from "@repo/design-system/lib/grid-table-v2-responsive";
import type { GridTableV2Props } from "@repo/design-system/lib/grid-table-v2-types";
import { type ComponentProps, type ReactNode, useCallback } from "react";
import { PRODUCT_GRID_FAVORITE_COLUMN_LABEL } from "../lib/product-grid-favorites";
import {
  type ProductGridTableV2CardCompatibility,
  ProductGridTableV2CardCompatibilityBody,
} from "./product-grid-table-v2-card-compatibility";

/** Product favorite state and mutations supplied by each list's data owner. */
export type ProductGridFavoriteController<T> = {
  favoriteIds: ReadonlySet<string>;
  getArtifactId: (item: T) => string | undefined;
  getItemLabel: (item: T) => string;
  isUnavailable?: boolean;
  onChange: (item: T, favorited: boolean) => void;
  /** Artifact ids with a toggle in flight; their star refuses a second click. */
  pendingIds?: ReadonlySet<string>;
};

export type ProductGridTableV2Props<T> = Omit<
  GridTableV2Props<T>,
  "preserveMeasuredContainer"
> & {
  /** Captured-main cards used only while the rollout flag remains closed. */
  cardCompatibility?: ProductGridTableV2CardCompatibility<T>;
  favorite?: ProductGridFavoriteController<T>;
  interactionState?: GridInteractionState;
};

export type ProductGridTableV2SelectionProps<T> = Pick<
  ProductGridTableV2Props<T>,
  | "enableRowRangeDrag"
  | "isRowSelected"
  | "onRowClick"
  | "onRenderedItemsChange"
  | "onRowKeyboardNavigate"
  | "onRowRangeDrag"
  | "onRowSelectionToggle"
  | "onSelectAllRows"
> & {
  getCompatibilityCardSelectionLabel?: (item: T, selected: boolean) => string;
};

/**
 * Product rollout boundary for the shared grid. Flag-off is the wide layout
 * from main; flag-on allows explicit or viewport-resolved narrow projection.
 */
export function ProductGridTableV2<T>({
  cardCompatibility,
  favorite,
  interactionState,
  ...props
}: ProductGridTableV2Props<T>) {
  const responsiveNarrowEnabled = useResponsiveNarrowGridviewEnabled();
  const viewportWidth = useViewportWidth();
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const gridProps: GridTableV2Props<T> = {
    ...props,
    gridTemplateColumns: favorite
      ? withFavoriteTrack(props.gridTemplateColumns)
      : props.gridTemplateColumns,
    leadingUtilityLabel: favorite
      ? PRODUCT_GRID_FAVORITE_COLUMN_LABEL
      : props.leadingUtilityLabel,
    renderLeadingUtility: favorite
      ? (item, context) => (
          <>
            {renderProductGridFavoriteCell(
              favorite,
              item,
              context.isNarrowList
            )}
            {props.renderLeadingUtility?.(item, context)}
          </>
        )
      : props.renderLeadingUtility,
    renderLeadingUtilityInWide: favorite
      ? true
      : props.renderLeadingUtilityInWide,
  };
  if (responsiveNarrowEnabled && cardCompatibility?.alwaysActive !== true) {
    let mode = props.mode;
    if (
      (mode === undefined || mode === "auto") &&
      viewportWidth !== null &&
      viewportWidth < CARD_FALLBACK_BREAKPOINT
    ) {
      mode = "compact";
    }
    return (
      <ProductGridInteractionContract state={interactionState}>
        <GridTableV2<T>
          {...gridProps}
          mode={mode}
          preserveMeasuredContainer={
            props.mode === undefined || props.mode === "auto"
          }
        />
      </ProductGridInteractionContract>
    );
  }
  if (!cardCompatibility) {
    return (
      <ProductGridInteractionContract state={interactionState}>
        <GridTableV2<T> {...gridProps} mode="expanded" />
      </ProductGridInteractionContract>
    );
  }
  const showCards =
    props.mode === "compact" ||
    (props.mode !== "expanded" && width < CARD_FALLBACK_BREAKPOINT);
  return (
    <ProductGridInteractionContract state={interactionState}>
      <div className="w-full" ref={ref}>
        {showCards ? (
          <ProductGridTableV2CardCompatibilityBody
            compatibility={cardCompatibility}
            props={props}
            renderFavorite={
              favorite
                ? // The fixed-size wrapper: the bare cell fills its parent, which in
                  // a card header's flex row squeezed the title.
                  (item) => renderProductGridFavoriteCell(favorite, item, true)
                : undefined
            }
          />
        ) : (
          <GridTableV2<T> {...gridProps} mode="expanded" />
        )}
      </div>
    </ProductGridInteractionContract>
  );
}

/** Resolves the list's mode from its bounded table band, with no extra wrapper. */
export function ProductGridTableListSurface(
  props: ComponentProps<typeof GridTableListSurface>
) {
  const responsiveNarrowEnabled = useResponsiveNarrowGridviewEnabled();
  const { measured, ref, width } = useContainerWidth<HTMLElement>();
  const isNarrowViewport = useMediaQuery(GRID_TABLE_V2_NARROW_VIEWPORT_QUERY);
  const tableScrollRef = useCallback(
    (node: HTMLElement | null) => {
      ref(node);
      props.tableScrollRef?.(node);
    },
    [props.tableScrollRef, ref]
  );
  const isCompact = responsiveNarrowEnabled
    ? isNarrowViewport
    : measured && width < CARD_FALLBACK_BREAKPOINT;
  const mode = props.mode ?? (isCompact ? "compact" : "expanded");
  return (
    <GridTableListSurface
      {...props}
      mode={mode}
      tableScrollRef={tableScrollRef}
    />
  );
}

/**
 * The shared adoption boundary for pointer and hover behavior. Under an
 * ancestor contract the marker is not repeated, but a state this grid was given
 * is still published on its own subtree, so a bare ancestor cannot swallow it.
 */
export function ProductGridInteractionContract({
  children,
  state,
}: {
  children: ReactNode;
  state?: GridInteractionState;
}) {
  const hasAncestorContract = useGridInteractionContractEnabled();
  const adoptionEnabled = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  if (hasAncestorContract) {
    return state === undefined ? (
      children
    ) : (
      <div
        aria-busy={state === GridInteractionState.Loading ? true : undefined}
        className="contents"
        data-interaction-state={state}
      >
        {children}
      </div>
    );
  }
  return adoptionEnabled ? (
    <GridInteractionContract state={state}>{children}</GridInteractionContract>
  ) : (
    children
  );
}

function renderProductGridFavoriteCell<T>(
  favorite: ProductGridFavoriteController<T>,
  item: T,
  isNarrowList = false
): ReactNode {
  const artifactId = favorite.getArtifactId(item);
  if (!artifactId || favorite.isUnavailable) {
    return;
  }
  const control = (
    <TableFavoriteCell
      disabled={favorite.pendingIds?.has(artifactId)}
      favorited={favorite.favoriteIds.has(artifactId)}
      itemLabel={favorite.getItemLabel(item)}
      onFavoriteChange={(favorited) => favorite.onChange(item, favorited)}
    />
  );
  return isNarrowList ? (
    <div className="h-11 w-9 shrink-0">{control}</div>
  ) : (
    control
  );
}

/**
 * The star's track belongs to the parent that renders the star (tamsinb
 * review on #9116). A host template that already leads with it keeps it once.
 */
function withFavoriteTrack(gridTemplateColumns: string): string {
  return splitGridTracks(gridTemplateColumns)[0] ===
    GRID_TABLE_V2_FAVORITE_TRACK
    ? gridTemplateColumns
    : `${GRID_TABLE_V2_FAVORITE_TRACK} ${gridTemplateColumns}`;
}
