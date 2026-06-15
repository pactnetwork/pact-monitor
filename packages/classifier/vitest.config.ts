import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The parity test imports the real consumer sources (wrap, monitor) by relative
// path so it can guard their behavior WITHOUT declaring them as package
// dependencies (that would create a classifier <-> wrap dependency cycle and
// break `turbo build`). Those sources import "@pact-network/classifier"; alias
// the bare specifier to this package's source so it resolves without a build.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@pact-network\/classifier$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
    ],
  },
});
