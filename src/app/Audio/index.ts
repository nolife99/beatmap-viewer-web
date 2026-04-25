import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import BeatmapSet from '../BeatmapSet/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import Loading from '../UI/loading/index.ts';
import SpectrogramProcessor from './SpectrogramProcessor.ts';
import SpectrogramContainer from '../UI/sidepanel/Modding/Spectrogram.ts';

if ('audioSession' in navigator) {
	// @ts-expect-error WebKit-only API
	navigator.audioSession.type = 'playback';
}

type RendererMessage =
	| { type: 'ready'; generation: number; bufferedFrames: number }
	| {
	type: 'clock';
	generation: number;
	mediaMs: number;
	contextTimeSec: number;
	bufferedFrames: number;
	underruns: number;
	playing: boolean;
	ended: boolean;
}
	| {
	type: 'underrun';
	generation: number;
	mediaMs: number;
	contextTimeSec: number;
	bufferedFrames: number;
	underruns: number;
}
	| { type: 'overflow'; generation: number; bufferedFrames: number };

type DecoderMessage =
	| { type: 'loaded'; loadId: number; sampleRate: number; channels: number }
	| { type: 'error'; message: string; stack?: string };

type Engine = {
	node: AudioWorkletNode;
	worker: Worker;
};

type PendingDecoderLoad = {
	id: number;
	resolve: () => void;
	reject: (reason?: unknown) => void;
};

type PendingReady = {
	generation: number;
	resolve: () => void;
};

const EPSILON_RATE = 1e-6;

const SEEK_COOLDOWN_MS = 120;
const UNDERRUN_SEEK_COOLDOWN_MS = 120;

const CLOCK_STALE_MS = 260;
const MAX_STALE_EXTRAPOLATE_MS = 120;
const CLOCK_COMPENSATION_LIMIT_MS = 250;
const SOFT_REBASE_MS = 10;
const SOFT_REBASE_BLEND = 0.25;

const CONTEXT_FREEZE_CHECK_MS = 120;
const CONTEXT_REVIVE_COOLDOWN_MS = 750;

const MIN_START_SEC = 0.035;
const START_READY_TIMEOUT_MS = 500;
const FADE_SEC = 0.006;

export default class Audio extends ScopedClass {
	state: 'PLAYING' | 'STOPPED' = 'STOPPED';
	init = false;

	private readonly localGainNode: GainNode;

	private input?: Input;
	private sink?: AudioBufferSink;
	private spectrogram?: SpectrogramProcessor;

	private engine?: Engine;
	private workletModulePromise?: Promise<void>;
	private loadingPromise?: Promise<void>;
	private pendingDecoderLoad?: PendingDecoderLoad;
	private pendingReady?: PendingReady;

	private loadVersion = 0;
	private loadId = 0;
	private generation = 0;

	private durationMs = 0;
	private encoderDelayMs = 0;
	private outputChannels = 2;

	private _currentTime = 0;
	private startPending = false;
	private applyingBeatmapSeek = false;

	private clockBaseMs = 0;
	private clockBasePerfMs = 0;
	private clockLastAudioPerfMs = 0;
	private clockRate = 1;

	private lastSeekMs = 0;
	private lastUnderrunSeekMs = 0;
	private lastContextReviveMs = 0;

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();

		this.localGainNode = this.ctx.createGain();
		this.localGainNode.gain.value = this.configuredVolume();
		this.localGainNode.connect(masterNode);

		inject<AudioConfig>('config/audio')?.onChange('musicVolume', (value) => {
			if (this.state === 'PLAYING') this.fadeTo(value);
			else this.localGainNode.gain.value = value;
		});
	}

	get currentTime() {
		if (this.state === 'STOPPED') return this._currentTime;

		this.restartIfRateChanged();
		this.reviveFrozenContextIfNeeded();

		const timeMs = this.predictedFrameTimeMs();
		if (timeMs < this.durationMs) return timeMs;

		this.finishPlayback();
		return this.durationMs;
	}

	set currentTime(value: number) {
		const timeMs = this.clampTime(value);
		this.resetFrameClock(timeMs);

		if (this.applyingBeatmapSeek) return;
		if (this.state === 'PLAYING') void this.startAt(timeMs, this.playbackRate, false);
	}

	get playbackRate() {
		return this.beatmapSet.playbackRate ?? 1;
	}

	get duration() {
		return this.durationMs;
	}

	private get ctx() {
		return this.masterNode.context as AudioContext;
	}

	async createBufferNode(blob: Blob) {
		if (this.state === 'PLAYING') this.pause();

		inject<Loading>('ui/loading')?.setText('Loading audio...');

		const version = ++this.loadVersion;
		const promise = this.load(blob, version);
		this.loadingPromise = promise;

		try {
			await promise;
		} finally {
			if (this.loadingPromise === promise) this.loadingPromise = undefined;
		}
	}

	async toggle(event: UIEvent | null) {
		if (this.state === 'PLAYING') {
			this.pause();
			return;
		}

		if (event) await this.warmPlayableContext();
		await this.play();
	}

	async play() {
		if (this.state === 'PLAYING') throw new Error('Already playing');
		if (this.loadingPromise) throw new Error('Audio is still loading');
		if (!this.init) throw new Error('Audio not initialized');

		const rate = this.playbackRate;
		if (!(rate > 0)) throw new Error(`Invalid playback rate: ${rate}`);

		this.state = 'PLAYING';
		await this.ctx.resume();

		try {
			await this.startAt(this._currentTime, rate, true);
		} catch (error) {
			this.state = 'STOPPED';
			this.startPending = false;
			throw error;
		}
	}

	pause() {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		const timeMs = this.predictedFrameTimeMs();
		this.state = 'STOPPED';
		this.startPending = false;
		this.resetFrameClock(timeMs);

		const generation = ++this.generation;
		this.cancelPendingReady();
		this.engine?.node.port.postMessage({ type: 'pause', generation });
		this.engine?.node.port.postMessage(this.rendererResetMessage(generation, timeMs, this.clockRate));
		this.engine?.worker.postMessage({ type: 'cancel', generation });
		this.fadeTo(0);
	}

	destroy() {
		if (this.state === 'PLAYING') this.pause();

		this.loadVersion++;
		this.disposeInput();
		this.disposeEngine();
		this.localGainNode.disconnect();

		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.outputChannels = 2;
		this.init = false;
		this.resetFrameClock(0);
	}

	private async load(blob: Blob, version: number) {
		this.disposeInput();
		this.disposeEngine();

		this.init = false;
		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.outputChannels = 2;
		this.resetFrameClock(0);

		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS
		});

		const audioTrack = await input.getPrimaryAudioTrack();
		if (version !== this.loadVersion) return input.dispose();

		if (!audioTrack) {
			input.dispose();
			throw new Error('No primary audio track found');
		}

		if (!(await audioTrack.canDecode())) {
			input.dispose();
			throw new Error('Primary audio track cannot be decoded by this browser');
		}

		const durationSec = await input.computeDuration();
		if (version !== this.loadVersion) return input.dispose();

		this.input = input;
		this.sink = new AudioBufferSink(audioTrack);
		this.durationMs = Number.isFinite(durationSec) ? durationSec * 1000 : 0;
		this.encoderDelayMs = await getEncoderDelayMs(blob, audioTrack);
		this.outputChannels = Math.min(Math.max(audioTrack.numberOfChannels || 2, 1), 2);

		await this.ensureEngine(this.outputChannels);
		if (version !== this.loadVersion) return;

		await this.loadDecoder(blob);
		if (version !== this.loadVersion) return;

		this.init = true;
		this.resetFrameClock(0);
		this.createSpectrogram(durationSec, audioTrack);
	}

	private async ensureEngine(outputChannels: number) {
		this.workletModulePromise ??= this.ctx.audioWorklet.addModule(
			new URL('./AudioRenderer.worklet.ts', import.meta.url)
		);
		await this.workletModulePromise;

		const node = new AudioWorkletNode(this.ctx, 'beatmap-audio-renderer', {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [outputChannels]
		});

		const worker = new Worker(new URL('./AudioDecoder.worker.ts', import.meta.url), {
			type: 'module'
		});

		node.port.onmessage = (event: MessageEvent<RendererMessage>) => {
			this.handleRendererMessage(event.data);
		};

		worker.onmessage = (event: MessageEvent<DecoderMessage>) => {
			this.handleDecoderMessage(event.data);
		};

		worker.onerror = (event) => {
			this.failDecoderLoad(event.error ?? new Error(event.message));
		};

		const channel = new MessageChannel();
		node.port.postMessage({ type: 'decoder-port', port: channel.port1 }, [channel.port1]);
		worker.postMessage({ type: 'renderer-port', port: channel.port2 }, [channel.port2]);

		node.connect(this.localGainNode);
		this.engine = { node, worker };
	}

	private loadDecoder(blob: Blob) {
		const engine = this.engine;
		if (!engine) throw new Error('Audio engine not initialized');

		const loadId = ++this.loadId;

		const promise = new Promise<void>((resolve, reject) => {
			this.pendingDecoderLoad = { id: loadId, resolve, reject };
		});

		engine.worker.postMessage({
			type: 'load',
			loadId,
			blob,
			outputSampleRate: this.ctx.sampleRate,
			outputChannels: this.outputChannels,
			encoderDelayMs: this.encoderDelayMs
		});

		return promise;
	}

	private async startAt(timeMs: number, rate: number, syncBeatmap: boolean) {
		const engine = this.engine;
		if (!engine) throw new Error('Audio engine not initialized');
		if (!(rate > 0)) throw new Error(`Invalid playback rate: ${rate}`);

		const startMs = this.clampTime(timeMs);
		const generation = ++this.generation;
		const ready = this.waitForRendererReady(generation);

		this.startPending = true;
		this.clockRate = rate;
		this.resetFrameClock(startMs);
		this.fadeTo(0);

		engine.node.port.postMessage(this.rendererResetMessage(generation, startMs, rate));
		engine.worker.postMessage({
			type: 'seek',
			generation,
			timeMs: startMs,
			rate,
			preservePitch: true
		});

		await ready;
		if (generation !== this.generation || this.state !== 'PLAYING') return;

		await this.ctx.resume();
		if (generation !== this.generation || this.state !== 'PLAYING') return;

		this.resetFrameClock(startMs);
		engine.node.port.postMessage({ type: 'play', generation });
		this.fadeTo(this.configuredVolume());
		this.startPending = false;

		if (syncBeatmap) this.syncBeatmapSeek(startMs, true);
	}

	private waitForRendererReady(generation: number) {
		this.cancelPendingReady();

		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (this.pendingReady?.generation === generation) this.resolveRendererReady(generation);
			}, START_READY_TIMEOUT_MS);

			this.pendingReady = {
				generation,
				resolve: () => {
					clearTimeout(timeout);
					resolve();
				}
			};
		});
	}

	private rendererResetMessage(generation: number, baseMediaMs: number, rate: number) {
		return {
			type: 'reset' as const,
			generation,
			baseMediaMs,
			rate,
			sourceChannels: this.outputChannels,
			minStartFrames: Math.max(256, Math.ceil(MIN_START_SEC * this.ctx.sampleRate))
		};
	}

	private restartIfRateChanged() {
		if (this.state !== 'PLAYING' || this.startPending) return;

		const rate = this.playbackRate;
		if (!(rate > 0)) return;
		if (Math.abs(rate - this.clockRate) <= EPSILON_RATE) return;

		void this.startAt(this.predictedFrameTimeMs(), rate, true);
	}

	private predictedFrameTimeMs(nowPerf = performance.now()) {
		if (this.state === 'STOPPED' || this.startPending) return this._currentTime;

		let elapsedMs = Math.max(0, nowPerf - this.clockBasePerfMs);
		if (nowPerf - this.clockLastAudioPerfMs > CLOCK_STALE_MS) {
			elapsedMs = Math.max(0, this.clockLastAudioPerfMs - this.clockBasePerfMs) + MAX_STALE_EXTRAPOLATE_MS;
		}

		return this.clampTime(this.clockBaseMs + elapsedMs * this.clockRate);
	}

	private resetFrameClock(mediaMs: number, perfMs = performance.now()) {
		const timeMs = this.clampTime(mediaMs);

		this._currentTime = timeMs;
		this.clockBaseMs = timeMs;
		this.clockBasePerfMs = perfMs;
		this.clockLastAudioPerfMs = perfMs;
	}

	private rebaseFrameClock(mediaMs: number, perfMs = performance.now(), force = false) {
		let targetMs = this.clampTime(mediaMs);

		if (!force && this.state === 'PLAYING' && !this.startPending) {
			const predictedMs = this.predictedFrameTimeMs(perfMs);
			const errorMs = targetMs - predictedMs;

			if (Math.abs(errorMs) <= SOFT_REBASE_MS) {
				targetMs = predictedMs + errorMs * SOFT_REBASE_BLEND;
			}
		}

		this.resetFrameClock(targetMs, perfMs);
	}

	private mediaMsAtMainThreadNow(message: Extract<RendererMessage, { type: 'clock' | 'underrun' }>) {
		let mediaMs = message.mediaMs;
		const contextAdvanceMs = (this.ctx.currentTime - message.contextTimeSec) * 1000;

		if (
			Number.isFinite(contextAdvanceMs) &&
			contextAdvanceMs > 0 &&
			contextAdvanceMs < CLOCK_COMPENSATION_LIMIT_MS
		) {
			mediaMs += contextAdvanceMs * this.clockRate;
		}

		return this.clampTime(mediaMs);
	}

	private handleRendererMessage(message: RendererMessage) {
		if (message.generation !== this.generation) return;

		switch (message.type) {
			case 'ready':
				this.resolveRendererReady(message.generation);
				break;

			case 'clock':
				this.rebaseFrameClock(this.mediaMsAtMainThreadNow(message));
				if (message.ended && this.state === 'PLAYING' && message.bufferedFrames === 0) this.finishPlayback();
				break;

			case 'underrun':
				this.handleUnderrun(this.mediaMsAtMainThreadNow(message));
				break;

			case 'overflow':
				console.warn(`Audio renderer queue overflow (${message.bufferedFrames} frames buffered)`);
				break;
		}
	}

	private handleDecoderMessage(message: DecoderMessage) {
		switch (message.type) {
			case 'loaded':
				if (this.pendingDecoderLoad?.id === message.loadId) {
					this.pendingDecoderLoad.resolve();
					this.pendingDecoderLoad = undefined;
				}
				break;

			case 'error': {
				const error = new Error(message.message);
				if (message.stack) error.stack = message.stack;

				this.failDecoderLoad(error);
				this.cancelPendingReady();
				this.state = 'STOPPED';
				this.engine?.node.port.postMessage({ type: 'pause', generation: this.generation });
				console.error('Audio decoder worker failed:', error);
				break;
			}
		}
	}

	private resolveRendererReady(generation: number) {
		if (this.pendingReady?.generation !== generation) return;

		this.pendingReady.resolve();
		this.pendingReady = undefined;
	}

	private cancelPendingReady() {
		this.pendingReady?.resolve();
		this.pendingReady = undefined;
	}

	private failDecoderLoad(reason: unknown) {
		this.pendingDecoderLoad?.reject(reason);
		this.pendingDecoderLoad = undefined;
	}

	private handleUnderrun(mediaMs: number) {
		const now = performance.now();
		if (now - this.lastUnderrunSeekMs < UNDERRUN_SEEK_COOLDOWN_MS) return;

		this.lastUnderrunSeekMs = now;
		this.rebaseFrameClock(mediaMs, now, true);
		this.syncBeatmapSeek(mediaMs);
	}

	private syncBeatmapSeek(timeMs: number, force = false) {
		const now = performance.now();
		if (!force && now - this.lastSeekMs < SEEK_COOLDOWN_MS) return;

		this.lastSeekMs = now;
		this.applyingBeatmapSeek = true;

		try {
			this.beatmapSet.seek(this.clampTime(timeMs));
		} finally {
			this.applyingBeatmapSeek = false;
		}
	}

	private finishPlayback() {
		if (this.state !== 'PLAYING') return;

		this.syncBeatmapSeek(0, true);
		void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
	}

	private reviveFrozenContextIfNeeded() {
		if (this.state !== 'PLAYING') return;

		const now = performance.now();
		if (now - this.clockLastAudioPerfMs <= CLOCK_STALE_MS) return;
		if (now - this.lastContextReviveMs < CONTEXT_REVIVE_COOLDOWN_MS) return;

		this.lastContextReviveMs = now;
		this.reviveFrozenContext();
	}

	private reviveFrozenContext() {
		const ctx = this.ctx;
		const before = ctx.currentTime;

		void ctx.resume()
			.then(() => sleep(CONTEXT_FREEZE_CHECK_MS))
			.then(() => {
				if (this.state !== 'PLAYING') return;
				if (ctx.currentTime !== before) return;

				const timeMs = this.predictedFrameTimeMs();
				return ctx.suspend()
					.catch(() => undefined)
					.then(() => ctx.resume())
					.then(() => this.startAt(timeMs, this.playbackRate, true));
			})
			.catch(() => undefined);
	}

	private async warmPlayableContext() {
		const ctx = this.ctx;

		await ctx.resume();

		const before = ctx.currentTime;
		await sleep(0);
		await sleep(CONTEXT_FREEZE_CHECK_MS);

		if (ctx.currentTime !== before) return;

		await ctx.suspend().catch(() => undefined);
		await ctx.resume();
	}

	private fadeTo(value: number) {
		const gain = this.localGainNode.gain;
		const now = this.ctx.currentTime;

		gain.cancelScheduledValues(now);
		gain.setValueAtTime(gain.value, now);
		gain.linearRampToValueAtTime(value, now + FADE_SEC);
	}

	private configuredVolume() {
		return inject<AudioConfig>('config/audio')?.musicVolume ?? 0.8;
	}

	private clampTime(ms: number) {
		if (!Number.isFinite(ms) || ms < 0) return 0;
		if (this.durationMs > 0 && ms > this.durationMs) return this.durationMs;
		return ms;
	}

	private createSpectrogram(durationSec: number, audioTrack: InputAudioTrack) {
		if (!this.sink) return;

		this.spectrogram?.destroy();
		this.spectrogram = new SpectrogramProcessor({
			sink: this.sink,
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

		void this.spectrogram.render();
	}

	private disposeInput() {
		this.sink = undefined;

		this.input?.dispose();
		this.input = undefined;

		this.spectrogram?.destroy();
		this.spectrogram = undefined;
	}

	private disposeEngine() {
		this.cancelPendingReady();
		this.pendingDecoderLoad?.resolve();
		this.pendingDecoderLoad = undefined;

		this.engine?.node.port.postMessage({ type: 'dispose' });
		this.engine?.node.disconnect();
		this.engine?.worker.postMessage({ type: 'dispose' });
		this.engine?.worker.terminate();
		this.engine = undefined;

		this.startPending = false;
		this.generation++;
	}
}

const MP3_XING_MAGIC = 0x58696E67; // 'Xing'
const MP3_INFO_MAGIC = 0x496E666F; // 'Info'
const MP3_DELAY_PADDING_OFFSET_FROM_TAG = 141;
const MP3_DECODER_DELAY_SAMPLES = 528;
const DEFAULT_MP3_DELAY_MS = 25;

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isMp3Track(blob: Blob, audioTrack: InputAudioTrack) {
	const codec = ((audioTrack as any).codec || (audioTrack as any).format || blob.type).toLowerCase();
	return codec.includes('mp3') || codec.includes('mpeg');
}

async function getEncoderDelayMs(blob: Blob, audioTrack: InputAudioTrack) {
	if (!isMp3Track(blob, audioTrack)) return 0;

	const buffer = await blob.slice(0, 8192).arrayBuffer();
	const view = new DataView(buffer);
	const searchLimit = Math.min(2000, view.byteLength - 4);

	let tagOffset = -1;
	for (let i = 0; i < searchLimit; i++) {
		const magic = view.getUint32(i, false);
		if (magic === MP3_XING_MAGIC || magic === MP3_INFO_MAGIC) {
			tagOffset = i;
			break;
		}
	}

	if (tagOffset < 0) return DEFAULT_MP3_DELAY_MS;

	const delayPaddingOffset = tagOffset + MP3_DELAY_PADDING_OFFSET_FROM_TAG;
	if (delayPaddingOffset + 1 >= view.byteLength) return DEFAULT_MP3_DELAY_MS;

	const byte0 = view.getUint8(delayPaddingOffset);
	const byte1 = view.getUint8(delayPaddingOffset + 1);
	const encoderDelaySamples = (byte0 << 4) | (byte1 >> 4);
	const sampleRate = audioTrack.sampleRate || 44100;
	const delayMs = ((encoderDelaySamples + MP3_DECODER_DELAY_SAMPLES) / sampleRate) * 1000;

	console.log(`MP3 encoder delay: ${encoderDelaySamples} samples @ ${sampleRate}Hz = ${delayMs.toFixed(2)}ms`);
	return delayMs;
}
