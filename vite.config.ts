import tailwindcss from "@tailwindcss/vite";
import { defineConfig, HmrOptions } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { viteSingleFile } from 'vite-plugin-singlefile'

const vitePort = 5173;

const isCodespace = !!Deno.env.get('CODESPACE_NAME');
const isReplit = !!Deno.env.get('REPL_ID');
const isCodeSandbox = !!Deno.env.get('CSB');

let hmrConfig: HmrOptions = {};

if (isCodespace) {
	hmrConfig = {
		host: `${Deno.env.get('CODESPACE_NAME')}-${vitePort}.${Deno.env.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN')}`,
		clientPort: 443,
		protocol: 'wss'
	};
} else if (isReplit || isCodeSandbox) {
	hmrConfig = {
		clientPort: 443,
		protocol: 'wss'
	};
} else {
	hmrConfig = {
		port: vitePort
	};
}

export default defineConfig({
	worker: {
		format: 'es',
		rollupOptions: {
			output: {
				codeSplitting: false,
			}
		}
	},
	plugins: [tailwindcss(), nodePolyfills(), viteSingleFile()],
	build: {
		target: "esnext",
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		rollupOptions: {
			output: {
				minifyInternalExports: true,
				codeSplitting: false,
			}
		}
	},
	optimizeDeps: {
		exclude: ["web-demuxer", "wavesurfer.js"],
	},
	preview: {
		allowedHosts: ["beatmap.try-z.net", "preview.tryz.id.vn"],
	},
	base: "",

	server: {
		host: "0.0.0.0",
		port: vitePort,
		allowedHosts: true,
		cors: {
			origin: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: true,
			maxAge: 86400
		},
		watch: {
			usePolling: false
		},
		hmr: hmrConfig
	},
});