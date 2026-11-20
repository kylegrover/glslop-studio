import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// package.json is the one place the version lives (tauri.conf.json points at it too).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // probe.html is the hidden d3d11 cost probe window (src/probe.ts).
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', probe: 'probe.html' } } },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
