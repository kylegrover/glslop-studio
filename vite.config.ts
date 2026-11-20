import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// package.json is the one place the version lives (tauri.conf.json points at it too).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [svelte()],
  // Use the workspace packages' TypeScript source directly (no package build needed while developing).
  resolve: { conditions: ['glslop-source', 'module', 'browser', 'development|production', 'svelte'] },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // probe.html: hidden d3d11 cost probe (src/probe.ts). publish.html: the publish confirmation (src/publish.ts).
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', probe: 'probe.html', publish: 'publish.html' } } },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
