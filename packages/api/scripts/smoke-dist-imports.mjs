const distImports = [
  "../dist/github-read-model.js",
  "../dist/github-checks-status.js",
];

await Promise.all(distImports.map((modulePath) => import(modulePath)));
