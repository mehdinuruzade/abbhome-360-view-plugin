import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The static site: landing page, example host page and editor. `base: './'` keeps every URL
// relative so the build works from any folder (GitHub Pages, a CDN path, a local file server).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        index: page('./index.html'),
        demo: page('./demo/index.html'),
        editor: page('./editor/index.html'),
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },
});
