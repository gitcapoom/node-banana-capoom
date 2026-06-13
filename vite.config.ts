import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone Vite build of the Gaussian Splat Viewer.
// The shared source lives in src/ and is also consumed by node-banana
// via git subtree, so it must use only relative + npm imports (no @/ or next/).
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
