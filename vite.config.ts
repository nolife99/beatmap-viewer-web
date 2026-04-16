import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
        plugins: [tailwindcss(), nodePolyfills()],
        build: {
                target: "esnext", //browsers can handle the latest ES features
        },
        optimizeDeps: {
                esbuildOptions: {
                        target: "esnext",
                },
                exclude: ["web-demuxer", "wavesurfer.js"],
        },
        resolve: {
                alias: {
                        "@": path.resolve(__dirname, "./src/app"),
                        "wavesurfer.js/dist/plugins/spectrogram-worker.js":
                                path.resolve(
                                        __dirname,
                                        "node_modules/wavesurfer.js/dist/plugins/spectrogram-worker.js"
                                )
                },
        },
        preview: {
                allowedHosts: ["beatmap.try-z.net", "previe.tryz.id.vn"],
        },
        base: "",
        server: {
                host: "0.0.0.0",
                port: 5000,
                allowedHosts: true,
                hmr: {
                        port: 24678,
                },
                cors: {
                        origin: true,
                        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                allowedHeaders: ['Content-Type', 'Authorization'],
                credentials: true,
                maxAge: 86400
                },
                watch: {
                        usePolling: true,
                }
        },
});
