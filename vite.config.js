import { resolve } from "path";

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
