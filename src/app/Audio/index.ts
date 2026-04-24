import pool from '@stdlib/array-pool';
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	type InputAudioTrack,
} from 'mediabunny';
import BeatmapSet from '../BeatmapSet/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import { inject, ScopedClass } from '../Context.ts';
import Loading from '../UI/loading/index.ts';
import { TimeStretcher } from './TimeStretcher.ts';

if ('audioSession' in navigator) {
	// @ts-expect-error WebKit-only API
	navigator.audioSession.type = 'playback';
}

type PitchMode = 'preserve' | 'shift';
type WrappedBufferLike = {
	buffer: AudioBuffer;
	timestamp: number;
};

type ScheduledNode = {
	node: AudioBufferSourceNode;
	stopAtContextSec: number;
};

const DESYNC_GUARD_MS = 250;
const SCHEDULE_AHEAD_SEC = 0.2;
const THROTTLE_INTERVAL_MS = 8;
const MAX_LATE_SKIP_SEC = 0.08;

export default class Audio extends ScopedClass {
	state: 'PLAYING' | 'STOPPED' = 'STOPPED';
	init = false;

	private readonly localGainNode: GainNode;
	private previousTimestamp = 0;
	private mediaSyncGuardUntil = 0;

	private input?: Input;
	private audioTrack?: InputAudioTrack;
	private sink?: AudioBufferSink;
	private audioBufferIterator?: AsyncGenerator<WrappedBufferLike, void, unknown>;

	private durationMs = 0;
	private loadingPromise?: Promise<void>;
	private loadVersion = 0;

	private _currentTime = 0;
	private encoderDelayMs = 0;

	private schedulerToken = 0;
	private readonly scheduledNodes: ScheduledNode[] = [];

	private wsolaScheduledUntilSec = 0;
	private pitchMode: PitchMode = 'preserve';
	private stretcher?: TimeStretcher;

	constructor(private masterNode: AudioNode, private beatmapSet: BeatmapSet) {
		super();

		this.localGainNode = masterNode.context.createGain();
		this.localGainNode.gain.value =
			inject<AudioConfig>('config/audio')?.musicVolume ?? 0.8;
		this.localGainNode.connect(this.masterNode);

		inject<AudioConfig>('config/audio')?.onChange('musicVolume', (val) => {
			this.localGainNode.gain.value = val;
		});
	}

	private get ctx() {
		return this.masterNode.context as AudioContext;
	}

	get currentTime() {
		if (this.state === 'STOPPED') return this._currentTime;

		const nowPerf = performance.now();
		const now = this._currentTime + (nowPerf - this.previousTimestamp) * this.playbackRate;

		if (nowPerf >= this.mediaSyncGuardUntil) {
			this.pruneFinishedNodes();
			this.mediaSyncGuardUntil = nowPerf + DESYNC_GUARD_MS;
		}

		if (now <= this.duration) return now;

		if (this.state === 'PLAYING') {
			this.beatmapSet.toggle().then(() => this.beatmapSet.seek(0));
		}

		return this.duration;
	}

	set currentTime(val: number) {
		const wasPlaying = this.state === 'PLAYING';
		if (wasPlaying) this.pause();

		this._currentTime = val >= 0 && val <= this.duration ? val : 0;
		this.mediaSyncGuardUntil = performance.now() + DESYNC_GUARD_MS;

		if (wasPlaying) this.play();
	}

	get playbackRate() {
		return this.beatmapSet.playbackRate ?? 1;
	}

	get duration() {
		return this.durationMs;
	}

	private createStretcher(rate: number) {
		this.stretcher = undefined;

		if (this.pitchMode !== 'preserve' || Math.abs(rate - 1) <= 1e-6) return;
		if (!this.audioTrack) throw new Error('Audio track not initialized');

		this.stretcher = new TimeStretcher(
			this.audioTrack.numberOfChannels,
			this.audioTrack.sampleRate,
			1 / rate,
		);
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

	private async stopIterator() {
		this.schedulerToken++;
		await this.audioBufferIterator?.return?.();
		this.audioBufferIterator = undefined;
	}

	private async throttleUntilNeedMore(token: number, scheduledUntilSec: number) {
		while (
			token === this.schedulerToken &&
			this.state === 'PLAYING' &&
			scheduledUntilSec - this.ctx.currentTime > SCHEDULE_AHEAD_SEC
			) {
			await new Promise<void>((resolve) => setTimeout(resolve, THROTTLE_INTERVAL_MS));
		}
	}

	private pooledFloat32(length: number): Float32Array {
		return pool.malloc(length, 'float32') as Float32Array;
	}

	private freePooledFloat32(array: Float32Array) {
		pool.free(array);
	}

	private copyChannelsFromAudioBufferPooled(buffer: AudioBuffer): Float32Array[] {
		const channels = new Array<Float32Array>(buffer.numberOfChannels);

		for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
			const src = buffer.getChannelData(ch);
			const copy = this.pooledFloat32(src.length);
			copy.set(src);
			channels[ch] = copy;
		}

		return channels;
	}

	private freeChannelArrays(channels?: Float32Array[] | null) {
		if (!channels) return;

		for (let i = 0; i < channels.length; i++) {
			this.freePooledFloat32(channels[i]);
		}

		channels.length = 0;
	}

	private createAudioBufferFromChannels(
		channels: Float32Array[],
		sampleRate: number,
	): AudioBuffer | null {
		const frameCount = channels[0]?.length ?? 0;
		if (frameCount <= 0) return null;

		const out = this.ctx.createBuffer(channels.length, frameCount, sampleRate);

		for (let ch = 0; ch < channels.length; ch++) {
			out.copyToChannel(channels[ch] as unknown as Float32Array<ArrayBuffer>, ch);
		}

		return out;
	}

	private scheduleBuffer(
		buffer: AudioBuffer,
		idealStartSec: number,
		playbackRate = 1,
	): number {
		const now = this.ctx.currentTime;
		let startAt = idealStartSec;
		let offsetSec = 0;

		if (startAt < now) {
			const lateBySec = now - startAt;
			offsetSec = lateBySec * playbackRate;

			if (offsetSec >= buffer.duration) return 0;
			if (lateBySec > MAX_LATE_SKIP_SEC) {
				console.warn(`Audio scheduler late by ${(lateBySec * 1000).toFixed(1)}ms`);
			}

			startAt = now;
		}

		const sourceDurationSec = buffer.duration - offsetSec;
		const outputDurationSec = sourceDurationSec / playbackRate;

		const node = this.ctx.createBufferSource();
		node.buffer = buffer;
		node.playbackRate.value = playbackRate;
		node.connect(this.localGainNode);
		node.start(startAt, offsetSec, sourceDurationSec);

		const stopAt = startAt + outputDurationSec;

		this.scheduledNodes.push({
			node,
			stopAtContextSec: stopAt,
		});

		node.onended = () => node.disconnect();
		return stopAt;
	}

	private scheduleWsolaBuffer(buffer: AudioBuffer, idealStartSec: number, rate: number): number {
		if (!this.stretcher) this.createStretcher(rate);
		if (!this.stretcher) return this.scheduleBuffer(buffer, idealStartSec, rate);

		this.stretcher.factor = 1 / rate;

		const inputChannels = this.copyChannelsFromAudioBufferPooled(buffer);
		let outputChannels: Float32Array[] | null = null;

		try {
			outputChannels = this.stretcher.append(inputChannels);
		} finally {
			this.freeChannelArrays(inputChannels);
		}

		if (!outputChannels?.[0]?.length) return 0;

		const stretched = this.createAudioBufferFromChannels(outputChannels, buffer.sampleRate);
		if (!stretched) return 0;

		const startAt = Math.max(idealStartSec, this.wsolaScheduledUntilSec);
		const stopAt = this.scheduleBuffer(stretched, startAt, 1);

		if (stopAt > 0) this.wsolaScheduledUntilSec = stopAt;
		return stopAt;
	}

	private async runAudioIterator(token: number) {
		if (!this.sink) throw new Error('Audio sink not initialized');

		await this.audioBufferIterator?.return?.();

		const rate = this.playbackRate;
		if (rate <= 0) throw new Error(`Invalid playback rate: ${rate}`);

		this.pitchMode = 'preserve';
		this.createStretcher(rate);

		const contextStartSec = this.ctx.currentTime;
		const mapStartSec = this._currentTime / 1000;
		const sourceStartSec = mapStartSec + this.encoderDelayMs / 1000;

		this.previousTimestamp = performance.now();
		this.mediaSyncGuardUntil = this.previousTimestamp + DESYNC_GUARD_MS;
		this.audioBufferIterator = this.sink.buffers(sourceStartSec) as AsyncGenerator<
			WrappedBufferLike,
			void,
			unknown
		>;

		let scheduledUntilSec = this.ctx.currentTime;

		for await (const wrapped of this.audioBufferIterator) {
			if (token !== this.schedulerToken || this.state !== 'PLAYING') break;

			this.pruneFinishedNodes();

			const currentRate = this.playbackRate;
			if (Math.abs(currentRate - rate) > 1e-6) {
				this._currentTime = this.currentTime;
				this.previousTimestamp = performance.now();

				this.stopScheduledNodes();
				this.wsolaScheduledUntilSec = this.ctx.currentTime;

				const newToken = ++this.schedulerToken;
				void this.runAudioIterator(newToken);
				return;
			}

			const idealStartSec = contextStartSec + (wrapped.timestamp - sourceStartSec) / rate;
			const scheduled =
				this.pitchMode === 'preserve' && Math.abs(rate - 1) > 1e-6
					? this.scheduleWsolaBuffer(wrapped.buffer, idealStartSec, rate)
					: this.scheduleBuffer(wrapped.buffer, idealStartSec, rate);

			if (scheduled > 0) scheduledUntilSec = Math.max(scheduledUntilSec, scheduled);
			await this.throttleUntilNeedMore(token, scheduledUntilSec);
		}
	}

	private disposeInput() {
		void this.stopIterator();
		this.stopScheduledNodes();

		this.sink = undefined;
		this.audioTrack = undefined;

		this.input?.dispose();
		this.input = undefined;
		this.stretcher = undefined;
	}

	async createBufferNode(blob: Blob) {
		if (this.state === 'PLAYING') this.pause();
		inject<Loading>('ui/loading')?.setText('Loading audio...');

		const loadVersion = ++this.loadVersion;

		this.loadingPromise = (async () => {
			this.disposeInput();

			this.init = false;
			this._currentTime = 0;
			this.durationMs = 0;
			this.encoderDelayMs = 0;
			this.mediaSyncGuardUntil = 0;

			const input = new Input({
				source: new BlobSource(blob),
				formats: ALL_FORMATS,
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
		})();

		try {
			await this.loadingPromise;
		} finally {
			this.loadingPromise = undefined;
		}
	}

	async toggle(event: UIEvent | null) {
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
		if (!this.input || !this.audioTrack || !this.sink) {
			throw new Error('Audio not initialized');
		}

		const rate = this.playbackRate;
		if (!(rate > 0)) throw new Error(`Invalid playback rate: ${rate}`);

		this.state = 'PLAYING';
		this.stopScheduledNodes();

		this.previousTimestamp = performance.now();
		this.mediaSyncGuardUntil = this.previousTimestamp + DESYNC_GUARD_MS;
		this.wsolaScheduledUntilSec = this.ctx.currentTime;

		const token = ++this.schedulerToken;

		void this.ctx.resume().then(() => {
			if (token !== this.schedulerToken || this.state !== 'PLAYING') return;

			this.runAudioIterator(token).catch((err) => {
				console.error('Audio scheduler failed:', err);
				if (this.state === 'PLAYING') this.pause();
			});
		});
	}

	pause() {
		if (this.state === 'STOPPED') throw new Error('Already stopped');

		this._currentTime = Math.min(
			this.duration,
			this._currentTime + (performance.now() - this.previousTimestamp) * this.playbackRate,
		);

		this.state = 'STOPPED';
		this.mediaSyncGuardUntil = 0;

		void this.stopIterator();
		this.stopScheduledNodes();
		this.wsolaScheduledUntilSec = this.ctx.currentTime;
		this.stretcher = undefined;
	}

	destroy() {
		if (this.state === 'PLAYING') this.pause();

		this.loadVersion++;
		this.disposeInput();
		this.localGainNode.disconnect();

		this.durationMs = 0;
		this.encoderDelayMs = 0;
		this.init = false;
	}
}

const MP3_XING_MAGIC = 0x58696E67; // 'Xing'
const MP3_INFO_MAGIC = 0x496E666F; // 'Info'
const MP3_DELAY_PADDING_OFFSET_FROM_TAG = 141;
const MP3_DECODER_DELAY_SAMPLES = 528;
const DEFAULT_MP3_DELAY_MS = 25;

function isMp3Track(blob: Blob, audioTrack: InputAudioTrack): boolean {
	const codecStr = (
		(audioTrack as any).codec ||
		(audioTrack as any).format ||
		blob.type
	).toLowerCase();

	return codecStr.includes('mp3') || codecStr.includes('mpeg');
}

async function getEncoderDelayMs(blob: Blob, audioTrack: InputAudioTrack): Promise<number> {
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