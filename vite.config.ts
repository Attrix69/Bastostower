import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge/rapier3d')) return 'rapier';
          if (id.includes('node_modules/postprocessing')) return 'post';
          return undefined;
        },
      },
    },
  },
  server: { host: true },
});
