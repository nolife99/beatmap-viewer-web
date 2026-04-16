import { parse } from "js-ini";
import { Assets, Spritesheet, Texture } from "pixi.js";
import type SkinningConfig from "@/Config/SkinningConfig";
import { inject } from "@/Context";
import type { Resource } from "../ZipHandler";
import type SkinManager from "./SkinManager";
import type { SkinMetadata } from "./SkinManager";
import { getAudioContext } from "@/Audio";

const sanitizeINI = (str: string) =>
	str
		.split("\n")
		.filter((line) => /(^\[.*\])|(^(\s|\t)*[a-zA-Z0-9]+\s*:.*)/g.test(line))
		.join("\n")
		.replaceAll(/((\/\/)|(;)|(==)).*/g, "");

type SkinConfig = {
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

const ANIMATED_FILENAMES = [
	"followpoint",
	"hit300",
	"hit100",
	"hit50",
	"hit0",
	"sliderb",
	"sliderfollowcircle",
] as const;

export default class Skin {
	config: SkinConfig = {
		General: {
			Name: "Skin",
			Version: "latest",
			HitCircleOverlayAboveNumber: 1,
			SliderBallFlip: 1,
		},
		Colours: {
			Combo1: "255,192,0",
			Combo2: "0,202,0",
			Combo3: "18,124,255",
			Combo4: "242,24,57",
			SliderBorder: "255,255,255",
		},
		Fonts: {
			HitCirclePrefix: "default",
			HitCircleOverlap: -2,
		},
	};

	textures = new Map<string, Texture>();
	animatedTextures = new Map<string, Texture[]>();
	hitsounds = new Map<string, AudioBuffer>();
	colorsLength = 4;

	constructor(
		private resources?: Map<string, Resource>,
		public metadata?: SkinMetadata,
	) {}

	async init(atlasUrls?: string[]) {
		await this.loadConfig();
		await Promise.all([
			atlasUrls ? this.loadTexturesFromAtlases(atlasUrls) : this.loadTextures(),
			this.loadHitsounds(),
		]);
	}

	private async loadConfig() {
		const configFile = await this.resources?.get("skin.ini")?.text();
		if (!configFile) return;

		const config = parse(sanitizeINI(configFile), {
			comment: ["//", "--", ";", "=="],
			delimiter: ":",
		});

		this.config = {
			General: {
				...this.config.General,
				...(config as SkinConfig).General,
			},
			Colours: {
				...this.config.Colours,
				...(config as SkinConfig).Colours,
			},
			Fonts: {
				...this.config.Fonts,
				...(config as SkinConfig).Fonts,
			},
		};

		this.colorsLength = Object.keys(this.config.Colours).filter((key) =>
			/Combo[1-8]/g.test(key),
		).length;
	}

	private async loadTexturesFromAtlases(atlasUrls: string[]) {
		const allFrames = new Map<string, Texture>();

		for (const url of atlasUrls) {
			const loaded = Assets.cache.has(url);
			const sheet = loaded ? Assets.get<Spritesheet>(url) : await Assets.load<Spritesheet>(url);

			for (const [frameName, texture] of Object.entries<Texture>(sheet.textures)) {
				if (!loaded && frameName.includes("@2x")) {
					texture.orig.width /= 2;
					texture.orig.height /= 2;

					texture.trim?.x && (texture.trim.x /= 2);
					texture.trim?.y && (texture.trim.y /= 2);
					texture.trim?.width && (texture.trim.width /= 2);
					texture.trim?.height && (texture.trim.height /= 2);

					texture.updateUvs();
				}

				const baseName = frameName.replace("@2x.png", ".png").replace(".png", "");
				const extracted = baseName.split("/").at(-1) as string;
				const isDefault = /default-[0-9]+/.test(extracted);
				const storeKey = isDefault ? extracted : baseName;

				allFrames.set(frameName, texture);

				if (!this.textures.has(storeKey)) {
					this.textures.set(storeKey, texture);
				}
			}
		}

		for (const filenameBase of ANIMATED_FILENAMES) {
			const regex =
				filenameBase === "sliderb"
					? /^sliderb\d+(@2x)?\.png$/
					: new RegExp(`^${filenameBase}-\\d+(@2x)?\\.png$`);

			const entries = [...allFrames.entries()]
				.filter(([name]) => regex.test(name))
				.sort(([a], [b]) => {
					const stripSuffix = (s: string) =>
						s.replace("@2x.png", "").replace(".png", "");
					const aNum =
						filenameBase === "sliderb"
							? +(stripSuffix(a).replace("sliderb", "") ?? 0)
							: +(stripSuffix(a).split("-").at(-1) ?? 0);
					const bNum =
						filenameBase === "sliderb"
							? +(stripSuffix(b).replace("sliderb", "") ?? 0)
							: +(stripSuffix(b).split("-").at(-1) ?? 0);
					return aNum - bNum;
				})
				.map(([, tex]) => tex);

			if (entries.length > 0) {
				this.animatedTextures.set(filenameBase, entries);
			}
		}
	}

	private async loadTextures() {
		const defaults = [...Array(10)].map(
			(_, idx) => `${this.config.Fonts.HitCirclePrefix}-${idx}`,
		);
		const filenames = [
			"approachcircle",
			...defaults,
			"cursor",
			"cursortrail",
			"timelinehitcircle",
			"followpoint",
			"hit300",
			"hit100",
			"hit50",
			"hit0",
			"hitcircle",
			"hitcircleoverlay",
			"hitcircleflash",
			"hitcircleglow",
			"hitcircleselect",
			"sliderb",
			"sliderb-nd",
			"sliderb-spec",
			"sliderstartcircle",
			"sliderstartcircleoverlay",
			"sliderendcircle",
			"sliderendcircleoverlay",
			"sliderfollowcircle",
			"sliderscorepoint",
			"spinner-approachcircle",
			"spinner-bottom",
			"reversearrow",
			"repeat-edge-piece",
		];
		const animatedFilenames = [
			"followpoint",
			"hit300",
			"hit100",
			"hit50",
			"hit0",
			"sliderb",
			"sliderfollowcircle",
		];

		await Promise.all([
			...filenames.map(async (filename) => {
				const blob =
					this.resources?.get(`${filename}@2x.png`) ??
					this.resources?.get(`${filename}.png`);
				const isHD = this.resources?.has(`${filename}@2x.png`);

				if (!blob) return;

				try {
					const texture = await Assets.load<Texture>({
						src: `${URL.createObjectURL(blob)}`,
						parser: "texture",
					});
					texture.source.resolution = isHD ? 2 : 1;
					texture.update();

					const extracted = filename.split("/").at(-1);
					const isDefault = extracted
						? /default-[0-9]+/g.test(extracted)
						: false;
					this.textures.set(
						isDefault ? (extracted as string) : filename,
						texture,
					);
				} catch {
					return;
				}
			}),
			...animatedFilenames.map(async (filenameBase) => {
				const regex =
					filenameBase === "sliderb"
						? new RegExp(`^${filenameBase}[0-9]+`)
						: new RegExp(`^${filenameBase}-[0-9]+`);

				const entries = new Set(
					this.resources
						?.keys()
						.filter((filename) => regex.test(filename))
						.map((filename) =>
							filename.replaceAll("@2x", "").replaceAll(".png", ""),
						),
				);

				const blobs: [string, Texture][] = (
					await Promise.all(
						[...entries].map(async (filename) => {
							const blob =
								this.resources?.get(`${filename}@2x.png`) ??
								this.resources?.get(`${filename}.png`);
							const isHD =
								this.resources?.has(`${filename}@2x.png`) ?? false;

							if (!blob) return null;

							const texture = await Assets.load<Texture>({
								src: `${URL.createObjectURL(blob)}`,
								parser: "texture",
							});
							texture.source.resolution = isHD ? 2 : 1;
							texture.update();

							return [filename, texture] as [string, Texture];
						}),
					)
				).filter((t) => t !== null);

				if (blobs.length === 0) return;

				const sorted = blobs.toSorted((a, b) =>
					filenameBase === "sliderb"
						? +(a[0].replaceAll("sliderb", "") ?? 0) -
							+(b[0].replaceAll("sliderb", "") ?? 0)
						: +(a[0].split("-").at(-1) ?? 0) -
							+(b[0].split("-").at(-1) ?? 0),
				);
				this.animatedTextures.set(
					filenameBase,
					sorted.map(([_, texture]) => texture),
				);
			}),
		]);
	}

	private async loadHitsounds() {
		const audioContext = getAudioContext();
		const hitSounds = ["drum", "normal", "soft"]
			.map((hitSample) =>
				[
					"hitclap",
					"hitfinish",
					"hitnormal",
					"hitwhistle",
					"sliderslide",
					"slidertick",
					"sliderwhistle",
				].map((hitSound) => `${hitSample}-${hitSound}`),
			)
			.reduce((accm, curr) => {
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
						await resource.arrayBuffer(),
					);
				} catch {
					audioBuffer = audioContext.createBuffer(
						1,
						1,
						audioContext.sampleRate,
					);
					return;
				}
				this.hitsounds.set(filename, audioBuffer);
			}),
		);
	}

	getTexture(filename: string, beatmapSkin?: Skin): Texture | undefined {
		const disableBeatmapSkin =
			inject<SkinningConfig>("config/skinning")?.disableBeatmapSkin;

		if (disableBeatmapSkin || this.config.General.Argon)
			return (
				this.textures.get(filename) ??
				inject<SkinManager>("skinManager")?.defaultSkin?.textures.get(filename)
			);
		return (
			beatmapSkin?.textures.get(filename) ??
			this.textures.get(filename) ??
			inject<SkinManager>("skinManager")?.defaultSkin?.textures.get(filename)
		);
	}

	getAnimatedTexture(filename: string, beatmapSkin?: Skin): Texture[] {
		const disableBeatmapSkin =
			inject<SkinningConfig>("config/skinning")?.disableBeatmapSkin;

		const beatmapTexture = beatmapSkin?.textures.get(filename);
		const beatmapTextures =
			beatmapSkin?.animatedTextures.get(filename) ??
			(beatmapTexture ? [beatmapTexture] : undefined);

		const skinTexture = this.textures.get(filename);
		const skinTextures =
			this?.animatedTextures.get(filename) ??
			(skinTexture ? [skinTexture] : undefined);

		const defaultTexture =
			inject<SkinManager>("skinManager")?.defaultSkin?.textures.get(filename);
		const defaultTextures =
			inject<SkinManager>("skinManager")?.defaultSkin?.animatedTextures.get(
				filename,
			) ?? (defaultTexture ? [defaultTexture] : undefined);

		if (disableBeatmapSkin || this.config.General.Argon) {
			return skinTextures ?? defaultTextures ?? [BLANK_TEXTURE];
		}

		return (
			beatmapTextures ?? skinTextures ?? defaultTextures ?? [BLANK_TEXTURE]
		);
	}

	getHitsound(filename: string) {
		return this.hitsounds.get(filename);
	}
}
