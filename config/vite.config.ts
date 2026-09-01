import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dependencies that change on their own schedule, kept out of the app chunk.
 *
 * One 227 KB bundle meant every edit to a line of application code invalidated
 * the whole download -- 13 fetches on the local page and 8 across the tunnel in
 * a measured day, all of them re-fetching an unchanged React and xterm. Split
 * this way, an ordinary change invalidates only the app chunk and the rest
 * stays in cache. It does not reduce a cold load; it stops warm ones repeating.
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("@xterm")) return "xterm";
  // The unified stack, which markdown-view.tsx also loads on demand. Naming it
  // here keeps it one chunk rather than whatever the dynamic import carves out.
  if (/react-markdown|remark|rehype|micromark|mdast|hast|unist|unified|vfile|property-information|space-separated|comma-separated|character-entities|decode-named|bail|trough|devlop|zwitch|longest-streak|ccount|markdown-table|escape-string-regexp|is-plain-obj|estree|html-url-attributes/.test(id)) return "markdown";
  if (id.includes("react-dom") || /node_modules[\\/]react[\\/]/.test(id) || id.includes("scheduler")) return "react";
  return "vendor";
}

export default defineConfig({
  root: process.cwd(),
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
});
