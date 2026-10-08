import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained dist/index.html: no external requests, works from file:// and from any
// static server or base path.
export default defineConfig({
  base: "./",
  publicDir: "sql",
  plugins: [viteSingleFile()],
  build: { target: "es2022", cssMinify: true, reportCompressedSize: false },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
