import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';

// Tauri injects TAURI_DEV_HOST in dev to expose the Vite dev server.
const host = process.env.TAURI_DEV_HOST;

const server: Record<string, unknown> = {
  port: 1420,
  strictPort: true,
  host: host ?? false,
  watch: {
    ignored: ['**/src-tauri/**'],
  },
};

if (host) {
  server.hmr = {
    protocol: 'ws',
    host,
    port: 1421,
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port and fails if it's not available.
  clearScreen: false,
  server,
});
