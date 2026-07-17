import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built output (dist/) is served by the FastAPI backend on the box. During dev, proxy /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
