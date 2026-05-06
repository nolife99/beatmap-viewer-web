import { HitSample as Sample, SamplePoint } from 'osu-classes';
import Audio from '.';
import BeatmapSet from '../BeatmapSet/index.ts';
import SampleManager from '../BeatmapSet/SampleManager.ts';
import SkinManager from '../Skinning/SkinManager.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import { DisposableStack } from '@esfx/disposable';

const DEFAULT_LOOP_POLL_MS = 25;
const MIN_LOOP_POLL_MS = 4;
const MAX_LOOP_POLL_MS = 50;
const GAIN_EPSILON = 0.0001;

export default class HitSample extends ScopedClass {
	localGainNode?: GainNode;
	srcs: AudioBufferSourceNode[] = [];

	private isPlaying = false;
	private _pollInterval?: ReturnType<typeof setInterval>;
	private loopPollMs = DEFAULT_LOOP_POLL_MS;

	private loopSamplePoint?: SamplePoint;
	private loopStart = 0;
	private loopEnd = 0;

	private loopInvalidators?: DisposableStack;
	private invalidatingLoopSamples = false;

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
		this.invalidateLoopSamples();
	}

	play(samplePoint: SamplePoint, isLoop = false) {
		const audio = this.context.consume<Audio>('audio');
		if (audio?.state !== 'PLAYING') return;

		const sampleManager = this.context.consume<SampleManager>('sampleManager');
		const masterNode = this.context.consume<GainNode>('masterGainNode');
		if (!sampleManager || !masterNode) return;

		const gain = this.ensureGainNode(masterNode);
		this.updateGain(samplePoint);

		if (isLoop) this.stopSources();

		const sources: AudioBufferSourceNode[] = [];

		for (const hitSample of this.hitSamples) {
			const { sampleSet, sampleName } = this.resolveSample(hitSample, samplePoint, isLoop);

			const buffer = sampleManager.get(
				sampleSet,
				sampleName,
				inject<AudioConfig>('config/audio')?.hitsound
					? 0
					: samplePoint.customIndex
			);

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

			src.addEventListener('ended', () => {
				try {
					src.disconnect();
				} catch {
					// Already disconnected.
				}
			}, { once: true });

			src.start();
			sources.push(src);
		}

		if (isLoop) {
			this.srcs = sources;
			this.isPlaying = sources.length > 0;
		}
	}

	playLoop(samplePoint: SamplePoint, target: number, start: number, end: number) {
		this.loopSamplePoint = samplePoint;
		this.loopStart = start;
		this.loopEnd = end;

		this.ensureLoopInvalidators();

		const pollMs = this.getLoopPollMs(samplePoint);

		if (pollMs !== this.loopPollMs) {
			this.loopPollMs = pollMs;
			this.restartPolling();
		}

		if (!this._pollInterval) {
			this._pollInterval = setInterval(() => this.tickLoop(), this.loopPollMs);
		}

		this.tickLoop(target);
	}

	stopLoop() {
		this.stopSources();
		this.stopPolling();
		this.disposeLoopInvalidators();
		this.loopSamplePoint = undefined;
	}

	invalidateLoopSamples() {
		if (!this.loopSamplePoint || this.invalidatingLoopSamples) return;

		this.invalidatingLoopSamples = true;

		try {
			const wasPlaying = this.isPlaying;

			this.stopSources();

			if (wasPlaying) {
				this.tickLoop();
			}
		} finally {
			this.invalidatingLoopSamples = false;
		}
	}

	private ensureLoopInvalidators() {
		if (this.loopInvalidators) return;

		const stack = new DisposableStack();

		const audioConfig = inject<AudioConfig>('config/audio');
		const removeHitsoundListener = audioConfig?.onChange('hitsound', () => {
			this.invalidateLoopSamples();
		});

		if (removeHitsoundListener) {
			stack.use(removeHitsoundListener);
		}

		const skinManager = inject<SkinManager>('skinManager');
		const removeSkinListener = skinManager?.addSkinChangeListener(() => {
			this.invalidateLoopSamples();
		});

		if (removeSkinListener) {
			stack.use(removeSkinListener);
		}

		this.loopInvalidators = stack;
	}

	private disposeLoopInvalidators() {
		this.loopInvalidators?.dispose();
		this.loopInvalidators = undefined;
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

		this.updateGain(samplePoint);

		if (!this.isPlaying) {
			this.play(samplePoint, true);
		}
	}

	private getLoopPollMs(samplePoint: SamplePoint): number {
		const sampleManager = this.context.consume<SampleManager>('sampleManager');
		if (!sampleManager) return DEFAULT_LOOP_POLL_MS;

		let shortestMs = Infinity;

		for (const hitSample of this.hitSamples) {
			const { sampleSet, sampleName } = this.resolveSample(hitSample, samplePoint, true);

			const buffer = sampleManager.get(
				sampleSet,
				sampleName,
				inject<AudioConfig>('config/audio')?.hitsound
					? 0
					: samplePoint.customIndex
			);

			if (!buffer) continue;

			shortestMs = Math.min(shortestMs, buffer.duration * 1000);
		}

		return clampPollMs(shortestMs);
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

	private updateGain(samplePoint: SamplePoint) {
		const gain = this.localGainNode;
		if (!gain) return;

		const beatmapset = inject<BeatmapSet>('beatmapset');
		const clientLength = 1 + (beatmapset?.slaves.size ?? 0);
		const effectVolume = inject<AudioConfig>('config/audio')?.effectVolume ?? 1;

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
	}

	private restartPolling() {
		this.stopPolling();

		if (this.loopSamplePoint) {
			this._pollInterval = setInterval(() => this.tickLoop(), this.loopPollMs);
		}
	}

	private stopPolling() {
		if (!this._pollInterval) return;

		clearInterval(this._pollInterval);
		this._pollInterval = undefined;
	}
}

function clampPollMs(ms: number): number {
	if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_LOOP_POLL_MS;

	return Math.max(
		MIN_LOOP_POLL_MS,
		Math.min(MAX_LOOP_POLL_MS, Math.ceil(ms))
	);
}