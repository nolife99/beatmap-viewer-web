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

type PlaybackCommand = 'play' | 'seek';

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
	private preparedGeneration = 0;
	private preparedTimeMs = Number.NaN;

	private lastHwMicros = 0;
	private lastSabReadPerfMs = 0;
	private lastContextReviveMs = 0;

	private smoothClockMs = 0;
	private smoothClockPerfMs = 0;
	private smoothClockReady = false;
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
		this.guardClock(now);

		if (now <= this.duration) return now;

		void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
		return this.duration;
	}

	set currentTime(val: number) {
		this.seekAudio(val);
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

		const timeMs = this.clampTime(this._currentTime);
		const hasPreparedSeek =
			this.preparedGeneration === this.seekGeneration &&
			Math.abs(this.preparedTimeMs - timeMs) <= 0.5;

		if (!hasPreparedSeek) {
			this.seekGeneration++;

			this.worker.postMessage({
				type: 'play',
				seekSec: timeMs / 1000 + this.encoderDelayMs / 1000,
				generation: this.seekGeneration
			});
		}

		this.lastHwMicros = 0;
		this.lastSabReadPerfMs = performance.now();
		this.resetSmoothClock(timeMs);

		this.workletNode.port.postMessage({
			type: 'play',
			generation: this.seekGeneration,
			rate: this.playbackRate,
			pitchMode: this.pitchMode,
			userPositionSec: timeMs / 1000
		});

		this.preparedGeneration = 0;
		this.preparedTimeMs = Number.NaN;

		this.state = 'PLAYING';
		this.updateMediaSessionState();
	}

	pause(): void {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		this._currentTime = this.clampTime(this.predictedTimeMs());
		this.resetSmoothClock(this._currentTime);

		this.state = 'STOPPED';
		this.worker.postMessage({ type: 'pause' });
		this.workletNode?.port.postMessage({ type: 'pause' });

		this.updateMediaSessionState();
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
		if (this.state !== 'PLAYING') return;
		this.restartPlaybackAt(this.predictedTimeMs(), 'seek');
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

		this.updateMediaSessionState();

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
		switch (msg.type) {
			case 'error':
				console.error('AudioDecoderWorker:', msg.message);
				if (this.state === 'PLAYING') this.pause();
				break;
		}
	}

	private seekAudio(timeMs: number): void {
		const clamped = this.clampTime(timeMs);

		this._currentTime = clamped;
		this.resetSmoothClock(clamped);
		this.updateMediaSessionState();

		if (this.state === 'PLAYING') {
			this.restartPlaybackAt(clamped, 'seek');
			return;
		}

		this.preparedGeneration = ++this.seekGeneration;
		this.preparedTimeMs = clamped;

		this.worker.postMessage({
			type: 'seek',
			seekSec: clamped / 1000 + this.encoderDelayMs / 1000,
			generation: this.seekGeneration
		});
	}

	private restartPlaybackAt(timeMs: number, command: PlaybackCommand): void {
		const clamped = this.clampTime(timeMs);
		const userPositionSec = clamped / 1000;

		this._currentTime = clamped;
		this.seekGeneration++;
		this.preparedGeneration = 0;
		this.preparedTimeMs = Number.NaN;

		this.lastHwMicros = 0;
		this.lastSabReadPerfMs = performance.now();
		this.resetSmoothClock(clamped);

		this.worker.postMessage({
			type: command,
			seekSec: userPositionSec + this.encoderDelayMs / 1000,
			generation: this.seekGeneration
		});

		this.workletNode?.port.postMessage({
			type: command,
			generation: this.seekGeneration,
			rate: this.playbackRate,
			pitchMode: this.pitchMode,
			userPositionSec
		});

		this.updateMediaSessionState();
	}

	private predictedTimeMs(): number {
		if (this.state === 'STOPPED') return this._currentTime;

		let hwMicros = 0;
		let audioMicros = 0;
		let gen = -1;
		let ok = false;

		for (let attempts = 0; attempts < 8; attempts++) {
			const seq1 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);
			if (seq1 & 1) continue;

			hwMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_HW_TIME));
			audioMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_AUDIO_POS));
			gen = Atomics.load(this.clockInt, CLOCK_INT_GEN);

			const seq2 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);
			if (seq1 === seq2) {
				ok = true;
				break;
			}
		}

		if (!ok || gen !== this.seekGeneration) {
			return this.lastReturnedTimeMs || this.smoothClockMs || this._currentTime;
		}

		const perfNow = performance.now();
		const rawMs = audioMicros / 1000;

		if (hwMicros !== this.lastHwMicros) {
			this.lastHwMicros = hwMicros;
			this.lastSabReadPerfMs = perfNow;
		}

		if (!this.smoothClockReady) {
			this.resetSmoothClock(rawMs);
			this.lastReturnedTimeMs = rawMs;
			return rawMs;
		}

		const elapsedMs = perfNow - this.smoothClockPerfMs;
		this.smoothClockPerfMs = perfNow;

		this.smoothClockMs += elapsedMs * this.playbackRate;

		const errorMs = rawMs - this.smoothClockMs;
		this.smoothClockMs += Math.abs(errorMs) > 20 ? errorMs : errorMs * 0.03;

		if (this.smoothClockMs < this.lastReturnedTimeMs) {
			return this.lastReturnedTimeMs;
		}

		this.lastReturnedTimeMs = this.smoothClockMs;
		return this.smoothClockMs;
	}

	private readClockSnapshot(): {
		hwMicros: number;
		audioMicros: number;
		generation: number;
	} | null {
		for (let attempts = 0; attempts < 8; attempts++) {
			const seq1 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);
			if (seq1 & 1) continue;

			const hwMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_HW_TIME));
			const audioMicros = Number(Atomics.load(this.clockBig, CLOCK_BIG_AUDIO_POS));
			const generation = Atomics.load(this.clockInt, CLOCK_INT_GEN);
			const seq2 = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);

			if (seq1 === seq2) return { hwMicros, audioMicros, generation };
		}

		return null;
	}

	private resetSmoothClock(timeMs: number): void {
		this.smoothClockMs = timeMs;
		this.smoothClockPerfMs = performance.now();
		this.smoothClockReady = true;
		this.lastReturnedTimeMs = timeMs;
	}

	private clampTime(ms: number): number {
		return Number.isFinite(ms) && ms >= 0 && ms <= this.durationMs ? ms : 0;
	}

	private guardClock(predictedMs: number): void {
		if (Atomics.load(this.clockInt, CLOCK_INT_PLAYING) !== 1) return;

		if (performance.now() - this.lastSabReadPerfMs > 40) {
			this.reviveContext(predictedMs);
		}
	}

	private reviveContext(predictedMs: number): void {
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
		this.smoothClockReady = false;
		this.preparedGeneration = 0;
		this.preparedTimeMs = Number.NaN;
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
			this.seekFromMediaSession(this.mediaSessionTimeMs() - (d.seekOffset ?? 10) * 1000);
		});

		navigator.mediaSession.setActionHandler('seekforward', (d) => {
			this.seekFromMediaSession(this.mediaSessionTimeMs() + (d.seekOffset ?? 10) * 1000);
		});

		this.updateMediaSessionState();
	}

	private seekFromMediaSession(timeMs: number): void {
		this.beatmapSet.seek(this.clampTime(timeMs));
		this.updateMediaSessionState();
	}

	private updateMediaSessionState(): void {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = this.mediaSessionPlaybackState();
		this.updateMediaSessionPosition();

		if (this.state === 'PLAYING') {
			this.mediaSessionPositionTimer ??= setInterval(() => this.updateMediaSessionPosition(), 1000);
		} else {
			clearInterval(this.mediaSessionPositionTimer);
			this.mediaSessionPositionTimer = undefined;
		}
	}

	private mediaSessionPlaybackState(): MediaSessionPlaybackState {
		return this.init
			? this.state === 'PLAYING' ? 'playing' : 'paused'
			: 'none';
	}

	private updateMediaSessionPosition(): void {
		if (!('mediaSession' in navigator)) return;
		if (!('setPositionState' in navigator.mediaSession)) return;
		if (!this.init || !(this.durationMs > 0)) return;

		try {
			navigator.mediaSession.setPositionState({
				duration: this.durationMs / 1000,
				playbackRate: this.playbackRate,
				position: this.mediaSessionTimeMs() / 1000
			});
		} catch {
			// Safari/Chrome may reject invalid states.
		}
	}

	private mediaSessionTimeMs(): number {
		return this.state === 'PLAYING'
			? this.clampTime(this.predictedTimeMs())
			: this._currentTime;
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