import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/]react(-dom)?/ },
            { name: "vendor-motion", test: /node_modules[\\/](gsap|lenis)/ },
            { name: "vendor-icons", test: /node_modules[\\/]@phosphor-icons/ },
          ],
        },
      },
    },
  },
});
