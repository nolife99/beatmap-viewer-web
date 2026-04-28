import { ViteDevServer } from 'vite';

const isProduction = 
	!!Deno.env.get('DENO_DEPLOYMENT_ID') || 
	Deno.env.get('NODE_ENV') === 'production';

const htmlTemplate = isProduction
	? await Deno.readTextFile('dist/index.html').catch(() => '')
	: '';

let vite: ViteDevServer | undefined;
if (!isProduction) {
	const { createServer } = await import('vite');
	vite = await createServer({ appType: 'custom' });
	await vite.listen();
}

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Embedder-Policy': 'require-corp'
};

async function handleDownload(req: Request): Promise<Response> {
	try {
		const body = await req.json();

		if (!body || typeof body.url !== 'string') {
			return new Response('Invalid or missing URL', { status: 400 });
		}

		const response = await fetch(body.url);
		if (!response.ok) {
			return new Response(
				`Failed to fetch: ${response.status} ${response.statusText}`,
				{ status: 500 }
			);
		}

		return new Response(response.body);
	} catch {
		return new Response('Internal Server Error', { status: 500 });
	}
}

const port = Number(Deno.env.get('PORT') ?? 5000);

Deno.serve({
	port,
	hostname: '0.0.0.0'
}, async (req) => {
	const url = new URL(req.url);

	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	if (req.method === 'POST' && url.pathname === '/api/download') {
		const response = await handleDownload(req);

		for (const [key, value] of Object.entries(corsHeaders)) {
			response.headers.set(key, value);
		}
		return response;
	}

	if (req.method === 'GET' && url.pathname === '/') {
		const beatmapId = url.searchParams.getAll('b');
		let data: {
			artist: string;
			title: string;
			cover: string;
			creator: string;
			difficulty: string;
		} | undefined;

		if (beatmapId.length > 0) {
			try {
				const res = await fetch(`https://api.try-z.net/b/${beatmapId[0]}`);
				if (res.ok) {
					const beatmapData = await res.json();
					data = {
						artist: beatmapData.beatmapset.artist,
						title: beatmapData.beatmapset.title,
						cover: beatmapData.beatmapset.covers['card@2x'],
						creator: beatmapData.beatmapset.creator,
						difficulty: beatmapData.version
					};
				}
			} catch {
				console.log('Cannot find beatmap');
			}
		}

		let template = htmlTemplate;
		if (!isProduction && vite) {
			const raw = await Deno.readTextFile('./index.html');
			template = await vite.transformIndexHtml(req.url, raw);
		}

		const metaTags = data
			? `
			<meta property="og:title" content="${data.artist} - ${data.title} | JoSu! - osu! Beatmap Viewer" />
			<meta name="twitter:title" content="${data.artist} - ${data.title} | JoSu! - osu! Beatmap Viewer" />
			<meta property="og:type" content="website" />
			<meta property="og:description" content="Difficulty: ${data.difficulty} - Mapset by ${data.creator}" />
			<meta name="twitter:description" content="Difficulty: ${data.difficulty} - Mapset by ${data.creator}" />
			<meta property="og:image" content="${data.cover}" />
			<meta name="twitter:image" content="${data.cover}" />
		`
			: `
			<meta property="og:title" content="JoSu! - osu! Beatmap Viewer" />
			<meta name="twitter:title" content="JoSu! - osu! Beatmap Viewer" />
			<meta property="og:type" content="website" />
			<meta property="og:description" content="osu! Beatmap Viewer on the Web" />
			<meta name="twitter:description" content="osu! Beatmap Viewer on the Web" />
			<meta property="og:image" content="https://fukutotojido.s-ul.eu/YuVf9ZAd" />
			<meta property="twitter:image" content="https://fukutotojido.s-ul.eu/YuVf9ZAd" />
		`;

		const html = template.replace('', metaTags);

		return new Response(html, {
			headers: {
				...corsHeaders,
				'Content-Type': 'text/html; charset=utf-8'
			}
		});
	}

	if (isProduction) {
		const path = url.pathname === '/' ? '/index.html' : url.pathname;
		try {
			const file = await Deno.open(`./dist${path}`, { read: true });
			return new Response(file.readable, { headers: corsHeaders });
		} catch {
			// File not found, fall through to 404
		}
	} else if (vite) {
		return fetch(
			`http://localhost:${vite.config.server.port}${url.pathname}${url.search}`,
			{
				method: req.method,
				headers: req.headers,
				body: req.body
			}
		);
	}

	return new Response('Not Found', { status: 404, headers: corsHeaders });
});
