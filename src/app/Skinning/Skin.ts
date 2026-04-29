import { parse } from 'js-ini';
import { Rectangle, Texture } from 'pixi.js';
import SkinningConfig from '../Config/SkinningConfig.ts';
import { inject } from '../Context.ts';
import SkinManager, { SkinMetadata } from './SkinManager.ts';

const sanitizeINI = (str: string) =>
	str
		.split('\n')
		.filter((line) => /(^\[.*])|(^([\s\t])*[a-zA-Z0-9]+\s*:.*)/g.test(line))
		.join('\n')
		.replaceAll(/((\/\/)|(;)|(==)).*/g, '');

export type SkinConfig = {
	General: {
		Name: string;
		Author?: string;
		Version: number | string;
		AnimationFrameRate?: number;
		HitCircleOverlayAboveNumber?: 0 | 1;
		AllowSliderBallTint?: 0 | 1;
		SliderBallFlip?: 0 | 1;
		Argon?: boolean;
	};
	Colours: {
		Combo1: string;
		Combo2: string;
		Combo3: string;
		Combo4: string;
		Combo5?: string;
		Combo6?: string;
		Combo7?: string;
		Combo8?: string;
		SliderBorder: string;
		SliderTrackOverride?: string;
	};
	Fonts: {
		HitCirclePrefix: string;
		HitCircleOverlap: number;
	};
};

export const BLANK_TEXTURE = new Texture();

type AtlasItem = {
	key: string;
	image: ImageBitmap | HTMLImageElement;
	width: number;
	height: number;
	scale: 1 | 2;
	order?: number;
	x?: number;
	y?: number;
};

type PackedAtlas = {
	texture: Texture;
	frames: Map<string, Texture>;
};

const ATLAS_PADDING = 1;
const ATLAS_MAX_SIZE = 4096;

function nextPow2(v: number): number {
	let n = 1;
	while (n < v) n <<= 1;
	return n;
}

function clampAtlasSize(v: number): number {
	return Math.min(ATLAS_MAX_SIZE, nextPow2(Math.max(1, v)));
}

function createAtlasCanvas(width: number, height: number) {
	if (typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(width, height);
	}

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function getContext2D(
	canvas: OffscreenCanvas | HTMLCanvasElement
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
	const ctx = canvas.getContext('2d', { alpha: true });
	if (!ctx) throw new Error('Unable to create 2D canvas context.');
	return ctx as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function tryPackShelf(
	items: AtlasItem[],
	atlasWidth: number,
	padding: number
): { width: number; height: number; items: AtlasItem[] } | null {
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	let usedWidth = 0;

	for (const item of items) {
		const packedW = item.width + padding * 2;
		const packedH = item.height + padding * 2;

		if (packedW > atlasWidth) return null;

		if (x + packedW > atlasWidth) {
			x = 0;
			y += rowHeight;
			rowHeight = 0;
		}

		item.x = x + padding;
		item.y = y + padding;

		x += packedW;
		if (packedH > rowHeight) rowHeight = packedH;
		if (x > usedWidth) usedWidth = x;
	}

	const usedHeight = y + rowHeight;
	if (usedHeight > ATLAS_MAX_SIZE) return null;

	return {
		width: usedWidth,
		height: usedHeight,
		items
	};
}

function packAtlas(items: AtlasItem[], padding: number): { width: number; height: number; items: AtlasItem[] } {
	if (items.length === 0) {
		return { width: 1, height: 1, items };
	}

	const sorted = items.toSorted((a, b) => {
		if (b.height !== a.height) return b.height - a.height;
		if (b.width !== a.width) return b.width - a.width;
		return a.key.localeCompare(b.key);
	});
	const totalArea = sorted.reduce(
		(acc, item) => acc + (item.width + padding * 2) * (item.height + padding * 2),
		0
	);

	const maxItemWidth = Math.max(...sorted.map((item) => item.width + padding * 2));
	let trialWidth = clampAtlasSize(Math.max(maxItemWidth, Math.ceil(Math.sqrt(totalArea))));

	while (trialWidth <= ATLAS_MAX_SIZE) {
		const cloned = sorted.map((item) => ({ ...item }));
		const packed = tryPackShelf(cloned, trialWidth, padding);

		if (packed) {
			return packed;
		}

		trialWidth <<= 1;
	}

	throw new Error('Unable to pack skin atlas within maximum size.');
}

function extrudeAndDraw(
	ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
	image: ImageBitmap | HTMLImageElement,
	x: number,
	y: number,
	w: number,
	h: number,
	padding: number
) {
	ctx.drawImage(image, x, y, w, h);

	if (padding <= 0) return;

	// Left / right
	ctx.drawImage(image, 0, 0, 1, h, x - padding, y, padding, h);
	ctx.drawImage(image, w - 1, 0, 1, h, x + w, y, padding, h);

	// Top / bottom
	ctx.drawImage(image, 0, 0, w, 1, x, y - padding, w, padding);
	ctx.drawImage(image, 0, h - 1, w, 1, x, y + h, w, padding);

	// Corners
	ctx.drawImage(image, 0, 0, 1, 1, x - padding, y - padding, padding, padding);
	ctx.drawImage(image, w - 1, 0, 1, 1, x + w, y - padding, padding, padding);
	ctx.drawImage(image, 0, h - 1, 1, 1, x - padding, y + h, padding, padding);
	ctx.drawImage(image, w - 1, h - 1, 1, 1, x + w, y + h, padding, padding);
}

function createFrameTexture(
	atlasTexture: Texture,
	x: number,
	y: number,
	pixelWidth: number,
	pixelHeight: number,
	resolution: 1 | 2
): Texture {
	const fx = x / resolution;
	const fy = y / resolution;
	const fw = pixelWidth / resolution;
	const fh = pixelHeight / resolution;

	return new Texture({
		source: atlasTexture.source,
		frame: new Rectangle(fx, fy, fw, fh),
		orig: new Rectangle(0, 0, fw, fh)
	});
}

function buildAtlas(items: AtlasItem[], resolution: 1 | 2): PackedAtlas | null {
	if (items.length === 0) return null;

	const packed = packAtlas(items, ATLAS_PADDING);
	const canvas = createAtlasCanvas(packed.width, packed.height);
	const ctx = getContext2D(canvas);

	for (const item of packed.items) {
		extrudeAndDraw(
			ctx,
			item.image,
			item.x!,
			item.y!,
			item.width,
			item.height,
			ATLAS_PADDING
		);
	}

	const atlasTexture = Texture.from(canvas);
	atlasTexture.source.resolution = resolution;
	atlasTexture.source.update();

	const frames = new Map<string, Texture>();

	for (const item of packed.items) {
		frames.set(
			item.key,
			createFrameTexture(
				atlasTexture,
				item.x!,
				item.y!,
				item.width,
				item.height,
				resolution
			)
		);
	}

	return {
		texture: atlasTexture,
		frames
	};
}

export default class Skin {
	config: SkinConfig = {
		General: {
			Name: 'Skin',
			Version: 'latest',
			HitCircleOverlayAboveNumber: 1,
			SliderBallFlip: 1
		},
		Colours: {
			Combo1: '255,192,0',
			Combo2: '0,202,0',
			Combo3: '18,124,255',
			Combo4: '242,24,57',
			SliderBorder: '255,255,255'
		},
		Fonts: {
			HitCirclePrefix: 'default',
			HitCircleOverlap: -2
		}
	};

	textures = new Map<string, Texture>();
	animatedTextures = new Map<string, Texture[]>();
	hitsounds = new Map<string, AudioBuffer>();
	colorsLength = 4;

	private atlasTextures: Texture[] = [];

	constructor(
		private resources?: Map<string, Blob>,
		public metadata?: SkinMetadata
	) {
	}

	async init() {
		await this.loadConfig();
		await Promise.all([this.loadTextures(), this.loadHitsounds()]);
	}

	destroy() {
		for (const texture of this.textures.values()) {
			if (texture !== BLANK_TEXTURE) texture.destroy();
		}

		for (const frames of this.animatedTextures.values()) {
			for (const texture of frames) {
				if (texture !== BLANK_TEXTURE) texture.destroy();
			}
		}

		for (const atlas of this.atlasTextures) {
			atlas.destroy(true);
		}

		this.textures.clear();
		this.animatedTextures.clear();
		this.hitsounds.clear();
		this.atlasTextures.length = 0;
	}

	getTexture(filename: string, beatmapSkin?: Skin): Texture | undefined {
		const disableBeatmapSkin =
			inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin;

		if (disableBeatmapSkin || this.config.General.Argon)
			return (
				this.textures.get(filename) ??
				inject<SkinManager>('skinManager')?.defaultSkin?.textures.get(filename)
			);
		return (
			beatmapSkin?.textures.get(filename) ??
			this.textures.get(filename) ??
			inject<SkinManager>('skinManager')?.defaultSkin?.textures.get(filename)
		);
	}

	getAnimatedTexture(filename: string, beatmapSkin?: Skin): Texture[] {
		const disableBeatmapSkin =
			inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin;

		const beatmapTexture = beatmapSkin?.textures.get(filename);
		const beatmapTextures =
			beatmapSkin?.animatedTextures.get(filename) ??
			(beatmapTexture ? [beatmapTexture] : undefined);

		const skinTexture = this.textures.get(filename);
		const skinTextures =
			this.animatedTextures.get(filename) ??
			(skinTexture ? [skinTexture] : undefined);

		const defaultTexture =
			inject<SkinManager>('skinManager')?.defaultSkin?.textures.get(filename);
		const defaultTextures =
			inject<SkinManager>('skinManager')?.defaultSkin?.animatedTextures.get(
				filename
			) ?? (defaultTexture ? [defaultTexture] : undefined);

		if (disableBeatmapSkin || this.config.General.Argon) {
			return skinTextures ?? defaultTextures ?? [BLANK_TEXTURE];
		}

		return beatmapTextures ?? skinTextures ?? defaultTextures ?? [BLANK_TEXTURE];
	}

	getHitsound(filename: string) {
		return this.hitsounds.get(filename);
	}

	private async loadConfig() {
		if (!this.resources?.get) return;

		const configFile = this.resources?.get('skin.ini')?.text();
		if (!configFile) return;

		const config = parse(sanitizeINI(await configFile), {
			comment: ['//', '--', ';', '=='],
			delimiter: ':'
		});

		this.config = {
			General: {
				...this.config.General,
				...(config as SkinConfig).General
			},
			Colours: {
				...this.config.Colours,
				...(config as SkinConfig).Colours
			},
			Fonts: {
				...this.config.Fonts,
				...(config as SkinConfig).Fonts
			}
		};

		this.colorsLength = Object.keys(this.config.Colours).filter((key) =>
			/Combo[1-8]/g.test(key)
		).length;
	}

	private async loadTextures() {
		const defaults = [...Array(10)].map(
			(_, idx) => `${this.config.Fonts.HitCirclePrefix}-${idx}`.toLowerCase()
		);

		const filenames = [
			'approachcircle',
			...defaults,
			'cursor',
			'cursortrail',
			'timelinehitcircle',
			'followpoint',
			'hit300',
			'hit100',
			'hit50',
			'hit0',
			'hitcircle',
			'hitcircleoverlay',
			'hitcircleflash',
			'hitcircleglow',
			'hitcircleselect',
			'sliderb',
			'sliderb-nd',
			'sliderb-spec',
			'sliderstartcircle',
			'sliderstartcircleoverlay',
			'sliderendcircle',
			'sliderendcircleoverlay',
			'sliderfollowcircle',
			'sliderscorepoint',
			'spinner-approachcircle',
			'spinner-bottom',
			'reversearrow',
			'repeat-edge-piece'
		];

		const animatedFilenames = [
			'followpoint',
			'hit300',
			'hit100',
			'hit50',
			'hit0',
			'sliderb',
			'sliderfollowcircle'
		];

		const staticItems1x: AtlasItem[] = [];
		const staticItems2x: AtlasItem[] = [];
		const animatedGroups = new Map<string, AtlasItem[]>();

		const addAtlasItem = async (mapKey: string, fileBase: string, order?: number) => {
			const has2x = this.resources?.has(`${fileBase}@2x.png`) ?? false;
			const resource =
				this.resources?.get(`${fileBase}@2x.png`) ??
				this.resources?.get(`${fileBase}.png`);

			if (!resource) return;

			const image = await createImageBitmap(resource);
			const width = 'width' in image ? image.width : 0;
			const height = 'height' in image ? image.height : 0;
			const scale: 1 | 2 = has2x ? 2 : 1;

			const item: AtlasItem = {
				key: mapKey,
				image,
				width,
				height,
				scale,
				order
			};

			if (animatedGroups.has(mapKey)) {
				animatedGroups.get(mapKey)!.push(item);
				return;
			}

			if (scale === 2) staticItems2x.push(item);
			else staticItems1x.push(item);
		};

		await Promise.all(
			filenames.map(async (filename) => {
				const extracted = filename.split('/').at(-1);
				const isDefault = extracted ? /default-[0-9]+/g.test(extracted) : false;
				const mapKey = isDefault ? (extracted as string) : filename;

				await addAtlasItem(mapKey, filename);
			})
		);

		for (const filenameBase of animatedFilenames) {
			const regex =
				filenameBase === 'sliderb'
					? new RegExp(`^${filenameBase}[0-9]+(?:@2x)?\\.png$`)
					: new RegExp(`^${filenameBase}-[0-9]+(?:@2x)?\\.png$`);

			const entries = new Set(
				this.resources
					?.keys()
					.filter((filename) => regex.test(filename))
					.map((filename) =>
						filename.replaceAll('@2x', '').replaceAll('.png', '')
					)
			);

			if (entries.size === 0) continue;

			animatedGroups.set(filenameBase, []);

			await Promise.all(
				[...entries].map(async (entry) => {
					let order: number;
					if (filenameBase === 'sliderb') {
						order = +(entry.replaceAll('sliderb', '') ?? 0);
					} else {
						order = +(entry.split('-').at(-1) ?? 0);
					}

					const has2x = this.resources?.has(`${entry}@2x.png`) ?? false;
					const resource =
						this.resources?.get(`${entry}@2x.png`) ??
						this.resources?.get(`${entry}.png`);

					if (!resource) return;

					const image = await createImageBitmap(resource);
					const width = 'width' in image ? image.width : 0;
					const height = 'height' in image ? image.height : 0;
					const scale: 1 | 2 = has2x ? 2 : 1;

					animatedGroups.get(filenameBase)!.push({
						key: `${filenameBase}::${order}`,
						image,
						width,
						height,
						scale,
						order
					});
				})
			);
		}

		const animatedItems1x: AtlasItem[] = [];
		const animatedItems2x: AtlasItem[] = [];

		for (const items of animatedGroups.values()) {
			for (const item of items) {
				if (item.scale === 2) animatedItems2x.push(item);
				else animatedItems1x.push(item);
			}
		}

		const atlas1x = buildAtlas([...staticItems1x, ...animatedItems1x], 1);
		const atlas2x = buildAtlas([...staticItems2x, ...animatedItems2x], 2);

		if (atlas1x) this.atlasTextures.push(atlas1x.texture);
		if (atlas2x) this.atlasTextures.push(atlas2x.texture);

		const resolveFrame = (key: string, scale: 1 | 2): Texture | undefined => {
			if (scale === 2) return atlas2x?.frames.get(key);
			return atlas1x?.frames.get(key);
		};

		for (const item of staticItems1x) {
			const texture = resolveFrame(item.key, 1);
			if (texture) this.textures.set(item.key, texture);
		}

		for (const item of staticItems2x) {
			const texture = resolveFrame(item.key, 2);
			if (texture) this.textures.set(item.key, texture);
		}

		for (const [filenameBase, items] of animatedGroups) {
			const sorted = items.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
			const textures = sorted
				.map((item) => resolveFrame(item.key, item.scale))
				.filter((texture): texture is Texture => texture !== undefined);

			if (textures.length > 0) {
				this.animatedTextures.set(filenameBase, textures);
			}
		}
	}

	private async loadHitsounds() {
		const audioContext = new AudioContext();
		const hitSounds = ['drum', 'normal', 'soft']
			.map((hitSample) =>
				[
					'hitclap',
					'hitfinish',
					'hitnormal',
					'hitwhistle',
					'sliderslide',
					'slidertick',
					'sliderwhistle'
				].map((hitSound) => `${hitSample}-${hitSound}`)
			)
			.reduce<string[]>((accm, curr) => {
				accm.push(...curr);
				return accm;
			}, []);

		await Promise.all(
			hitSounds.map(async (filename) => {
				let resource = this.resources?.get(`${filename}.wav`);
				if (!resource) {
					resource = this.resources?.get(`${filename}.ogg`);
				}
				if (!resource) return;

				let audioBuffer: AudioBuffer;
				try {
					audioBuffer = await audioContext.decodeAudioData(
						await resource.arrayBuffer()
					);
				} catch {
					audioBuffer = audioContext.createBuffer(
						1,
						1,
						audioContext.sampleRate
					);
				}
				this.hitsounds.set(filename, audioBuffer);
			})
		);
	}
}