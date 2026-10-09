import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // MapLibre (~800 kB) and the Firebase SDK dominate the bundle; split them
    // into separate long-cacheable vendor chunks.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl/ },
            { name: 'firebase', test: /node_modules[\\/](@firebase|firebase)/ },
          ],
        },
      },
    },
  },
});
