import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import BeatmapSet from '../BeatmapSet/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import Loading from '../UI/loading/index.ts';
import SpectrogramProcessor from './SpectrogramProcessor.ts';
import SpectrogramContainer from '../UI/sidepanel/Modding/Spectrogram.ts';
import Beatmap from '../BeatmapSet/Beatmap/index.ts';
import type { WorkerOutMessage } from './AudioDecoderWorker.ts';
import { getEncoderDelayMs, sleep } from '../utils.ts';
import {
	CLOCK_BIG_AUDIO_POS,
	CLOCK_BIG_HW_TIME,
	CLOCK_INT_GEN,
	CLOCK_INT_PLAYING,
	CLOCK_INT_SEQNO,
	createClockSAB,
	createRingSAB,
	RING_CHANNELS,
	RING_FRAME_CAPACITY
} from './RingBuffer.ts';

// @ts-expect-error: Deno LSP struggles with Vite's ?worker suffix
import AudioDecoderWorker from './AudioDecoderWorker.ts?worker&inline';

// @ts-expect-error: Deno LSP struggles with Vite workers
import DecoderWorklet from './ClockBridgeProcessor.ts?worklet-inline';

if ('audioSession' in navigator) {
	// @ts-expect-error Safari/WebKit API
	navigator.audioSession.type = 'playback';
}

const CONTEXT_FREEZE_CHECK_MS = 120;

export default class Audio extends ScopedClass {
	state: 'PLAYING' | 'STOPPED' = 'STOPPED';
	init = false;

	private readonly localGainNode: GainNode;
	private readonly worker: Worker = new AudioDecoderWorker;

	private workletNode?: AudioWorkletNode;

	private readonly sabRing: SharedArrayBuffer;
	private readonly sabClock: SharedArrayBuffer;
	private readonly clockInt: Int32Array;
	private readonly clockBig: BigInt64Array;

	private durationMs = 0;
	private encoderDelayMs = 0;
	private loadingPromise?: Promise<void>;
	private loadVersion = 0;
	private seekGeneration = 0;

	private lastHwMicros = 0;
	private lastSabReadPerfMs = 0;
	private lastContextReviveMs = 0;

	private smoothClockMs = 0;
	private smoothClockPerfMs = 0;
	private lastReturnedTimeMs = 0;

	private pitchMode: 'preserve' | 'shift' = 'preserve';
	private mediaSessionPositionTimer?: ReturnType<typeof setInterval>;

	private _currentTime = 0;

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();

		this.localGainNode = this.ctx.createGain();
		this.localGainNode.gain.value =
			inject<AudioConfig>('config/audio')?.musicVolume ?? 0.8;
		this.localGainNode.connect(this.masterNode);

		inject<AudioConfig>('config/audio')?.onChange('musicVolume', (val) => {
			this.localGainNode.gain.value = val;
		});

		this.sabRing = createRingSAB(RING_CHANNELS, RING_FRAME_CAPACITY);
		this.sabClock = createClockSAB();
		this.clockInt = new Int32Array(this.sabClock, 0, 4);
		this.clockBig = new BigInt64Array(this.sabClock, 16, 2);

		this.worker.onmessage = (e) => this.onWorkerMessage(e.data as WorkerOutMessage);
		this.worker.onerror = (e) => console.error('AudioDecoderWorker error:', e);

		this.worker.postMessage({
			type: 'init',
			sabRing: this.sabRing,
			contextSampleRate: this.ctx.sampleRate
		});

		this.setupMediaSession();
	}

	get currentTime(): number {
		if (this.state === 'STOPPED') return this._currentTime;

		const now = this.predictedTimeMs();
		this.reviveFrozenContextIfNeeded(now);

		if (now <= this.durationMs) return now;

		void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
		return this.durationMs;
	}

	set currentTime(val: number) {
		this.dispatchPlayback('seek', val, this.state === 'PLAYING');
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
		const loadingPromise = this.load(blob, loadVersion, beatmap);
		this.loadingPromise = loadingPromise;

		try {
			await loadingPromise;
		} finally {
			if (this.loadingPromise === loadingPromise) this.loadingPromise = undefined;
		}
	}

	async toggle(event: UIEvent | null): Promise<void> {
		if (this.state === 'PLAYING') {
			this.pause();
			return;
		}

		if (event) await this.warmPlayableContext();
		await this.play();
	}

	async play(): Promise<void> {
		if (this.state === 'PLAYING') throw new Error('Already playing');
		if (this.loadingPromise) throw new Error('Audio is still loading');
		if (!this.workletNode) throw new Error('Audio not initialized');
		if (!(this.playbackRate > 0)) throw new Error(`Invalid playback rate: ${this.playbackRate}`);

		await this.ctx.resume();

		this.state = 'PLAYING';
		this.dispatchPlayback('play', this._currentTime, true);
	}

	pause(): void {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		this._currentTime = this.clampTime(this.predictedTimeMs());
		this.resetSmoothClock(this._currentTime);

		this.state = 'STOPPED';
		this.worker.postMessage({ type: 'pause' });
		this.workletNode?.port.postMessage({ type: 'pause' });

		this.syncMediaSession();
	}

	destroy(): void {
		if (this.state === 'PLAYING') this.pause();

		this.loadVersion++;
		this.worker.postMessage({ type: 'destroy' });
		this.workletNode?.disconnect();
		this.workletNode = undefined;
		this.localGainNode.disconnect();
		this.resetLoadedState();
		this.disposeMediaSession();
	}

	onPlaybackRateChange(): void {
		if (this.state === 'PLAYING') {
			this.dispatchPlayback('seek', this.predictedTimeMs(), true);
		}
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
		this.init = true;

		await this.ensureWorkletNode(RING_CHANNELS);
		if (this.disposeIfStale(loadVersion, input)) return;

		this.worker.postMessage({ type: 'load', blob, encoderDelayMs });

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

	private async ensureWorkletNode(numChannels: number): Promise<void> {
		if (this.workletNode?.channelCount === numChannels) return;

		this.workletNode?.disconnect();

		await this.ctx.audioWorklet.addModule(DecoderWorklet);

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
		if (msg.type !== 'error') return;

		console.error('AudioDecoderWorker:', msg.message);
		if (this.state === 'PLAYING') this.pause();
	}

	private dispatchPlayback(command: 'play' | 'seek', timeMs: number, outputPlaying: boolean): void {
		const clamped = this.clampTime(timeMs);
		const generation = ++this.seekGeneration;
		const userPositionSec = clamped / 1000;

		this._currentTime = clamped;
		this.lastHwMicros = 0;
		this.lastSabReadPerfMs = performance.now();
		this.resetSmoothClock(clamped);

		this.worker.postMessage({
			type: command,
			seekSec: userPositionSec + this.encoderDelayMs / 1000,
			generation
		});

		if (outputPlaying) {
			this.workletNode?.port.postMessage({
				type: command,
				generation,
				rate: this.playbackRate,
				pitchMode: this.pitchMode,
				userPositionSec
			});
		} else {
			this.workletNode?.port.postMessage({ type: 'pause' });
		}

		this.syncMediaSession();
	}

	private predictedTimeMs(): number {
		if (this.state === 'STOPPED') return this._currentTime;

		const sample = this.readClockSample();
		if (!sample || sample.gen !== this.seekGeneration) {
			return this.lastReturnedTimeMs || this.smoothClockMs || this._currentTime;
		}

		const perfNow = performance.now();
		const rawMs = sample.audioMicros / 1000;

		if (sample.hwMicros !== this.lastHwMicros) {
			this.lastHwMicros = sample.hwMicros;
			this.lastSabReadPerfMs = perfNow;
		}

		const elapsedMs = perfNow - this.smoothClockPerfMs;
		this.smoothClockPerfMs = perfNow;

		let predicted = this.smoothClockMs + elapsedMs * this.playbackRate;
		const errorMs = rawMs - predicted;

		predicted += Math.abs(errorMs) > 20 ? errorMs : errorMs * 0.03;
		predicted = Math.max(predicted, this.lastReturnedTimeMs);

		this.smoothClockMs = predicted;
		this.lastReturnedTimeMs = predicted;

		return predicted;
	}

	private readClockSample(): { hwMicros: number; audioMicros: number; gen: number } | undefined {
		for (let attempts = 0; attempts < 8; attempts++) {
			const seq1 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);
			if (seq1 & 1) continue;

			const hwMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_HW_TIME));
			const audioMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_AUDIO_POS));
			const gen = Atomics.load(this.clockInt, CLOCK_INT_GEN);

			if (seq1 === Atomics.load(this.clockInt, CLOCK_INT_SEQNO)) {
				return { hwMicros, audioMicros, gen };
			}
		}
	}

	private resetSmoothClock(timeMs: number): void {
		this.smoothClockMs = timeMs;
		this.smoothClockPerfMs = performance.now();
		this.lastReturnedTimeMs = timeMs;
	}

	private clampTime(ms: number): number {
		return Number.isFinite(ms) && ms >= 0 && ms <= this.durationMs ? ms : 0;
	}

	private reviveFrozenContextIfNeeded(predictedMs: number): void {
		if (Atomics.load(this.clockInt, CLOCK_INT_PLAYING) !== 1) return;
		if (performance.now() - this.lastSabReadPerfMs <= 40) return;

		const now = performance.now();
		if (now - this.lastContextReviveMs < 750) return;
		this.lastContextReviveMs = now;

		const ctx = this.ctx;
		const before = ctx.currentTime;

		void ctx.resume()
			.then(() => sleep(CONTEXT_FREEZE_CHECK_MS))
			.then(() => {
				if (this.state !== 'PLAYING' || ctx.currentTime !== before) return;

				return ctx.suspend()
					.catch(() => undefined)
					.then(() => ctx.resume())
					.then(() => this.seekFromMediaSession(predictedMs));
			})
			.catch(() => undefined);
	}

	private async warmPlayableContext(): Promise<void> {
		const ctx = this.ctx;

		await ctx.resume();

		const before = ctx.currentTime;
		void sleep(CONTEXT_FREEZE_CHECK_MS)
			.then(() => ctx.currentTime === before ? ctx.suspend().catch(() => undefined) : undefined)
			.then(() => ctx.currentTime === before ? ctx.resume() : undefined);
	}

	private async renderSpectrogram(
		durationSec: number,
		audioTrack: InputAudioTrack
	): Promise<void> {
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
		this._currentTime = 0;
		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.seekGeneration = 0;
		this.lastHwMicros = 0;
		this.lastSabReadPerfMs = 0;
		this.resetSmoothClock(0);
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
			if (this.state !== 'PLAYING' && this.init) void this.play().catch(() => undefined);
		});

		navigator.mediaSession.setActionHandler('pause', () => {
			if (this.state === 'PLAYING') this.pause();
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
		return this.state === 'PLAYING'
			? this.clampTime(this.predictedTimeMs())
			: this._currentTime;
	}

	private syncMediaSession(): void {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = this.init
			? this.state === 'PLAYING' ? 'playing' : 'paused'
			: 'none';

		if (
			'setPositionState' in navigator.mediaSession &&
			this.init &&
			this.durationMs > 0
		) {
			try {
				navigator.mediaSession.setPositionState({
					duration: this.durationMs / 1000,
					playbackRate: this.playbackRate,
					position: this.mediaTimeMs() / 1000
				});
			} catch {
				// Safari/Chrome may reject invalid states.
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