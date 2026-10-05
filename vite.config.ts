import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // physics (big WASM blob) and the rendering libs are cached separately from game code
          if (id.includes('@dimforge/rapier3d')) return 'rapier';
          if (id.includes('node_modules/three') || id.includes('node_modules/postprocessing')) return 'render';
          return undefined;
        },
      },
    },
  },
  server: { host: true },
});
