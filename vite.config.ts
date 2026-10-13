import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "client",
  resolve: { alias: { "@shared": path.resolve(__dirname, "shared") } },
  css: { postcss: { plugins: [tailwindcss({ config: path.resolve(__dirname, "tailwind.config.js") }), autoprefixer()] } },
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 5173, host: "0.0.0.0", proxy: { "/api": "http://localhost:5000" } },
});
