import { HitSample as Sample, SamplePoint } from 'osu-classes';
import Audio from '.';
import BeatmapSet from '../BeatmapSet/index.ts';
import SampleManager from '../BeatmapSet/SampleManager.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';

export default class HitSample extends ScopedClass {
	localGainNode?: GainNode;
	srcs: AudioBufferSourceNode[] = [];

	private isPlaying = false;
	private timeout?: ReturnType<typeof setTimeout>;
	private _pollInterval?: ReturnType<typeof setInterval>;

	constructor(hitSamples: Sample[]) {
		super();
		this.hitSamples = hitSamples;
	}

	private _hitSamples: Sample[] = [];
	get hitSamples() {
		return this._hitSamples;
	}

	set hitSamples(val: Sample[]) {
		this._hitSamples = val;
	}

	play(samplePoint: SamplePoint, isLoop = false) {
		const audio = this.context.consume<Audio>('audio');
		const beatmapset = inject<BeatmapSet>('beatmapset');
		const clientLength = 1 + (beatmapset?.slaves.size ?? 0);

		if (!audio || audio.state === 'STOPPED') return;

		const sampleManager = this.context.consume<SampleManager>('sampleManager');
		if (!sampleManager) return;

		this.srcs = [];

		const masterNode = this.context.consume<GainNode>('masterGainNode')!;
		for (const hitSample of this.hitSamples) {
			let { sampleSet, hitSound } = hitSample;
			if (sampleSet === 'None') sampleSet = samplePoint.sampleSet;
			if (sampleSet === 'None') sampleSet = 'Normal';
			if (!hitSound.includes('slider')) hitSound = `hit${hitSound}`;

			const buffer = sampleManager.get(
				sampleSet.toLowerCase(),
				hitSound.toLowerCase(),
				inject<AudioConfig>('config/audio')?.hitsound
					? 0
					: samplePoint.customIndex
			);
			if (!buffer) continue;

			const src = masterNode.context.createBufferSource();
			src.buffer = buffer;

			if (!this.localGainNode)
				this.localGainNode = masterNode.context.createGain();

			const volume = (samplePoint.volume *
					(inject<AudioConfig>('config/audio')?.effectVolume ?? 1)) /
				clientLength /
				100;
			if (this.localGainNode.gain.value !== volume)
				this.localGainNode.gain.value = volume;

			src.connect(this.localGainNode);
			this.localGainNode.connect(masterNode);

			src.addEventListener('ended', () => setTimeout(() => {
				src.disconnect();
				this.localGainNode?.disconnect();
			}, 5000), { once: true });

			src.start();
			src.loop = isLoop;
			this.srcs.push(src);
		}

		this.isPlaying = true;
	}

	playLoop(samplePoint: SamplePoint, target: number, start: number, end: number) {
		const audio = this.context.consume<Audio>('audio');
		if (!audio) return;

		const stop = () => {
			const cur = audio.currentTime;
			if (this.isPlaying && ((cur < start || cur > end) || audio.state === 'STOPPED'))
				clearCurrent();
		};
		const clearCurrent = () => {
			clearTimeout(this.timeout);
			clearInterval(this._pollInterval);

			for (const src of this.srcs) {
				src.stop();
				src.disconnect();
			}

			this.isPlaying = false;
		};

		if ((target >= start && target <= end) && !this.isPlaying && audio.state === 'PLAYING') {
			clearCurrent();
			this._pollInterval = setInterval(stop, 50);
			this.timeout = setTimeout(() => clearCurrent(), end - target);

			this.play(samplePoint, true);
		}

		// inject<AudioConfig>("config/audio")?.onChange("hitsound", () => {
		//  clearCurrent();
		//      this.playLoop(samplePoint, getTransport().seconds * 1000, start, end);
		// });
	}
}
