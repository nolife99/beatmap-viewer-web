import { AsyncUnzipInflate, Unzip } from 'fflate';

export type Resource = Blob | undefined;

async function extract(zipFile: Blob): Promise<Map<string, Resource>> {
	const resources = new Map<string, Resource>();
	const pending: Promise<void>[] = [];

	const unzip = new Unzip((file) => {
		if (file.name.endsWith('/')) return;

		const chunks: Uint8Array<ArrayBuffer>[] = [];

		pending.push(
			new Promise<void>((resolve, reject) => {
				file.ondata = (err, data, final) => {
					if (err) {
						reject(err);
						return;
					}

					if (data.length) chunks.push(data as Uint8Array<ArrayBuffer>);

					if (final) {
						resources.set(file.name.toLowerCase(), new Blob(chunks));
						resolve();
					}
				};

				file.start();
			})
		);
	});

	unzip.register(AsyncUnzipInflate);

	const reader = zipFile.stream().getReader();

	try {
		while (true) {
			const { value, done } = await reader.read();

			if (done) {
				unzip.push(new Uint8Array(0), true);
				break;
			}

			unzip.push(value, false);
		}

		await Promise.all(pending);
		return resources;
	} finally {
		reader.releaseLock();
	}
}

const ZipHandler = {
	extract
};

export default ZipHandler;