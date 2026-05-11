const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp"
};

const htmlTemplate = await Deno.readTextFile("./index.html");

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function getContentType(path: string): string {
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".wasm")) return "application/wasm";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	if (path.endsWith(".webp")) return "image/webp";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".woff")) return "font/woff";
	if (path.endsWith(".woff2")) return "font/woff2";
	if (path.endsWith(".ttf")) return "font/ttf";
	if (path.endsWith(".ogg")) return "audio/ogg";
	if (path.endsWith(".mp3")) return "audio/mpeg";
	if (path.endsWith(".wav")) return "audio/wav";

	return "application/octet-stream";
}

function withHeaders(response: Response): Response {
	for (const [key, value] of Object.entries(corsHeaders)) {
		response.headers.set(key, value);
	}

	return response;
}

async function handleDownload(req: Request): Promise<Response> {
	try {
		const body = await req.json();

		if (!body || typeof body.url !== "string") {
			return new Response("Invalid or missing URL", { status: 400 });
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
		return new Response("Internal Server Error", { status: 500 });
	}
}

async function getMetaTags(url: URL): Promise<string> {
	const beatmapId = url.searchParams.getAll("b");

	if (beatmapId.length > 0) {
		try {
			const res = await fetch(`https://api.try-z.net/b/${beatmapId[0]}`);

			if (res.ok) {
				const beatmapData = await res.json();

				const artist = escapeHtml(beatmapData.beatmapset.artist);
				const title = escapeHtml(beatmapData.beatmapset.title);
				const cover = escapeHtml(beatmapData.beatmapset.covers["card@2x"]);
				const creator = escapeHtml(beatmapData.beatmapset.creator);
				const difficulty = escapeHtml(beatmapData.version);

				return `
					<meta property="og:title" content="${artist} - ${title} | JoSu! - osu! Beatmap Viewer" />
					<meta name="twitter:title" content="${artist} - ${title} | JoSu! - osu! Beatmap Viewer" />
					<meta property="og:type" content="website" />
					<meta property="og:description" content="Difficulty: ${difficulty} - Mapset by ${creator}" />
					<meta name="twitter:description" content="Difficulty: ${difficulty} - Mapset by ${creator}" />
					<meta property="og:image" content="${cover}" />
					<meta name="twitter:image" content="${cover}" />
				`;
			}
		} catch {
			console.log("Cannot find beatmap");
		}
	}

	return `
		<meta property="og:title" content="JoSu! - osu! Beatmap Viewer" />
		<meta name="twitter:title" content="JoSu! - osu! Beatmap Viewer" />
		<meta property="og:type" content="website" />
		<meta property="og:description" content="osu! Beatmap Viewer on the Web" />
		<meta name="twitter:description" content="osu! Beatmap Viewer on the Web" />
		<meta property="og:image" content="https://fukutotojido.s-ul.eu/YuVf9ZAd" />
		<meta name="twitter:image" content="https://fukutotojido.s-ul.eu/YuVf9ZAd" />
	`;
}

async function serveStatic(pathname: string): Promise<Response | undefined> {
	const cleanPath = decodeURIComponent(pathname);

	if (cleanPath.includes("..")) {
		return new Response("Bad Request", {
			status: 400,
			headers: corsHeaders
		});
	}

	const filePath = cleanPath === "/" ? "./index.html" : `.${cleanPath}`;

	try {
		const file = await Deno.open(filePath, { read: true });

		return new Response(file.readable, {
			headers: {
				...corsHeaders,
				"Content-Type": getContentType(filePath)
			}
		});
	} catch {
		return undefined;
	}
}

const port = Number(Deno.env.get("PORT") ?? 5000);

Deno.serve(
	{
		port,
		hostname: "0.0.0.0"
	},
	async (req) => {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		if (req.method === "POST" && url.pathname === "/api/download") {
			return withHeaders(await handleDownload(req));
		}

		if (req.method === "GET" && url.pathname === "/") {
			const metaTags = await getMetaTags(url);
			const html = htmlTemplate.replace("</head>", `${metaTags}</head>`);

			return new Response(html, {
				headers: {
					...corsHeaders,
					"Content-Type": "text/html; charset=utf-8"
				}
			});
		}

		if (req.method === "GET" || req.method === "HEAD") {
			const response = await serveStatic(url.pathname);

			if (response) {
				return response;
			}
		}

		return new Response("Not Found", {
			status: 404,
			headers: corsHeaders
		});
	}
);