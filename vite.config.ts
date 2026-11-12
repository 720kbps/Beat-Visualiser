import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  // Settings recommended by Tauri: https://v2.tauri.app/start/frontend/vite/
  // Keep Rust compiler errors visible in the terminal
  clearScreen: false,
  server: {
    // Tauri loads http://localhost:5173 (devUrl in tauri.conf.json), so fail instead of picking another port
    port: 5173,
    strictPort: true,
    watch: {
      // Don't reload the page when Rust files change
      ignored: ['**/src-tauri/**'],
    },
  },
})
