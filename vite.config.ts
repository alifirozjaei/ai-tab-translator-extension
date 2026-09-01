import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        settings: 'src/settings/index.html',
        offscreen: 'src/offscreen/index.html',
        'audio-processor': 'src/audio/processor.ts',
        'live-processors': 'src/audio/live-processors.ts',
        'service-worker': 'src/background/service-worker.ts',
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'audio-processor') return 'audio-processor.js';
          if (chunk.name === 'live-processors') return 'live-processors.js';
          if (chunk.name === 'service-worker') return 'service-worker.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
