import { DataControlsPrototypeDemo } from "@repo/app/settings/components/data-controls-prototype-demo";
import {
  PLACEHOLDER_DATA_CONTROLS_COPY,
  PRD_796_FLOW_TITLES,
  SCENARIO_PANEL_COPY,
} from "@repo/app/settings/components/data-controls-prototype-fixtures";

// `?flow=scope|policy|share|delete` links straight to one PRD-796 flow.
const DataControlsPrototypePage = async ({
  searchParams,
}: {
  searchParams: Promise<{ flow?: string }>;
}) => {
  const { flow } = await searchParams;

  return (
    <main>
      <DataControlsPrototypeDemo
        copy={PLACEHOLDER_DATA_CONTROLS_COPY}
        flowTitles={PRD_796_FLOW_TITLES}
        panelCopy={SCENARIO_PANEL_COPY}
        requestedFlow={flow}
      />
    </main>
  );
};

export default DataControlsPrototypePage;
