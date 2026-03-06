import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    proxy: {
      // LangGraph API через ui_proxy
      "/api": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
      },
      // Настройки/модели через ui_proxy
      "/ui": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
});
