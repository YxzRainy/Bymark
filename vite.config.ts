import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from 'node:url';
import { sharedStoragePlugin } from './scripts/shared-storage.mjs';

export default defineConfig({
  plugins: [vue(), vueJsx(), tailwindcss(), sharedStoragePlugin(fileURLToPath(new URL('.', import.meta.url)))],
  server: {
    // Development instances on any port use the same project-local store.
    port: 5174,
  },
});
