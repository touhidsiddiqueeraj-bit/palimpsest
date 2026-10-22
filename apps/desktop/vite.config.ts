import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // Split the 778 kB single bundle (263 kB gzip) into parallel-loadable
    // chunks: the editor's own code stays small while CodeMirror / React /
    // icons load as stable vendor chunks.
    // chunkSizeWarningLimit: the isolated codemirror vendor chunk is one
    // cohesive library loaded once — splitting it further would only add
    // request overhead in the Tauri webview.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'codemirror', test: /node_modules\/(?:@codemirror|@lezer|@marijn)[-\\/]/ },
            { name: 'react', test: /node_modules\/(?:react|react-dom|scheduler)[-\\/]/ },
            { name: 'icons', test: /node_modules\/lucide-react[-\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
