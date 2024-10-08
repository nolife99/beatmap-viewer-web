import fs from "fs";
import { defineConfig, loadEnv } from "vite";

// vite.config.js
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverSettings = {};

  return {
    ...serverSettings, // <-- Add here!
    optimizeDeps: {
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
  };
});
