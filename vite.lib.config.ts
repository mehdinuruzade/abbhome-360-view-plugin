import { defineConfig } from 'vite';

// The embeddable widget: one self-contained ES module and one classic-script (IIFE) bundle that
// exposes `window.AbbBuilding360`. three and Lit are bundled in, so a host page needs nothing else.
export default defineConfig({
  publicDir: false,
  // Library mode leaves `process.env.NODE_ENV` untouched; browsers have no `process`.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    lib: {
      entry: 'src/widget/index.ts',
      name: 'AbbBuilding360',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'abb-building-360.js' : 'abb-building-360.iife.js'),
    },
  },
});
