import path from "path"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // Explicit, not just "happens to default to false" — a production
    // build must not ship source maps for a public deployment (they'd
    // let anyone reconstruct readable original source, including any
    // comments, from the minified bundle). See docs/architecture.md,
    // "Frontend production audit."
    sourcemap: false,
  },
})
