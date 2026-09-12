import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local dev convenience: the browser talks to the Vite dev server on
      // its own port, and this proxies WebSocket upgrades through to the
      // real sync server so no VITE_WS_URL override is needed locally.
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
