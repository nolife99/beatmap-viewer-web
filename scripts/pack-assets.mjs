/**
 * Asset atlas packing script.
 * Packs PNG files from public/assets, public/mods, and public/skinning/{argon,legacy,yugen}
 * into PixiJS-compatible spritesheet atlases under public/atlas/.
 *
 * Run: node scripts/pack-assets.mjs
 */
import { packTextures } from "../node_modules/@assetpack/core/dist/texture-packer/packer/packTextures.js";
import fs from "fs-extra";
import path from "path";

const OUT_DIR = "public/atlas";

/**
 * Pack all PNG files in sourceDir into an atlas named `name`.
 * Outputs `public/atlas/<outSubDir>/<name>.json` + `<name>.png`.
 */
async function packGroup(name, sourceDir, outSubDir = "") {
	const dir = path.resolve(sourceDir);
	if (!fs.existsSync(dir)) {
		console.warn(`[skip] ${sourceDir} does not exist`);
		return;
	}

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".png"))
		.map((f) => ({
			path: f,
			contents: fs.readFileSync(path.join(dir, f)),
		}));

	if (files.length === 0) {
		console.warn(`[skip] No PNG files in ${sourceDir}`);
		return;
	}

	const result = await packTextures({
		width: 4096,
		height: 4096,
		padding: 2,
		fixedSize: false,
		powerOfTwo: false,
		allowTrim: true,
		allowRotation: false,
		alphaThreshold: 0.1,
		textureFormat: "png",
		scale: 1,
		resolution: 1,
		nameStyle: "short",
		textureName: name,
		texturesToPack: files,
	});

	const targetDir = outSubDir ? path.join(OUT_DIR, outSubDir) : OUT_DIR;
	fs.ensureDirSync(targetDir);

	for (let i = 0; i < result.textures.length; i++) {
		const suffix = result.textures.length > 1 ? `${i}` : "";
		const pngName = `${name}${suffix}.png`;
		const jsonName = `${name}${suffix}.json`;

		const json = result.jsons[i].json;
		json.meta.image = pngName;

		fs.writeFileSync(path.join(targetDir, jsonName), JSON.stringify(json, null, 2));
		fs.writeFileSync(path.join(targetDir, pngName), result.textures[i].buffer);
		console.log(`  → ${path.join(targetDir, jsonName)}`);
		console.log(`  → ${path.join(targetDir, pngName)}`);
	}
}

console.log("Packing UI assets...");
await packGroup("ui", "public/assets");

console.log("Packing mod icons...");
await packGroup("mods", "public/mods");

console.log("Packing Argon skin...");
await packGroup("argon", "public/skinning/argon", "skins");

console.log("Packing Legacy skin...");
await packGroup("legacy", "public/skinning/legacy", "skins");

console.log("Packing Yugen skin...");
await packGroup("yugen", "public/skinning/yugen", "skins");

console.log("Done.");
