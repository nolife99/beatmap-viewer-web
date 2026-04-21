import { serveDir } from "@std/http/file-server";

Deno.serve(async (req) => {
	const response = await serveDir(req, {
		fsRoot: "./dist",
		showDirListing: false,
	});

	if (response.status === 404) {
		try {
			const fallback = await Deno.open("./dist/index.html", { read: true });
			return new Response(fallback.readable, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		} catch {
			return new Response("Not Found", { status: 404 });
		}
	}

	return response;
});