import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" keeps asset paths relative so it works locally and on GitHub Pages.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
