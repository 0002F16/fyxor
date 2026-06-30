import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served under https://fyxor.eu/admin by the API's express.static, so asset URLs
// must be prefixed with /admin/. The dev server runs at the root for convenience.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/admin/" : "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5174
  }
}));
