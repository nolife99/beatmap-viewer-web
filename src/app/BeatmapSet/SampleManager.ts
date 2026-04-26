// import { getFileAudioBuffer } from '@soundcut/decode-audio-data-fast';
import { inject } from '../Context.ts';
import SkinManager from '../Skinning/SkinManager.ts';

const HITSOUND_REGEX =
	/(normal|soft|drum)-(hitnormal|hitwhistle|hitclap|hitfinish|slidertick|sliderwhistle|sliderslide)([1-9][0-9]*)?/;

export default class SampleManager {
	private map = new Map<string, AudioBuffer>();

	constructor(
		private files: Map<string, Blob>
	) {
	}

	load(ctx: BaseAudioContext) {
		return Promise.all(
			[...this.files].map(async ([filename, resource]) => {
				if (!HITSOUND_REGEX.test(filename)) return;
				if (!resource) return;

				let audioBuffer: AudioBuffer;

				try {
					audioBuffer = await ctx.decodeAudioData(
						await resource.arrayBuffer()
					);
				} catch (e) {
					console.warn(`Cannot decode ${filename}. Default to silent sample. (${e})`);
					audioBuffer = ctx.createBuffer(
						1,
						1,
						ctx.sampleRate
					);
				}

				const key = filename.split('.').slice(0, -1).join('.');
				this.map.set(key, audioBuffer);
			})
		);
	}

	get(sampleSet: string, hitSound: string, idx: number) {
		const skinManager = inject<SkinManager>('skinManager');

		const key = `${sampleSet}-${hitSound}${idx === 1 ? '' : idx}`;
		const fallbackKey = `${sampleSet}-${hitSound}`;
		const currentSkin = skinManager?.currentSkin;
		const defaultSkin = skinManager?.defaultSkin;

		if (idx === 0)
			return (
				currentSkin?.getHitsound(fallbackKey) ??
				defaultSkin?.getHitsound(fallbackKey)
			);
		return (
			this.map.get(key) ??
			currentSkin?.getHitsound(fallbackKey) ??
			defaultSkin?.getHitsound(fallbackKey)
		);
	}
}
