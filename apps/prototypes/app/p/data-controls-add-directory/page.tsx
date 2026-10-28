"use client";

import { DirectoryScopeListWithAddDemo } from "@repo/app/shared/components/directory-scope-list-with-add-demo";
import { mockProps } from "./mock";

const DataControlsAddDirectoryPrototypePage = () => (
  <main>
    <DirectoryScopeListWithAddDemo {...mockProps} />
  </main>
);

export default DataControlsAddDirectoryPrototypePage;
