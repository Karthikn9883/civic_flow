import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: '../',  // Load .env from project root (parent directory)
  envPrefix: 'VITE_',  // Only expose VITE_* variables to the browser
  server: {
    port: 5173,
    host: true,
  },
});
