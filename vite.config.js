import { resolve } from "path";

// Multi-page build: the default `{}` config only ever bundled index.html
// (Vite's implicit single-page default). The dev server serves any .html file
// at the repo root automatically with no config, but `vite build` needs every
// entry listed explicitly or inspect.html silently drops out of dist/.
export default {
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        inspect: resolve(import.meta.dirname, "inspect.html"),
      },
    },
  },
};
