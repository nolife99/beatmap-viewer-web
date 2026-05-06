import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import BeatmapSet from '../BeatmapSet/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import Loading from '../UI/loading/index.ts';
import SpectrogramProcessor from './SpectrogramProcessor.ts';
import SpectrogramContainer from '../UI/sidepanel/Modding/Spectrogram.ts';
import Beatmap from '../BeatmapSet/Beatmap/index.ts';
import type { WorkerOutMessage } from './AudioDecoderWorker.ts';
import { getEncoderDelayMs } from '../utils.ts';
import {
	CLOCK_BIG_AUDIO_POS,
	CLOCK_BIG_HW_TIME,
	CLOCK_INT_GEN,
	CLOCK_INT_PLAYING,
	CLOCK_INT_RATE_PPM,
	CLOCK_INT_SEQNO,
	createClockSAB,
	createRingSAB,
	RING_CHANNELS,
	RING_FRAME_CAPACITY
} from './RingBuffer.ts';

// @ts-expect-error: Workers have no default export
import AudioDecoderWorker from './AudioDecoderWorker.ts?worker&inline';

// @ts-expect-error: Worklets have no default export
import DecoderWorklet from './ClockBridgeProcessor.ts?worklet-inline';

if ('audioSession' in navigator) {
	// @ts-expect-error Safari/WebKit API
	navigator.audioSession.type = 'playback';
}

type PitchMode = 'preserve' | 'shift';
type ClockSample = {
	hwMicros: number;
	audioMicros: number;
	gen: number;
	playing: boolean;
	rate: number;
};

class HardwareClockSmoother {
	private anchorPerfMs = performance.now();
	private anchorAudioMs = 0;
	private anchorRate = 1;
	private lastSampleHwMicros = -1;
	private lastGeneration = -1;
	private lastReturnedMs = 0;
	private playing = false;

	valueMs(perfNowMs = performance.now()): number {
		if (!this.playing) return this.anchorAudioMs;

		const predicted = this.predict(perfNowMs);
		if (predicted < this.lastReturnedMs && this.lastReturnedMs - predicted <= 12) {
			return this.lastReturnedMs;
		}

		this.lastReturnedMs = predicted;
		return predicted;
	}

	reset(ms: number, generation: number, perfNowMs = performance.now(), rate = 1, playing = false): void {
		this.anchorPerfMs = perfNowMs;
		this.anchorAudioMs = ms;
		this.anchorRate = rate > 0 ? rate : 1;
		this.lastSampleHwMicros = -1;
		this.lastGeneration = generation;
		this.lastReturnedMs = ms;
		this.playing = playing;
	}

	accept(sample: ClockSample, expectedGeneration: number, perfNowMs: number): number | undefined {
		if (sample.gen !== expectedGeneration) return undefined;

		const sampleAudioMs = sample.audioMicros / 1000;
		const sampleRate = sample.playing ? Math.max(0, sample.rate) : 0;

		if (sample.gen !== this.lastGeneration) {
			this.reset(sampleAudioMs, sample.gen, perfNowMs, sampleRate, sample.playing);
			this.lastSampleHwMicros = sample.hwMicros;
			return this.valueMs(perfNowMs);
		}

		this.playing = sample.playing;

		if (!sample.playing) {
			this.anchorPerfMs = perfNowMs;
			this.anchorAudioMs = sampleAudioMs;
			this.anchorRate = sampleRate;
			this.lastReturnedMs = sampleAudioMs;
			this.lastSampleHwMicros = sample.hwMicros;
			return sampleAudioMs;
		}

		if (sample.hwMicros !== this.lastSampleHwMicros) {
			this.trimToSample(
				sampleAudioMs,
				sampleRate,
				perfNowMs,
				Math.abs(sampleRate - this.anchorRate) > 1e-6
			);
			this.lastSampleHwMicros = sample.hwMicros;
		}

		return this.valueMs(perfNowMs);
	}

	private trimToSample(sampleAudioMs: number, sampleRate: number, perfNowMs: number, forceAnchor: boolean): void {
		const predicted = this.predict(perfNowMs);
		const errorMs = sampleAudioMs - predicted;

		this.anchorPerfMs = perfNowMs;
		this.anchorRate = sampleRate;

		if (forceAnchor || Math.abs(errorMs) > 20) {
			this.anchorAudioMs = sampleAudioMs;
			this.lastReturnedMs = Math.max(this.lastReturnedMs, sampleAudioMs);
			return;
		}

		const correction = clamp(errorMs * 0.04, -0.75, 0.75);
		this.anchorAudioMs = predicted + correction;
	}

	private predict(perfNowMs: number): number {
		return this.anchorAudioMs + Math.max(0, perfNowMs - this.anchorPerfMs) * this.anchorRate;
	}
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

export default class Audio extends ScopedClass {
	state: 'PLAYING' | 'STOPPED' = 'STOPPED';
	init = false;

	private readonly localGainNode: GainNode;
	private readonly worker: Worker = new AudioDecoderWorker;

	private workletNode?: AudioWorkletNode;
	private workletModulePromise?: Promise<void>;

	private readonly sabRing = createRingSAB(RING_CHANNELS, RING_FRAME_CAPACITY);
	private readonly sabClock = createClockSAB();
	private readonly clockInt = new Int32Array(this.sabClock, 0, 4);
	private readonly clockBig = new BigInt64Array(this.sabClock, 16, 2);
	private readonly clock = new HardwareClockSmoother();

	private durationMs = 0;
	private encoderDelayMs = 0;
	private loadingPromise?: Promise<void>;
	private loadVersion = 0;
	private seekGeneration = 0;
	private primedGeneration = -1;
	private pitchMode: PitchMode = 'preserve';
	private mediaSessionPositionTimer?: ReturnType<typeof setInterval>;
	private pendingWorkerLoad?: { resolve: () => void; reject: (err: unknown) => void };

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();
		const config = inject<AudioConfig>('config/audio');

		this.localGainNode = this.ctx.createGain();
		this.localGainNode.gain.value = config?.musicVolume ?? 0.8;
		this.localGainNode.connect(this.masterNode);

		this.lifetime.use(config?.onChange('musicVolume', (val) => {
			this.localGainNode.gain.value = val;
		}));

		this.worker.onmessage = (e) => this.onWorkerMessage(e.data as WorkerOutMessage);
		this.worker.onerror = (e) => console.error('AudioDecoderWorker error:', e.error);
		this.worker.postMessage({
			type: 'init',
			sabRing: this.sabRing,
			contextSampleRate: this.ctx.sampleRate
		});

		this.setupMediaSession();
	}

	private _currentTime = 0;

	get currentTime(): number {
		if (this.state === 'STOPPED') return this._currentTime;

		const now = this.hardwareTimeMs();

		if (this.durationMs > 0 && now > this.durationMs) {
			this._currentTime = this.durationMs;
			void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
			return this.durationMs;
		}

		this._currentTime = Math.max(0, now);
		return this._currentTime;
	}

	set currentTime(val: number) {
		this.seekAudio(val, this.state === 'PLAYING');
	}

	get encodedClock(): SharedArrayBuffer {
		return this.sabClock;
	}

	get playbackRate(): number {
		return this.beatmapSet.playbackRate ?? 1;
	}

	get duration(): number {
		return this.durationMs;
	}

	private get ctx(): AudioContext {
		return this.masterNode.context as AudioContext;
	}

	async createBufferNode(blob: Blob, beatmap: Beatmap): Promise<void> {
		if (this.state === 'PLAYING') this.pause();

		inject<Loading>('ui/loading')?.setText('Loading audio...');

		const loadVersion = ++this.loadVersion;
		const promise = this.load(blob, loadVersion, beatmap);
		this.loadingPromise = promise;

		try {
			await promise;
		} finally {
			if (this.loadingPromise === promise) this.loadingPromise = undefined;
		}
	}

	async toggle(event: UIEvent | null): Promise<void> {
		if (this.state === 'PLAYING') {
			this.pause();
			return;
		}

		if (event) await this.ctx.resume();
		this.play();
	}

	play() {
		if (this.state === 'PLAYING') throw new Error('Already playing');
		if (this.loadingPromise) throw new Error('Audio is still loading');
		if (!this.workletNode) throw new Error('Audio not initialized');
		if (this.playbackRate <= 0) throw new Error(`Invalid playback rate: ${this.playbackRate}`);

		this.state = 'PLAYING';
		const timeMs = this.clampTime(this._currentTime);

		if (this.primedGeneration !== this.seekGeneration) {
			this.seekAudio(timeMs, true);
			return;
		}

		this.workletNode?.port.postMessage({
			type: 'play',
			generation: this.seekGeneration,
			rate: this.playbackRate,
			pitchMode: this.pitchMode
		});
		this.syncMediaSession();
	}

	pause(): void {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		this._currentTime = this.clampTime(this.hardwareTimeMs());
		this.state = 'STOPPED';

		this.workletNode?.port.postMessage({
			type: 'pause',
			generation: this.seekGeneration
		});
		this.worker.postMessage({ type: 'pause' });
		this.syncMediaSession();
	}

	override destroy(): void {
		if (this.state === 'PLAYING') this.pause();

		this.loadVersion++;
		this.pendingWorkerLoad?.reject(new Error('Audio destroyed'));
		this.pendingWorkerLoad = undefined;
		this.worker.postMessage({ type: 'destroy' });
		this.workletNode?.disconnect();
		this.workletNode = undefined;
		this.localGainNode.disconnect();
		this.resetLoadedState();
		this.disposeMediaSession();

		super.destroy();
	}

	onPlaybackRateChange(): void {
		const rate = this.playbackRate;
		if (!(rate > 0)) return;

		if (this.state === 'STOPPED') {
			this.syncMediaSession();
			return;
		}

		this.workletNode?.port.postMessage({ type: 'setRate', rate, pitchMode: this.pitchMode });
		this.syncMediaSession();
	}

	private async load(blob: Blob, loadVersion: number, beatmap: Beatmap): Promise<void> {
		this.resetLoadedState();

		const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });

		const track = await input.getPrimaryAudioTrack();
		if (this.disposeIfStale(loadVersion, input)) return;
		if (!track) {
			input.dispose();
			throw new Error('No primary audio track found');
		}

		const canDecode = await track.canDecode();
		if (this.disposeIfStale(loadVersion, input)) return;
		if (!canDecode) {
			input.dispose();
			throw new Error('Track cannot be decoded');
		}

		const [durationSec, encoderDelayMs] = await Promise.all([
			input.computeDuration(),
			getEncoderDelayMs(blob, track)
		]);
		if (this.disposeIfStale(loadVersion, input)) return;

		this.durationMs = Number.isFinite(durationSec) ? durationSec * 1000 : 0;
		this.encoderDelayMs = encoderDelayMs;

		await this.ensureWorkletNode(RING_CHANNELS);
		if (this.disposeIfStale(loadVersion, input)) return;

		await this.loadWorker(blob, encoderDelayMs);
		if (this.disposeIfStale(loadVersion, input)) return;

		this.init = true;
		this.seekAudio(0, false);

		if ('mediaSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: beatmap.data.metadata.title,
				artist: beatmap.data.metadata.artistUnicode
			});
		}

		this.syncMediaSession();

		this.renderSpectrogram(durationSec, track)
			.catch(console.error)
			.finally(() => input.dispose());
	}

	private loadWorker(blob: Blob, encoderDelayMs: number): Promise<void> {
		this.pendingWorkerLoad?.reject(new Error('Superseded audio load'));

		return new Promise((resolve, reject) => {
			this.pendingWorkerLoad = { resolve, reject };
			this.worker.postMessage({ type: 'load', blob, encoderDelayMs });
		});
	}

	private async ensureWorkletNode(numChannels: number): Promise<void> {
		if (this.workletNode?.channelCount === numChannels) return;

		this.workletNode?.disconnect();
		this.workletModulePromise ??= this.ctx.audioWorklet.addModule(DecoderWorklet);
		await this.workletModulePromise;

		this.workletNode = new AudioWorkletNode(this.ctx, 'clock-bridge-processor', {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [numChannels],
			processorOptions: {
				sabRing: this.sabRing,
				sabClock: this.sabClock
			}
		});

		this.workletNode.connect(this.localGainNode);
	}

	private onWorkerMessage(msg: WorkerOutMessage): void {
		switch (msg.type) {
			case 'loaded':
				this.pendingWorkerLoad?.resolve();
				this.pendingWorkerLoad = undefined;
				break;

			case 'ended':
				if (msg.generation === this.seekGeneration && this.state === 'PLAYING') {
					this._currentTime = this.durationMs;
					this.clock.reset(this.durationMs, this.seekGeneration, performance.now(), this.playbackRate, false);
				}
				break;

			case 'error':
				console.error('AudioDecoderWorker:', msg.message);
				this.pendingWorkerLoad?.reject(new Error(msg.message));
				this.pendingWorkerLoad = undefined;
				if (this.state === 'PLAYING') this.pause();
				break;
		}
	}

	private seekAudio(timeMs: number, playing: boolean): void {
		const clamped = this.clampTime(timeMs);
		const generation = ++this.seekGeneration;
		this._currentTime = clamped;
		this.clock.reset(clamped, generation, performance.now(), this.playbackRate, playing);
		this.primedGeneration = generation;

		this.worker.postMessage({
			type: 'seek',
			seekSec: clamped / 1000 + this.encoderDelayMs / 1000,
			generation
		});

		this.postWorkletTransport(playing ? 'seek' : 'prime', clamped);
		this.syncMediaSession();
	}

	private postWorkletTransport(type: 'seek' | 'prime', timeMs: number): void {
		this.workletNode?.port.postMessage({
			type,
			generation: this.seekGeneration,
			rate: this.playbackRate,
			pitchMode: this.pitchMode,
			userPositionSec: timeMs / 1000
		});
	}

	private hardwareTimeMs(): number {
		const perfNow = performance.now();
		const sample = this.readClockSample();
		if (!sample) return this.clock.valueMs(perfNow);

		const next = this.clock.accept(sample, this.seekGeneration, perfNow);
		return next ?? this.clock.valueMs(perfNow);
	}

	private readClockSample(): ClockSample | undefined {
		for (let attempts = 0; attempts < 8; attempts++) {
			const seq1 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);
			if (seq1 & 1) continue;

			const ratePpm = Atomics.load(this.clockInt, CLOCK_INT_RATE_PPM);
			const sample: ClockSample = {
				hwMicros: Number(Atomics.load(this.clockBig, CLOCK_BIG_HW_TIME)),
				audioMicros: Number(Atomics.load(this.clockBig, CLOCK_BIG_AUDIO_POS)),
				gen: Atomics.load(this.clockInt, CLOCK_INT_GEN),
				playing: Atomics.load(this.clockInt, CLOCK_INT_PLAYING) === 1,
				rate: Math.max(0, ratePpm) / 1_000_000
			};

			if (seq1 === Atomics.load(this.clockInt, CLOCK_INT_SEQNO)) return sample;
		}
	}

	private clampTime(ms: number): number {
		return Number.isFinite(ms) && ms >= 0 && ms <= this.durationMs ? ms : 0;
	}

	private async renderSpectrogram(durationSec: number, audioTrack: InputAudioTrack): Promise<void> {
		const spectrogram = new SpectrogramProcessor({
			sink: new AudioSampleSink(audioTrack),
			durationSec,
			sampleRate: audioTrack.sampleRate,
			channels: audioTrack.numberOfChannels,
			width: 400,
			height: 400,
			fftSamples: 512,
			frequencyMin: 0,
			frequencyMax: audioTrack.sampleRate / 2,
			scale: 'linear',
			gainDB: 0,
			rangeDB: 80,
			container: '#a',
			onTextureUpdate: (texture) => {
				inject<SpectrogramContainer>('ui/sidepanel/modding/spectrogram')?.setTexture(texture);
			}
		});

		try {
			await spectrogram.render();
		} finally {
			spectrogram.destroy();
		}
	}

	private resetLoadedState(): void {
		this.init = false;
		this.state = 'STOPPED';
		this._currentTime = 0;
		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.seekGeneration = 0;
		this.primedGeneration = -1;
		this.clock.reset(0, this.seekGeneration, performance.now(), this.playbackRate, false);
	}

	private disposeIfStale(loadVersion: number, input: Input): boolean {
		if (loadVersion === this.loadVersion) return false;
		input.dispose();
		return true;
	}

	private setupMediaSession(): void {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.metadata = new MediaMetadata({
			title: 'Beatmap audio',
			artist: '',
			album: ''
		});

		navigator.mediaSession.setActionHandler('play', () => {
			if (this.state !== 'PLAYING' && this.init) void this.beatmapSet.toggle();
		});

		navigator.mediaSession.setActionHandler('pause', () => {
			if (this.state === 'PLAYING') void this.beatmapSet.toggle();
		});

		navigator.mediaSession.setActionHandler('stop', () => {
			if (this.state === 'PLAYING') this.pause();
			this.seekFromMediaSession(0);
		});

		navigator.mediaSession.setActionHandler('seekto', (d) => {
			if (typeof d.seekTime === 'number') this.seekFromMediaSession(d.seekTime * 1000);
		});

		navigator.mediaSession.setActionHandler('seekbackward', (d) => {
			this.seekFromMediaSession(this.mediaTimeMs() - (d.seekOffset ?? 10) * 1000);
		});

		navigator.mediaSession.setActionHandler('seekforward', (d) => {
			this.seekFromMediaSession(this.mediaTimeMs() + (d.seekOffset ?? 10) * 1000);
		});

		this.syncMediaSession();
	}

	private seekFromMediaSession(timeMs: number): void {
		this.beatmapSet.seek(this.clampTime(timeMs));
		this.syncMediaSession();
	}

	private mediaTimeMs(): number {
		return this.state === 'PLAYING' ? this.currentTime : this._currentTime;
	}

	private syncMediaSession(): void {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = this.init
			? this.state === 'PLAYING' ? 'playing' : 'paused'
			: 'none';

		if ('setPositionState' in navigator.mediaSession && this.init && this.durationMs > 0) {
			try {
				navigator.mediaSession.setPositionState({
					duration: this.durationMs / 1000,
					playbackRate: this.playbackRate,
					position: this.mediaTimeMs() / 1000
				});
			} catch {
				// Invalid states are browser-dependent.
			}
		}

		if (this.state === 'PLAYING') {
			this.mediaSessionPositionTimer ??= setInterval(() => this.syncMediaSession(), 1000);
		} else {
			clearInterval(this.mediaSessionPositionTimer);
			this.mediaSessionPositionTimer = undefined;
		}
	}

	private disposeMediaSession(): void {
		clearInterval(this.mediaSessionPositionTimer);
		this.mediaSessionPositionTimer = undefined;

		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = 'none';

		try {
			navigator.mediaSession.setPositionState();
		} catch {
			// ignore
		}

		for (const action of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward'] as const) {
			navigator.mediaSession.setActionHandler(action, null);
		}
	}
}
