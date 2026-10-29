"use strict";
module.exports = function trustedLabelLoader(source) {
  const done = this.async();
  import("./trusted-label-transform.mjs")
    .then(({ transformTrustedLabels }) => {
      const result = transformTrustedLabels(
        source,
        this.resourcePath,
        this.getOptions()
      );
      for (const dependency of result.dependencies) {
        this.addDependency(dependency);
      }
      done(null, result.code);
    })
    .catch(done);
};
