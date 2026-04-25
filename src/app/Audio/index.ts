import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import BeatmapSet from '../BeatmapSet/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import Loading from '../UI/loading/index.ts';
import { TimeStretcher } from './TimeStretcher.ts';
import SpectrogramProcessor from './SpectrogramProcessor.ts';
import SpectrogramContainer from '../UI/sidepanel/Modding/Spectrogram.ts';
import Beatmap from '../BeatmapSet/Beatmap/index.ts';

if ('audioSession' in navigator) {
	// @ts-expect-error Safari/WebKit API
	navigator.audioSession.type = 'playback';
}

type WrappedBufferLike = {
	buffer: AudioBuffer;
	timestamp: number;
};

type ScheduledNode = {
	node: AudioBufferSourceNode;
	stopAtContextSec: number;
};

const DESYNC_THRESHOLD_MS = 20;
const HARD_DESYNC_THRESHOLD_MS = 40;
const CONTEXT_FREEZE_CHECK_MS = 120;

const EPSILON_RATE = 1e-6;

export default class Audio extends ScopedClass {
	state: 'PLAYING' | 'STOPPED' = 'STOPPED';
	init = false;

	private readonly localGainNode: GainNode;

	private input?: Input;
	private audioTrack?: InputAudioTrack;
	private sink?: AudioBufferSink;
	private audioBufferIterator?: AsyncGenerator<WrappedBufferLike, void, unknown>;

	private durationMs = 0;
	private encoderDelayMs = 0;
	private loadingPromise?: Promise<void>;
	private loadVersion = 0;
	private mediaSessionPositionTimer: ReturnType<typeof setInterval> | undefined;

	private _currentTime = 0;
	private previousTimestamp = 0;
	private contextStartSec = 0;
	private lastClockCheckMs = 0;
	private lastContextReviveMs = 0;
	private desyncedFrames = 0;

	private schedulerToken = 0;
	private wsolaScheduledUntilSec = 0;
	private readonly scheduledNodes: ScheduledNode[] = [];
	private pitchMode: 'preserve' | 'shift' = 'preserve';
	private stretcher?: TimeStretcher;
	private spectrogram?: SpectrogramProcessor;

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();

		this.localGainNode = masterNode.context.createGain();
		this.localGainNode.gain.value =
			inject<AudioConfig>('config/audio')?.musicVolume ?? 0.8;
		this.localGainNode.connect(this.masterNode);

		inject<AudioConfig>('config/audio')?.onChange('musicVolume', (val) => {
			this.localGainNode.gain.value = val;
		});
		this.setupMediaSession();
	}

	get currentTime() {
		if (this.state === 'STOPPED') return this._currentTime;

		const now = this.predictedTimeMs();
		this.guardClock(now);

		if (now <= this.duration) return now;

		if (this.state === 'PLAYING') {
			this.requestSeek(0);
			void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
		}

		return this.duration;
	}

	set currentTime(val: number) {
		const wasPlaying = this.state === 'PLAYING';

		if (wasPlaying) this.pause();

		this._currentTime = this.clampTime(val);
		this.resetClockAnchors();

		if (wasPlaying) this.play();
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

	async createBufferNode(blob: Blob, beatmap: Beatmap) {
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
		if (!this.input || !this.audioTrack || !this.sink) throw new Error('Audio not initialized');
		if (!(this.playbackRate > 0)) throw new Error(`Invalid playback rate: ${this.playbackRate}`);

		this.state = 'PLAYING';
		this.stopScheduledNodes();
		this.resetClockAnchors();

		const token = ++this.schedulerToken;

		await this.ctx.resume();
		if (token !== this.schedulerToken || this.state !== 'PLAYING') return;

		this.resetClockAnchors();
		this.updateMediaSessionState();

		this.runAudioIterator(token).catch((err) => {
			if (token !== this.schedulerToken) return;
			console.error('Audio scheduler failed:', err);
			if (this.state === 'PLAYING') this.pause();
		});
	}

	pause() {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		this._currentTime = this.clampTime(this.predictedTimeMs());
		this.state = 'STOPPED';
		this.desyncedFrames = 0;

		void this.stopIterator();
		this.stopScheduledNodes();
		this.wsolaScheduledUntilSec = this.ctx.currentTime;
		this.disposeStretcher();
		this.updateMediaSessionState();
	}

	destroy() {
		if (this.state === 'PLAYING') this.pause();

		this.loadVersion++;
		this.disposeInput();
		this.localGainNode.disconnect();

		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.init = false;
		this._currentTime = 0;

		this.disposeMediaSession();
	}

	private async load(blob: Blob, loadVersion: number, beatmap: Beatmap) {
		this.disposeInput();

		this.init = false;
		this._currentTime = 0;
		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.desyncedFrames = 0;

		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS
		});

		const audioTrack = await input.getPrimaryAudioTrack();

		if (loadVersion !== this.loadVersion) {
			input.dispose();
			return;
		}

		if (!audioTrack) {
			input.dispose();
			throw new Error('No primary audio track found');
		}

		if (!(await audioTrack.canDecode())) {
			input.dispose();
			throw new Error('Primary audio track cannot be decoded by this browser');
		}

		const durationSec = await input.computeDuration();

		if (loadVersion !== this.loadVersion) {
			input.dispose();
			return;
		}

		this.input = input;
		this.audioTrack = audioTrack;
		this.sink = new AudioBufferSink(audioTrack);
		this.durationMs = Number.isFinite(durationSec) ? durationSec * 1000 : 0;
		this.encoderDelayMs = await getEncoderDelayMs(blob, audioTrack);
		this.init = true;

		this.updateMediaSessionState();

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

		if ('audioSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: beatmap.data.metadata.title,
				artist: beatmap.data.metadata.artistUnicode
			});

			navigator.mediaSession.setActionHandler('play', () => {
				void this.play();
			});

			navigator.mediaSession.setActionHandler('pause', () => {
				if (this.state === 'PLAYING') this.pause();
			});

			navigator.mediaSession.setActionHandler('seekto', (details) => {
				if (typeof details.seekTime === 'number') {
					this.beatmapSet.seek(details.seekTime * 1000);
				}
			});
		}
	}

	private predictedTimeMs() {
		return this._currentTime + (performance.now() - this.previousTimestamp) * this.playbackRate;
	}

	private clampTime(ms: number) {
		if (!Number.isFinite(ms) || ms < 0 || ms > this.duration) return 0;
		return ms;
	}

	private resetClockAnchors() {
		this.previousTimestamp = performance.now();
		this.contextStartSec = this.ctx.currentTime;
		this.lastClockCheckMs = 0;
	}

	private guardClock(predictedMs: number) {
		const nowPerf = performance.now();

		if (nowPerf - this.lastClockCheckMs < 80) return;
		this.lastClockCheckMs = nowPerf;
		this.pruneFinishedNodes();

		const perfElapsedMs = nowPerf - this.previousTimestamp;
		const ctxElapsedMs = (this.ctx.currentTime - this.contextStartSec) * 1000;
		const driftMs = (perfElapsedMs - ctxElapsedMs) * this.playbackRate;
		const absDriftMs = Math.abs(driftMs);

		if (absDriftMs <= DESYNC_THRESHOLD_MS) {
			this.desyncedFrames = 0;
			return;
		}

		this.desyncedFrames++;

		if (this.desyncedFrames === 3 || absDriftMs >= HARD_DESYNC_THRESHOLD_MS) {
			console.warn(`Audio desynced by ${driftMs.toFixed(1)}ms`);
		}

		if (driftMs > DESYNC_THRESHOLD_MS) this.reviveContext();

		if (this.desyncedFrames >= 20 || absDriftMs >= HARD_DESYNC_THRESHOLD_MS) {
			this.desyncedFrames = 0;
			this.requestSeek(predictedMs);
		}
	}

	private requestSeek(timeMs: number) {
		this.beatmapSet.seek(this.clampTime(timeMs));
	}

	private reviveContext() {
		const now = performance.now();

		if (now - this.lastContextReviveMs < 750) return;
		this.lastContextReviveMs = now;

		const ctx = this.ctx;
		const before = ctx.currentTime;

		void ctx.resume().then(() => sleep(CONTEXT_FREEZE_CHECK_MS)).then(() => {
			if (this.state !== 'PLAYING') return;
			if (ctx.currentTime !== before) return;

			return ctx.suspend()
				.catch(() => undefined)
				.then(() => ctx.resume())
				.then(() => this.requestSeek(this.predictedTimeMs()));
		}).catch(() => undefined);
	}

	private async warmPlayableContext() {
		const ctx = this.ctx;

		await ctx.resume();

		const before = ctx.currentTime;
		void sleep(CONTEXT_FREEZE_CHECK_MS).then(async () => {
			if (ctx.currentTime !== before) return;

			await ctx.suspend().catch(() => undefined);
			await ctx.resume();
		});
	}

	private createStretcher(rate: number) {
		this.disposeStretcher();

		if (this.pitchMode !== 'preserve' || Math.abs(rate - 1) <= EPSILON_RATE) return;
		if (!this.audioTrack) throw new Error('Audio track not initialized');

		this.stretcher = new TimeStretcher(
			this.audioTrack.numberOfChannels,
			this.audioTrack.sampleRate,
			1 / rate
		);
	}

	private disposeStretcher() {
		this.stretcher?.dispose();
		this.stretcher = undefined;
	}

	private async runAudioIterator(token: number) {
		if (!this.sink) throw new Error('Audio sink not initialized');

		const rate = this.playbackRate;
		if (!(rate > 0)) throw new Error(`Invalid playback rate: ${rate}`);

		await this.stopIterator(false);

		this.pitchMode = 'preserve';
		this.createStretcher(rate);

		const contextStartSec = this.ctx.currentTime;
		const sourceStartSec = this._currentTime / 1000 + this.encoderDelayMs / 1000;
		let scheduledUntilSec = contextStartSec;

		this.audioBufferIterator = this.sink.buffers(sourceStartSec) as AsyncGenerator<
			WrappedBufferLike,
			void,
			unknown
		>;

		for await (const wrapped of this.audioBufferIterator) {
			if (token !== this.schedulerToken || this.state !== 'PLAYING') break;

			const currentRate = this.playbackRate;
			if (Math.abs(currentRate - rate) > EPSILON_RATE) {
				this._currentTime = this.clampTime(this.predictedTimeMs());
				this.stopScheduledNodes();
				this.wsolaScheduledUntilSec = this.ctx.currentTime;

				const newToken = ++this.schedulerToken;
				void this.runAudioIterator(newToken);
				return;
			}

			this.pruneFinishedNodes();

			const idealStartSec = contextStartSec + (wrapped.timestamp - sourceStartSec) / rate;
			const stopAt = this.scheduleDecodedBuffer(wrapped.buffer, idealStartSec, rate);

			if (stopAt > 0) scheduledUntilSec = Math.max(scheduledUntilSec, stopAt);

			await this.waitForScheduleBudget(token, scheduledUntilSec);
		}
	}

	private scheduleDecodedBuffer(buffer: AudioBuffer, idealStartSec: number, rate: number) {
		if (this.pitchMode === 'preserve' && Math.abs(rate - 1) > EPSILON_RATE) {
			return this.scheduleStretchedBuffer(buffer, idealStartSec, rate);
		}

		return this.scheduleBuffer(buffer, idealStartSec, rate);
	}

	private scheduleStretchedBuffer(buffer: AudioBuffer, idealStartSec: number, rate: number) {
		if (!this.stretcher) this.createStretcher(rate);
		if (!this.stretcher) return this.scheduleBuffer(buffer, idealStartSec, rate);

		this.stretcher.factor = 1 / rate;

		const outputChannels = this.stretcher.appendAudioBuffer(buffer);
		const stretched = outputChannels?.[0]?.length
			? this.createAudioBufferFromChannels(outputChannels, buffer.sampleRate)
			: null;

		if (!stretched) return 0;

		const startAt = Math.max(idealStartSec, this.wsolaScheduledUntilSec);
		const stopAt = this.scheduleBuffer(stretched, startAt, 1);

		if (stopAt > 0) this.wsolaScheduledUntilSec = stopAt;
		return stopAt;
	}

	private scheduleBuffer(buffer: AudioBuffer, idealStartSec: number, playbackRate = 1) {
		const now = this.ctx.currentTime;
		let startAt = idealStartSec;
		let offsetSec = 0;

		if (startAt < now) {
			const lateBySec = now - startAt;
			offsetSec = lateBySec * playbackRate;

			if (offsetSec >= buffer.duration) return 0;
			if (lateBySec > 0.08) {
				console.warn(`Audio scheduler late by ${(lateBySec * 1000).toFixed(1)}ms`);
			}

			startAt = now;
		}

		const sourceDurationSec = buffer.duration - offsetSec;
		const outputDurationSec = sourceDurationSec / playbackRate;
		const stopAt = startAt + outputDurationSec;
		const node = this.ctx.createBufferSource();

		node.buffer = buffer;
		node.playbackRate.value = playbackRate;
		node.connect(this.localGainNode);
		node.start(startAt, offsetSec, sourceDurationSec);
		node.onended = () => node.disconnect();

		this.scheduledNodes.push({ node, stopAtContextSec: stopAt });

		return stopAt;
	}

	private get scheduleAheadSec() {
		return document.hidden ? 20 : 0.08;
	}

	private get schedulerSleepMs() {
		return document.hidden ? 250 : 8;
	}

	private async waitForScheduleBudget(token: number, scheduledUntilSec: number) {
		while (
			token === this.schedulerToken &&
			this.state === 'PLAYING' &&
			scheduledUntilSec - this.ctx.currentTime > this.scheduleAheadSec
			) {
			await sleep(this.schedulerSleepMs);
		}
	}

	private async stopIterator(incrementToken = true) {
		if (incrementToken) this.schedulerToken++;

		const iterator = this.audioBufferIterator;
		this.audioBufferIterator = undefined;

		await iterator?.return?.();
	}

	private stopScheduledNodes() {
		for (const { node } of this.scheduledNodes) {
			try {
				node.stop();
			} catch {
				// Already stopped.
			}

			node.disconnect();
		}

		this.scheduledNodes.length = 0;
	}

	private pruneFinishedNodes() {
		const now = this.ctx.currentTime;
		let write = 0;

		for (let i = 0; i < this.scheduledNodes.length; i++) {
			const item = this.scheduledNodes[i];

			if (item.stopAtContextSec <= now) {
				item.node.disconnect();
				continue;
			}

			this.scheduledNodes[write++] = item;
		}

		this.scheduledNodes.length = write;
	}

	private createAudioBufferFromChannels(channels: Float32Array[], sampleRate: number) {
		const frameCount = channels[0]?.length ?? 0;
		if (frameCount <= 0) return null;

		const out = this.ctx.createBuffer(channels.length, frameCount, sampleRate);

		for (let ch = 0; ch < channels.length; ch++) {
			out.copyToChannel(channels[ch] as unknown as Float32Array<ArrayBuffer>, ch);
		}

		return out;
	}

	private setupMediaSession() {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.metadata = new MediaMetadata({
			title: 'Beatmap audio',
			artist: '',
			album: '',
		});

		navigator.mediaSession.setActionHandler('play', () => {
			if (this.state !== 'PLAYING') void this.play();
		});

		navigator.mediaSession.setActionHandler('pause', () => {
			if (this.state === 'PLAYING') this.pause();
		});

		navigator.mediaSession.setActionHandler('stop', () => {
			if (this.state === 'PLAYING') this.pause();

			this._currentTime = 0;
			this.resetClockAnchors();
			this.beatmapSet.seek(0);
			this.updateMediaSessionState();
		});

		navigator.mediaSession.setActionHandler('seekto', (details) => {
			if (typeof details.seekTime !== 'number') return;

			const targetMs = this.clampTime(details.seekTime * 1000);
			this.beatmapSet.seek(targetMs);
			this.updateMediaSessionState();
		});

		navigator.mediaSession.setActionHandler('seekbackward', (details) => {
			const offsetSec = details.seekOffset ?? 10;
			const targetMs = this.clampTime(this.mediaSessionTimeMs() - offsetSec * 1000);

			this.beatmapSet.seek(targetMs);
			this.updateMediaSessionState();
		});

		navigator.mediaSession.setActionHandler('seekforward', (details) => {
			const offsetSec = details.seekOffset ?? 10;
			const targetMs = this.clampTime(this.mediaSessionTimeMs() + offsetSec * 1000);

			this.beatmapSet.seek(targetMs);
			this.updateMediaSessionState();
		});

		this.updateMediaSessionState();
	}

	private updateMediaSessionState() {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = this.mediaSessionPlaybackState();
		this.updateMediaSessionPosition();

		if (this.state === 'PLAYING') {
			this.startMediaSessionPositionTimer();
		} else {
			this.stopMediaSessionPositionTimer();
		}
	}

	private mediaSessionPlaybackState(): MediaSessionPlaybackState {
		if (!this.init || !this.audioTrack || !this.sink) return 'none';
		return this.state === 'PLAYING' ? 'playing' : 'paused';
	}

	private updateMediaSessionPosition() {
		if (!('mediaSession' in navigator)) return;
		if (!('setPositionState' in navigator.mediaSession)) return;
		if (!this.init || !(this.durationMs > 0)) return;

		try {
			navigator.mediaSession.setPositionState({
				duration: this.durationMs / 1000,
				playbackRate: this.playbackRate,
				position: this.mediaSessionTimeMs() / 1000,
			});
		} catch {
			// Safari/Chrome may reject invalid/edge position states during load/teardown
		}
	}

	private mediaSessionTimeMs() {
		return this.state === 'PLAYING'
			? this.clampTime(this.predictedTimeMs())
			: this._currentTime;
	}

	private startMediaSessionPositionTimer() {
		if (this.mediaSessionPositionTimer !== undefined) return;

		this.mediaSessionPositionTimer = setInterval(() => {
			this.updateMediaSessionPosition();
		}, 1000);
	}

	private stopMediaSessionPositionTimer() {
		if (this.mediaSessionPositionTimer === undefined) return;

		clearInterval(this.mediaSessionPositionTimer);
		this.mediaSessionPositionTimer = undefined;
	}

	private disposeMediaSession() {
		this.stopMediaSessionPositionTimer();

		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.playbackState = 'none';

		try {
			navigator.mediaSession.setPositionState();
		} catch {
			// Some browsers do not like clearing position state.
		}

		navigator.mediaSession.setActionHandler('play', null);
		navigator.mediaSession.setActionHandler('pause', null);
		navigator.mediaSession.setActionHandler('stop', null);
		navigator.mediaSession.setActionHandler('seekto', null);
		navigator.mediaSession.setActionHandler('seekbackward', null);
		navigator.mediaSession.setActionHandler('seekforward', null);
	}

	private disposeInput() {
		void this.stopIterator();
		this.stopScheduledNodes();

		this.sink = undefined;
		this.audioTrack = undefined;

		this.input?.dispose();
		this.input = undefined;

		this.disposeStretcher();

		this.spectrogram?.destroy();
		this.spectrogram = undefined;
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
	const codecStr = (
		(audioTrack as any).codec ||
		(audioTrack as any).format ||
		blob.type
	).toLowerCase();

	return codecStr.includes('mp3') || codecStr.includes('mpeg');
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
	const delay = ((encoderDelaySamples + MP3_DECODER_DELAY_SAMPLES) / sampleRate) * 1000;

	console.log(`MP3 encoder delay: ${encoderDelaySamples} samples @ ${sampleRate}Hz = ${delay.toFixed(2)}ms`);
	return delay;
}