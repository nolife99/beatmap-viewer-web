import { HitSample as Sample, SamplePoint } from 'osu-classes';
import Audio from '.';
import BeatmapSet from '../BeatmapSet/index.ts';
import SampleManager from '../BeatmapSet/SampleManager.ts';
import SkinManager from '../Skinning/SkinManager.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import { DisposableLike } from '@esfx/disposable';

const SHARED_LOOP_TICK_MS = 33;
const GAIN_EPSILON = 0.0001;

export default class HitSample extends ScopedClass {
	private static activeLoops = new Set<HitSample>();
	private static loopTimer?: ReturnType<typeof setTimeout>;
	private static nextTickAt = 0;

	private static sampleRevision = 0;
	private static removeHitsoundListener?: DisposableLike;
	private static removeSkinListener?: DisposableLike;

	localGainNode?: GainNode;
	srcs: AudioBufferSourceNode[] = [];

	private isPlaying = false;

	private loopSamplePoint?: SamplePoint;
	private loopStart = 0;
	private loopEnd = 0;

	private localRevision = 0;
	private activeGlobalRevision = -1;
	private activeLocalRevision = -1;
	private activeSampleSet = '';
	private activeSampleIndex = -1;
	private activeHitsoundOverride = false;

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
		this.localRevision++;

		if (this.loopSamplePoint) {
			this.stopSources();
			HitSample.scheduleTick(0);
		}
	}

	private static registerLoop(sample: HitSample) {
		this.ensureSharedInvalidators();
		this.activeLoops.add(sample);
		this.scheduleTick(0);
	}

	private static unregisterLoop(sample: HitSample) {
		this.activeLoops.delete(sample);

		if (this.activeLoops.size === 0) {
			this.clearTimer();
		}
	}

	private static ensureSharedInvalidators() {
		if (!this.removeHitsoundListener) {
			const audioConfig = inject<AudioConfig>('config/audio');

			const removeHitsoundListener = audioConfig?.onChange('hitsound', () => {
				HitSample.sampleRevision++;
				HitSample.scheduleTick(0);
			});

			if (removeHitsoundListener) {
				this.removeHitsoundListener = removeHitsoundListener;
			}
		}

		if (!this.removeSkinListener) {
			const skinManager = inject<SkinManager>('skinManager');

			const removeSkinListener = skinManager?.addSkinChangeListener(() => {
				HitSample.sampleRevision++;
				HitSample.scheduleTick(0);
			});

			if (removeSkinListener) {
				this.removeSkinListener = removeSkinListener;
			}
		}
	}

	private static scheduleTick(delayMs = SHARED_LOOP_TICK_MS) {
		if (this.activeLoops.size === 0) {
			this.clearTimer();
			return;
		}

		const now = performance.now();
		const nextTickAt = now + delayMs;

		if (this.loopTimer && this.nextTickAt <= nextTickAt + 0.5) {
			return;
		}

		this.clearTimer();

		this.nextTickAt = nextTickAt;
		this.loopTimer = setTimeout(() => {
			HitSample.loopTimer = undefined;
			HitSample.nextTickAt = 0;
			HitSample.tickAllLoops();
		}, delayMs);
	}

	private static clearTimer() {
		if (!this.loopTimer) return;

		clearTimeout(this.loopTimer);
		this.loopTimer = undefined;
		this.nextTickAt = 0;
	}

	private static tickAllLoops() {
		if (this.activeLoops.size === 0) return;

		const loops = Array.from(this.activeLoops);

		for (const loop of loops) {
			loop.tickLoop();
		}

		this.scheduleTick(SHARED_LOOP_TICK_MS);
	}

	play(samplePoint: SamplePoint, isLoop = false) {
		const audio = this.context.consume<Audio>('audio');
		if (audio?.state !== 'PLAYING') return;

		const sampleManager = this.context.consume<SampleManager>('sampleManager');
		const masterNode = this.context.consume<GainNode>('masterGainNode');
		if (!sampleManager || !masterNode) return;

		const audioConfig = inject<AudioConfig>('config/audio');
		const hitsoundOverride = audioConfig?.hitsound === true;
		const sampleIndex = hitsoundOverride ? 0 : samplePoint.customIndex;

		const gain = this.ensureGainNode(masterNode);
		this.updateGain(samplePoint, audioConfig);

		if (isLoop) this.stopSources();

		const sources = this.createSources(
			sampleManager,
			masterNode,
			gain,
			samplePoint,
			sampleIndex,
			isLoop
		);

		if (isLoop) {
			this.srcs = sources;
			this.isPlaying = sources.length > 0;

			this.activeGlobalRevision = HitSample.sampleRevision;
			this.activeLocalRevision = this.localRevision;
			this.activeSampleSet = samplePoint.sampleSet;
			this.activeSampleIndex = sampleIndex;
			this.activeHitsoundOverride = hitsoundOverride;
		}
	}

	playLoop(samplePoint: SamplePoint, target: number, start: number, end: number) {
		this.loopSamplePoint = samplePoint;
		this.loopStart = start;
		this.loopEnd = end;

		HitSample.registerLoop(this);

		this.tickLoop(target);
	}

	stopLoop() {
		this.loopSamplePoint = undefined;
		this.loopStart = 0;
		this.loopEnd = 0;

		this.stopSources();
		HitSample.unregisterLoop(this);
	}

	invalidateLoopSamples() {
		this.localRevision++;

		if (!this.loopSamplePoint) return;

		this.stopSources();
		HitSample.scheduleTick(0);
	}

	private tickLoop(target?: number) {
		const audio = this.context.consume<Audio>('audio');
		const samplePoint = this.loopSamplePoint;

		if (!audio || !samplePoint) {
			this.stopLoop();
			return;
		}

		const cur = target ?? audio.currentTime;

		if (audio.state === 'STOPPED' || cur > this.loopEnd) {
			this.stopLoop();
			return;
		}

		const shouldPlay =
			audio.state === 'PLAYING' &&
			cur >= this.loopStart &&
			cur <= this.loopEnd;

		if (!shouldPlay) {
			this.stopSources();
			return;
		}

		const audioConfig = inject<AudioConfig>('config/audio');
		this.updateGain(samplePoint, audioConfig);

		const hitsoundOverride = audioConfig?.hitsound === true;
		const sampleIndex = hitsoundOverride ? 0 : samplePoint.customIndex;

		if (
			this.isPlaying &&
			this.activeGlobalRevision === HitSample.sampleRevision &&
			this.activeLocalRevision === this.localRevision &&
			this.activeSampleSet === samplePoint.sampleSet &&
			this.activeSampleIndex === sampleIndex &&
			this.activeHitsoundOverride === hitsoundOverride
		) {
			return;
		}

		this.play(samplePoint, true);
	}

	private createSources(
		sampleManager: SampleManager,
		masterNode: GainNode,
		gain: GainNode,
		samplePoint: SamplePoint,
		sampleIndex: number,
		isLoop: boolean
	): AudioBufferSourceNode[] {
		const sources: AudioBufferSourceNode[] = [];

		for (const hitSample of this.hitSamples) {
			const { sampleSet, sampleName } = this.resolveSample(hitSample, samplePoint, isLoop);
			const buffer = sampleManager.get(sampleSet, sampleName, sampleIndex);

			if (!buffer) continue;

			const src = masterNode.context.createBufferSource();

			src.buffer = buffer;
			src.loop = isLoop;
			src.playbackRate.value = 1;

			if (isLoop) {
				src.loopStart = 0;
				src.loopEnd = buffer.duration;
			}

			src.connect(gain);
			src.start();

			if (isLoop) {
				sources.push(src);
			}
		}

		return sources;
	}

	private resolveSample(hitSample: Sample, samplePoint: SamplePoint, isLoop: boolean) {
		let sampleSet = hitSample.sampleSet;

		if (sampleSet === 'None') sampleSet = samplePoint.sampleSet;
		if (sampleSet === 'None') sampleSet = 'Normal';

		return {
			sampleSet: sampleSet.toLowerCase(),
			sampleName: isLoop
				? this.resolveLoopSampleName(hitSample.hitSound)
				: this.resolveOneShotSampleName(hitSample.hitSound)
		};
	}

	private resolveLoopSampleName(hitSound: string): string {
		const lower = hitSound.toLowerCase();

		if (lower.startsWith('slider')) return lower;
		if (lower.startsWith('hit')) return `slider${lower.slice(3)}`;

		if (lower === 'normal' || lower === 'slide') return 'sliderslide';

		return `slider${lower}`;
	}

	private resolveOneShotSampleName(hitSound: string): string {
		const lower = hitSound.toLowerCase();

		if (lower.startsWith('hit') || lower.startsWith('slider')) return lower;

		return `hit${lower}`;
	}

	private ensureGainNode(masterNode: GainNode): GainNode {
		if (!this.localGainNode || this.localGainNode.context !== masterNode.context) {
			try {
				this.localGainNode?.disconnect();
			} catch {
				// Already disconnected.
			}

			this.localGainNode = masterNode.context.createGain();
			this.localGainNode.connect(masterNode);
		}

		return this.localGainNode;
	}

	private updateGain(samplePoint: SamplePoint, audioConfig = inject<AudioConfig>('config/audio')) {
		const gain = this.localGainNode;
		if (!gain) return;

		const beatmapset = inject<BeatmapSet>('beatmapset');
		const clientLength = 1 + (beatmapset?.slaves.size ?? 0);
		const effectVolume = audioConfig?.effectVolume ?? 1;

		const volume = (samplePoint.volume * effectVolume) / clientLength / 100;

		if (Math.abs(gain.gain.value - volume) > GAIN_EPSILON) {
			gain.gain.value = volume;
		}
	}

	private stopSources() {
		if (!this.isPlaying && this.srcs.length === 0) return;

		for (const src of this.srcs) {
			try {
				src.stop();
			} catch {
				// Already stopped.
			}

			try {
				src.disconnect();
			} catch {
				// Already disconnected.
			}
		}

		this.srcs.length = 0;
		this.isPlaying = false;

		this.activeGlobalRevision = -1;
		this.activeLocalRevision = -1;
		this.activeSampleSet = '';
		this.activeSampleIndex = -1;
		this.activeHitsoundOverride = false;
	}
}