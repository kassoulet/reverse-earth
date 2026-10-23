import { defineConfig } from "vite";

/**
 * GitHub Pages project sites live under /<repository>/. The deploy workflow sets
 * VITE_BASE to that value; local development and user/org sites use "/".
 */
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,
  },
});
