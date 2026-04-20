import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';

export type Resource = Blob | undefined;

async function extract(zipFile: Blob) {
	const blobReader = new BlobReader(zipFile);
	const zipReader = new ZipReader(blobReader);

	const entries = zipReader.getEntriesGenerator();
	const resources: Map<string, Resource> = new Map();

	for await (const file of entries) {
		if (file.directory) continue;
		const writer = new BlobWriter();

		const blob = await file.getData(writer);
		resources.set(file.filename.toLowerCase(), blob);
	}

	await zipReader.close();

	return resources;
}

const ZipHandler = {
	extract
};

export default ZipHandler;