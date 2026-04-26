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

const DESYNC_THRESHOLD_MS = 20;
const HARD_DESYNC_THRESHOLD_MS = 40;
const CLOCK_GUARD_INTERVAL_MS = 80;
const CONTEXT_FREEZE_CHECK_MS = 120;
const CONTEXT_REVIVE_COOLDOWN_MS = 750;
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
	private mediaSessionPositionTimer?: ReturnType<typeof setInterval>;

	private _currentTime = 0;
	private previousTimestamp = 0;
	private contextStartSec = 0;
	private lastClockCheckMs = 0;
	private lastContextReviveMs = 0;
	private desyncedFrames = 0;

	private schedulerToken = 0;
	private wsolaScheduledUntilSec = 0;
	private readonly scheduledNodes = new Set<AudioBufferSourceNode>();

	private pitchMode: 'preserve' | 'shift' = 'preserve';
	private stretcher?: TimeStretcher;
	private spectrogram?: SpectrogramProcessor;

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();

		this.localGainNode = this.ctx.createGain();
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

		this.requestSeek(0);
		void this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
		return this.duration;
	}

	set currentTime(val: number) {
		const wasPlaying = this.state === 'PLAYING';

		if (wasPlaying) this.pause();

		this._currentTime = this.clampTime(val);
		this.resetClockAnchors();

		if (wasPlaying) void this.play();
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

	private assertPlayable() {
		if (!this.input || !this.audioTrack || !this.sink) throw new Error('Audio not initialized');
		if (!(this.playbackRate > 0)) throw new Error(`Invalid playback rate: ${this.playbackRate}`);
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
		this.assertPlayable();

		this.state = 'PLAYING';
		this.stopScheduledNodes();
		this.resetClockAnchors();

		const token = ++this.schedulerToken;

		await this.ctx.resume();
		if (!this.isSchedulerActive(token)) return;

		this.resetClockAnchors();
		this.updateMediaSessionState();

		void this.runAudioIterator(token).catch((err) => {
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
		this.resetLoadedState();
		this.disposeMediaSession();
	}

	private async load(blob: Blob, loadVersion: number, beatmap: Beatmap) {
		this.disposeInput();
		this.resetLoadedState();

		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS,
		});

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
			throw new Error('Primary audio track cannot be decoded by this browser');
		}

		const [durationSec, encoderDelayMs] = await Promise.all([
			input.computeDuration(),
			getEncoderDelayMs(blob, track),
		]);

		if (this.disposeIfStale(loadVersion, input)) return;

		this.input = input;
		this.audioTrack = track;
		this.sink = new AudioBufferSink(track);
		this.durationMs = Number.isFinite(durationSec) ? durationSec * 1000 : 0;
		this.encoderDelayMs = encoderDelayMs;
		this.init = true;

		if ('mediaSession' in navigator) {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: beatmap.data.metadata.title,
				artist: beatmap.data.metadata.artistUnicode,
			});
		}

		this.updateMediaSessionState();
		this.renderSpectrogram(this.sink, durationSec, track);
	}

	private resetLoadedState() {
		this.init = false;
		this._currentTime = 0;
		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.desyncedFrames = 0;
	}

	private disposeIfStale(loadVersion: number, input: Input) {
		if (loadVersion === this.loadVersion) return false;

		input.dispose();
		return true;
	}
	private renderSpectrogram(sink: AudioBufferSink, durationSec: number, audioTrack: InputAudioTrack) {
		this.spectrogram?.destroy();
		this.spectrogram = new SpectrogramProcessor({
			sink,
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
			},
		});

		void this.spectrogram.render();
	}

	private predictedTimeMs() {
		return this._currentTime + (performance.now() - this.previousTimestamp) * this.playbackRate;
	}

	private clampTime(ms: number) {
		return Number.isFinite(ms) && ms >= 0 && ms <= this.durationMs ? ms : 0;
	}

	private resetClockAnchors() {
		this.previousTimestamp = performance.now();
		this.contextStartSec = this.ctx.currentTime;
		this.lastClockCheckMs = 0;
	}

	private guardClock(predictedMs: number) {
		const now = performance.now();

		if (now - this.lastClockCheckMs < CLOCK_GUARD_INTERVAL_MS) return;
		this.lastClockCheckMs = now;

		const perfElapsedMs = now - this.previousTimestamp;
		const ctxElapsedMs = (this.ctx.currentTime - this.contextStartSec) * 1000;
		const driftMs = (perfElapsedMs - ctxElapsedMs) * this.playbackRate;
		const absDriftMs = Math.abs(driftMs);

		if (absDriftMs <= DESYNC_THRESHOLD_MS) {
			this.desyncedFrames = 0;
			return;
		}

		if (++this.desyncedFrames === 3 || absDriftMs >= HARD_DESYNC_THRESHOLD_MS) {
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

		if (now - this.lastContextReviveMs < CONTEXT_REVIVE_COOLDOWN_MS) return;
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
					.then(() => this.requestSeek(this.predictedTimeMs()));
			})
			.catch(() => undefined);
	}

	private async warmPlayableContext() {
		const ctx = this.ctx;

		await ctx.resume();

		const before = ctx.currentTime;
		void sleep(CONTEXT_FREEZE_CHECK_MS)
			.then(() => ctx.currentTime === before ? ctx.suspend().catch(() => undefined) : undefined)
			.then(() => ctx.currentTime === before ? ctx.resume() : undefined);
	}

	private createStretcher(rate: number) {
		this.disposeStretcher();

		if (this.pitchMode !== 'preserve' || Math.abs(rate - 1) <= EPSILON_RATE) return;
		if (!this.audioTrack) throw new Error('Audio track not initialized');

		this.stretcher = new TimeStretcher(
			this.audioTrack.numberOfChannels,
			this.audioTrack.sampleRate,
			1 / rate,
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
		this.createStretcher(rate);

		const contextStartSec = this.ctx.currentTime;
		const sourceStartSec = this._currentTime / 1000 + this.encoderDelayMs / 1000;
		let scheduledUntilSec = contextStartSec;
		this.wsolaScheduledUntilSec = contextStartSec;

		this.audioBufferIterator = this.sink.buffers(sourceStartSec) as AsyncGenerator<
			WrappedBufferLike,
			void,
			unknown
		>;

		for await (const wrapped of this.audioBufferIterator) {
			if (!this.isSchedulerActive(token)) break;

			if (Math.abs(this.playbackRate - rate) > EPSILON_RATE) {
				this.restartSchedulerFromCurrentClock();
				return;
			}

			const idealStartSec = contextStartSec + (wrapped.timestamp - sourceStartSec) / rate;
			const stopAt = this.scheduleDecodedBuffer(wrapped.buffer, idealStartSec, rate);

			if (stopAt > 0) scheduledUntilSec = Math.max(scheduledUntilSec, stopAt);

			await this.waitForScheduleBudget(token, scheduledUntilSec);
		}
	}

	private restartSchedulerFromCurrentClock() {
		this._currentTime = this.clampTime(this.predictedTimeMs());
		this.stopScheduledNodes();
		this.wsolaScheduledUntilSec = this.ctx.currentTime;

		const token = ++this.schedulerToken;
		void this.runAudioIterator(token);
	}

	private scheduleDecodedBuffer(buffer: AudioBuffer, idealStartSec: number, rate: number) {
		return this.pitchMode === 'preserve' && Math.abs(rate - 1) > EPSILON_RATE
			? this.scheduleStretchedBuffer(buffer, idealStartSec, rate)
			: this.scheduleBuffer(buffer, idealStartSec, rate);
	}

	private scheduleStretchedBuffer(buffer: AudioBuffer, idealStartSec: number, rate: number) {
		if (!this.stretcher) this.createStretcher(rate);
		if (!this.stretcher) return this.scheduleBuffer(buffer, idealStartSec, rate);

		this.stretcher.factor = 1 / rate;

		const channels = this.stretcher.appendAudioBuffer(buffer);
		const stretched = channels?.[0]?.length
			? this.createAudioBufferFromChannels(channels, buffer.sampleRate)
			: null;

		if (!stretched) return 0;

		const startAt = Math.max(idealStartSec, this.wsolaScheduledUntilSec);
		const stopAt = this.scheduleBuffer(stretched, startAt);

		if (stopAt > 0) this.wsolaScheduledUntilSec = stopAt;
		return stopAt;
	}

	private scheduleBuffer(buffer: AudioBuffer, idealStartSec: number, playbackRate = 1) {
		const now = this.ctx.currentTime;
		const lateBySec = Math.max(0, now - idealStartSec);
		const offsetSec = lateBySec * playbackRate;

		if (offsetSec >= buffer.duration) return 0;
		if (lateBySec > 0.08) {
			console.warn(`Audio scheduler late by ${(lateBySec * 1000).toFixed(1)}ms`);
		}

		const startAt = Math.max(idealStartSec, now);
		const sourceDurationSec = buffer.duration - offsetSec;
		const stopAt = startAt + sourceDurationSec / playbackRate;
		const node = this.ctx.createBufferSource();

		node.buffer = buffer;
		node.playbackRate.value = playbackRate;
		node.connect(this.localGainNode);
		node.onended = () => {
			node.disconnect();
			this.scheduledNodes.delete(node);
		};
		node.start(startAt, offsetSec, sourceDurationSec);

		this.scheduledNodes.add(node);
		return stopAt;
	}

	private async waitForScheduleBudget(token: number, scheduledUntilSec: number) {
		while (
			this.isSchedulerActive(token) &&
			scheduledUntilSec - this.ctx.currentTime > (document.hidden ? 20 : 0.08)
		) {
			await sleep(document.hidden ? 250 : 8);
		}
	}

	private isSchedulerActive(token: number) {
		return token === this.schedulerToken && this.state === 'PLAYING';
	}

	private async stopIterator(incrementToken = true) {
		if (incrementToken) this.schedulerToken++;

		const iterator = this.audioBufferIterator;
		this.audioBufferIterator = undefined;

		await iterator?.return?.();
	}

	private stopScheduledNodes() {
		for (const node of this.scheduledNodes) {
			node.onended = null;

			try {
				node.stop();
			} catch {
				// Already stopped.
			}

			node.disconnect();
		}

		this.scheduledNodes.clear();
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
			if (this.state !== 'PLAYING' && this.init) void this.play().catch(() => undefined);
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
			if (typeof details.seekTime === 'number') this.seekFromMediaSession(details.seekTime * 1000);
		});

		navigator.mediaSession.setActionHandler('seekbackward', (details) => {
			this.seekFromMediaSession(this.mediaSessionTimeMs() - (details.seekOffset ?? 10) * 1000);
		});

		navigator.mediaSession.setActionHandler('seekforward', (details) => {
			this.seekFromMediaSession(this.mediaSessionTimeMs() + (details.seekOffset ?? 10) * 1000);
		});

		this.updateMediaSessionState();
	}

	private seekFromMediaSession(timeMs: number) {
		this.beatmapSet.seek(this.clampTime(timeMs));
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
		return this.init && this.audioTrack && this.sink
			? this.state === 'PLAYING'
				? 'playing'
				: 'paused'
			: 'none';
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
			// Safari/Chrome may reject invalid/edge position states during load/teardown.
		}
	}

	private mediaSessionTimeMs() {
		return this.state === 'PLAYING'
			? this.clampTime(this.predictedTimeMs())
			: this._currentTime;
	}

	private startMediaSessionPositionTimer() {
		this.mediaSessionPositionTimer ??= setInterval(() => {
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

		for (const action of ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward'] as const) {
			navigator.mediaSession.setActionHandler(action, null);
		}
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

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const MP3_XING_MAGIC = 0x58696e67; // 'Xing'
const MP3_INFO_MAGIC = 0x496e666f; // 'Info'
const MP3_DELAY_OFFSET_FROM_XING = 0x8d;
const MP3_DECODER_DELAY_SAMPLES = 528;
const DEFAULT_MP3_DELAY_MS = 25;
const MP3_PROBE_BYTES = 256 * 1024;

async function getEncoderDelayMs(blob: Blob, audioTrack: InputAudioTrack) {
	const view = new DataView(await blob.slice(0, MP3_PROBE_BYTES).arrayBuffer());
	const xingOffset = findXingOffset(view);
	const isMp3 = hasMp3CodecHint(blob, audioTrack) || xingOffset >= 0 || findMp3FrameOffset(view) >= 0;

	if (!isMp3) return 0;
	if (xingOffset < 0) return defaultMp3DelayMs(audioTrack, 'no Xing/Info tag');

	const encoderDelaySamples = readLameEncoderDelaySamples(view, xingOffset);
	if (encoderDelaySamples < 0) return defaultMp3DelayMs(audioTrack, 'no LAME delay field');

	const sampleRate = audioTrack.sampleRate || 44100;
	const delay = ((encoderDelaySamples + MP3_DECODER_DELAY_SAMPLES) / sampleRate) * 1000;

	console.log(`MP3 encoder delay: ${encoderDelaySamples} samples @ ${sampleRate}Hz = ${delay.toFixed(2)}ms`);
	return delay;
}

function hasMp3CodecHint(blob: Blob, audioTrack: InputAudioTrack) {
	const codec = (audioTrack.codec || blob.type).toLowerCase();
	return codec.includes('mp3') || codec.includes('mpeg');
}

function findXingOffset(view: DataView) {
	const frameOffset = findMp3FrameOffset(view);
	const expectedOffset = frameOffset < 0 ? -1 : getExpectedXingOffset(view, frameOffset);

	if (isXingMagicAt(view, expectedOffset)) return expectedOffset;

	const start = Math.max(0, skipId3v2(view));
	const end = view.byteLength - MP3_DELAY_OFFSET_FROM_XING - 3;

	for (let i = start; i <= end; i++) {
		if (isXingMagicAt(view, i)) return i;
	}

	return -1;
}

function findMp3FrameOffset(view: DataView) {
	const start = Math.max(0, skipId3v2(view));
	const end = view.byteLength - 4;

	for (let i = start; i <= end; i++) {
		if (isMp3FrameHeader(view.getUint32(i, false))) return i;
	}

	return -1;
}

function isMp3FrameHeader(header: number) {
	const version = (header >>> 19) & 3;
	const layer = (header >>> 17) & 3;
	const bitrate = (header >>> 12) & 0xf;
	const sampleRate = (header >>> 10) & 3;

	return (header & 0xffe00000) === 0xffe00000 &&
		version !== 1 &&
		layer === 1 &&
		bitrate !== 0 &&
		bitrate !== 0xf &&
		sampleRate !== 3;
}

function getExpectedXingOffset(view: DataView, frameOffset: number) {
	if (frameOffset + 4 > view.byteLength) return -1;

	const header = view.getUint32(frameOffset, false);
	const version = (header >>> 19) & 3;
	const channelMode = (header >>> 6) & 3;
	const sideInfoBytes = version === 3
		? channelMode === 3 ? 17 : 32
		: channelMode === 3 ? 9 : 17;

	return frameOffset + 4 + sideInfoBytes;
}

function isXingMagicAt(view: DataView, offset: number) {
	if (offset < 0 || offset + 4 > view.byteLength) return false;

	const magic = view.getUint32(offset, false);
	return magic === MP3_XING_MAGIC || magic === MP3_INFO_MAGIC;
}

function skipId3v2(view: DataView) {
	if (view.byteLength < 10) return 0;
	if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;

	const size =
		(view.getUint8(6) << 21) |
		(view.getUint8(7) << 14) |
		(view.getUint8(8) << 7) |
		view.getUint8(9);

	return 10 + size + ((view.getUint8(5) & 0x10) ? 10 : 0);
}

function readLameEncoderDelaySamples(view: DataView, xingOffset: number) {
	const offset = xingOffset + MP3_DELAY_OFFSET_FROM_XING;
	if (offset + 3 > view.byteLength) return -1;

	const raw = (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
	const encoderDelaySamples = raw >>> 12;
	const encoderPaddingSamples = raw & 0xfff;

	return encoderDelaySamples || encoderPaddingSamples ? encoderDelaySamples : -1;
}

function defaultMp3DelayMs(audioTrack: InputAudioTrack, reason: string) {
	console.log(`MP3 encoder delay: using ${DEFAULT_MP3_DELAY_MS}ms fallback (${reason}) @ ${audioTrack.sampleRate || 44100}Hz`);
	return DEFAULT_MP3_DELAY_MS;
}
