import tailwindcss from '@tailwindcss/vite';
import { Buffer } from "node:buffer";
import { defineConfig, HmrOptions } from 'vite';
import crossOriginIsolation from 'vite-plugin-cross-origin-isolation';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import RemoteAssets from 'vite-plugin-remote-assets';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { rolldown } from "rolldown";

const vitePort = 5173;

const isCodespace = !!Deno.env.get('CODESPACE_NAME');
const isReplit = !!Deno.env.get('REPL_ID');
const isCodeSandbox = !!Deno.env.get('CSB');

let hmrConfig: HmrOptions;

if (isCodespace) {
	hmrConfig = {
		host: `${Deno.env.get('CODESPACE_NAME')}-${vitePort}.${Deno.env.get(
			'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN'
		)}`,
		clientPort: 443,
		protocol: 'wss',
	};
} else if (isReplit || isCodeSandbox) {
	hmrConfig = {
		clientPort: 443,
		protocol: 'wss',
	};
} else {
	hmrConfig = {
		port: vitePort,
	};
}

export default defineConfig({
	worker: {
		rolldownOptions: {
			output: {
				codeSplitting: false,
			},
		},
	},
	plugins: [
		tailwindcss({
			optimize: {
				minify: true
			}
		}),
		nodePolyfills(),
		{
			name: 'inline-audio-worklet-b64',
			enforce: 'pre',
	
			async load(id) {
				if (!id.includes('?worklet-inline')) return null;
	
				const file = id.replace('?worklet-inline', '');
	
				const bundle = await rolldown({
					input: file,
				});
	
				const { output } = await bundle.generate({
					codeSplitting: false,
					format: 'iife',
					minify: true,
				});
	
				const code = output[0].code;
				const b64 = Buffer.from(code, 'utf-8').toString('base64');
	
				return `export default "data:text/javascript;base64,${b64}";`;
			}
		},
		RemoteAssets(),
		viteSingleFile(),
		crossOriginIsolation(),
		{
			name: 'remove-eruda',
			transformIndexHtml(html) {
				if (Deno.env.get('NODE_ENV') !== 'production') {
					return [
						{
							tag: 'script',
							attrs: { src: '//cdn.jsdelivr.net/npm/eruda' },
							injectTo: 'body',
						},
						{
							tag: 'script',
							children: 'eruda.init();',
							injectTo: 'body',
						},
					];
				}
				return html;
			},
		},
	],
	build: {
		target: 'es2020',
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		rolldownOptions: {
			output: {
				minifyInternalExports: true,
				codeSplitting: false,
			},
		},
	},
	optimizeDeps: {
		exclude: ['web-demuxer', 'wavesurfer.js'],
	},
	preview: {
		allowedHosts: ['beatmap.try-z.net', 'preview.tryz.id.vn', '.csb.app'],
	},
	base: '',

	server: {
		host: '0.0.0.0',
		port: vitePort,
		allowedHosts: true,
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
		cors: {
			origin: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: true,
			maxAge: 86400,
		},
		watch: {
			usePolling: false,
		},
		hmr: hmrConfig,
	},
});
