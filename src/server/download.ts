import { Elysia, t } from 'elysia';

const download = new Elysia().post(
	'/api/download',
	async ({ body: { url } }) => {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
		}

		return new Response(response.body);
	},
	{
		body: t.Object({
			url: t.String()
		})
	}
);

export default download;