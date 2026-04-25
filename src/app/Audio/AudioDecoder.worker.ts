import {
	ALL_FORMATS,
	AudioSampleSink,
	BlobSource,
	Input,
	type AudioSample,
	type InputAudioTrack
} from 'mediabunny';
import { TimeStretcher } from './TimeStretcher.ts';

type MainMessage =
	| {
		type: 'renderer-port';
		port: MessagePort;
	}
	| {
		type: 'load';
		loadId: number;
		blob: Blob;
		outputSampleRate: number;
		outputChannels: number;
		encoderDelayMs: number;
	}
	| {
		type: 'seek';
		generation: number;
		timeMs: number;
		rate: number;
		preservePitch: boolean;
	}
	| {
		type: 'cancel';
		generation: number;
	}
	| {
		type: 'dispose';
	};

type RendererMessage =
	| {
		type: 'release';
		generation: number;
		buffer: ArrayBuffer;
		frames: number;
	};

type PlanarBlock = {
	channels: Float32Array[];
	frames: number;
	sampleRate: number;
};

const EPSILON_RATE = 1e-6;
const HIGH_WATER_SEC = 0.18;
const LOW_WATER_SEC = 0.05;
const MAX_RETURNED_BUFFERS = 96;

let rendererPort: MessagePort | undefined;

let input: Input | undefined;
let audioTrack: InputAudioTrack | null;
let sink: AudioSampleSink | undefined;
let iterator: AsyncGenerator<AudioSample, void, unknown> | undefined;

let outputSampleRate = 48000;
let outputChannels = 2;
let encoderDelayMs = 0;
let generation = 0;
let queuedFrames = 0;
let activeDecodePromise: Promise<void> | undefined;
let decodeWaiters: Array<() => void> = [];

class Float32Pool {
	private readonly buckets = new Map<number, Float32Array[]>();

	take(length: number): Float32Array {
		const capacity = nextPow2(Math.max(1, length));
		const bucket = this.buckets.get(capacity);
		const item = bucket?.pop();

		if (item) return item.subarray(0, length);
		return new Float32Array(capacity).subarray(0, length);
	}

	release(array: Float32Array): void {
		const root = new Float32Array(array.buffer);
		const capacity = root.length;
		let bucket = this.buckets.get(capacity);

		if (!bucket) {
			bucket = [];
			this.buckets.set(capacity, bucket);
		}

		if (bucket.length < MAX_RETURNED_BUFFERS) bucket.push(root);
	}

	clear(): void {
		this.buckets.clear();
	}
}

class TransferBufferPool {
	private readonly buffers: ArrayBuffer[] = [];

	take(requiredFloatCount: number): ArrayBuffer {
		const requiredBytes = nextPow2(Math.max(4, requiredFloatCount * 4));

		for (let i = this.buffers.length - 1; i >= 0; i--) {
			const buffer = this.buffers[i];
			if (buffer.byteLength >= requiredBytes) {
				this.buffers.splice(i, 1);
				return buffer;
			}
		}

		return new ArrayBuffer(requiredBytes);
	}

	release(buffer: ArrayBuffer): void {
		if (buffer.byteLength === 0) return;
		if (this.buffers.length < MAX_RETURNED_BUFFERS) this.buffers.push(buffer);
	}

	clear(): void {
		this.buffers.length = 0;
	}
}

const planarPool = new Float32Pool();
const transferPool = new TransferBufferPool();

self.onmessage = (event: MessageEvent<MainMessage>) => {
	const msg = event.data;

	switch (msg.type) {
		case 'renderer-port':
			rendererPort = msg.port;
			rendererPort.onmessage = (rendererEvent: MessageEvent<RendererMessage>) => {
				handleRendererMessage(rendererEvent.data);
			};
			rendererPort.start();
			break;

		case 'load':
			void load(msg).catch((err) => postError(err));
			break;

		case 'seek':
			void seek(msg).catch((err) => postError(err));
			break;

		case 'cancel':
			generation = msg.generation;
			queuedFrames = 0;
			void closeIterator();
			break;

		case 'dispose':
			generation++;
			void closeIterator();
			disposeInput();
			rendererPort?.close();
			rendererPort = undefined;
			planarPool.clear();
			transferPool.clear();
			break;
	}
};

async function load(msg: Extract<MainMessage, { type: 'load' }>): Promise<void> {
	generation++;
	await closeIterator();
	disposeInput();

	outputSampleRate = msg.outputSampleRate;
	outputChannels = Math.max(1, msg.outputChannels | 0);
	encoderDelayMs = msg.encoderDelayMs;

	input = new Input({
		source: new BlobSource(msg.blob),
		formats: ALL_FORMATS
	});

	audioTrack = await input.getPrimaryAudioTrack();

	if (!audioTrack) {
		throw new Error('No primary audio track found');
	}

	if (!(await audioTrack.canDecode())) {
		throw new Error('Primary audio track cannot be decoded by this browser');
	}

	sink = new AudioSampleSink(audioTrack);

	postMessage({
		type: 'loaded',
		loadId: msg.loadId,
		sampleRate: audioTrack.sampleRate,
		channels: audioTrack.numberOfChannels
	});
}

async function seek(msg: Extract<MainMessage, { type: 'seek' }>): Promise<void> {
	if (!sink || !audioTrack) throw new Error('Audio decoder is not loaded');
	if (!rendererPort) throw new Error('Audio renderer port is not connected');
	if (!(msg.rate > 0)) throw new Error(`Invalid playback rate: ${msg.rate}`);

	generation = msg.generation;
	queuedFrames = 0;
	await closeIterator();

	const promise = decodeLoop(msg.generation, msg.timeMs, msg.rate, msg.preservePitch);
	activeDecodePromise = promise;

	await promise.finally(() => {
		if (activeDecodePromise === promise) activeDecodePromise = undefined;
	});
}

async function decodeLoop(
	localGeneration: number,
	timeMs: number,
	rate: number,
	preservePitch: boolean
): Promise<void> {
	if (!sink || !audioTrack) return;

	const sourceStartSec = timeMs / 1000 + encoderDelayMs / 1000;
	const useStretcher = preservePitch && Math.abs(rate - 1) > EPSILON_RATE;
	const stretcher = useStretcher
		? new TimeStretcher(outputChannels, outputSampleRate, 1 / rate)
		: undefined;

	iterator = sink.samples(sourceStartSec);

	for await (const sample of iterator) {
		if (localGeneration !== generation) break;

		try {
			const trimmed = copyTrimmedSample(sample, sourceStartSec);
			if (!trimmed || trimmed.frames <= 0) continue;

			let contextRateBlock: PlanarBlock | undefined;

			if (preservePitch) {
				contextRateBlock = resamplePlanar(trimmed, outputSampleRate);
				if (contextRateBlock !== trimmed) releasePlanar(trimmed);

				if (stretcher) {
					const stretched = stretcher.append(contextRateBlock.channels);
					releasePlanar(contextRateBlock);

					if (!stretched?.[0]?.length) continue;

					sendPlanar(localGeneration, stretched, stretched[0].length);
				} else {
					sendPlanar(localGeneration, contextRateBlock.channels, contextRateBlock.frames);
					releasePlanar(contextRateBlock);
				}
			} else {
				const pitchShiftedRate = outputSampleRate / rate;
				contextRateBlock = resamplePlanar(trimmed, pitchShiftedRate);
				if (contextRateBlock !== trimmed) releasePlanar(trimmed);

				sendPlanar(localGeneration, contextRateBlock.channels, contextRateBlock.frames);
				releasePlanar(contextRateBlock);
			}

			await waitForBackpressure(localGeneration);
		} finally {
			sample.close();
		}
	}

	if (localGeneration === generation) {
		rendererPort?.postMessage({ type: 'end', generation: localGeneration });
	}
}

function copyTrimmedSample(sample: AudioSample, sourceStartSec: number): PlanarBlock | undefined {
	const sampleEndSec = sample.timestamp + sample.duration;
	if (sampleEndSec <= sourceStartSec) return undefined;

	const offsetFrames = Math.max(0, Math.floor((sourceStartSec - sample.timestamp) * sample.sampleRate));
	const frameCount = sample.numberOfFrames - offsetFrames;
	if (frameCount <= 0) return undefined;

	const channels = new Array<Float32Array>(outputChannels);

	for (let ch = 0; ch < outputChannels; ch++) {
		const srcPlane = Math.min(ch, sample.numberOfChannels - 1);
		const dst = planarPool.take(frameCount);

		sample.copyTo(dst, {
			format: 'f32-planar',
			planeIndex: srcPlane,
			frameOffset: offsetFrames,
			frameCount
		});

		channels[ch] = dst;
	}

	return {
		channels,
		frames: frameCount,
		sampleRate: sample.sampleRate
	};
}

function resamplePlanar(block: PlanarBlock, targetSampleRate: number): PlanarBlock {
	if (Math.abs(block.sampleRate - targetSampleRate) < 1) return block;

	const outFrames = Math.max(1, Math.floor((block.frames * targetSampleRate) / block.sampleRate));
	const ratio = block.sampleRate / targetSampleRate;
	const channels = new Array<Float32Array>(block.channels.length);

	for (let ch = 0; ch < block.channels.length; ch++) {
		const src = block.channels[ch];
		const dst = planarPool.take(outFrames);

		for (let i = 0; i < outFrames; i++) {
			const pos = i * ratio;
			const i0 = pos | 0;
			const i1 = Math.min(i0 + 1, block.frames - 1);
			const t = pos - i0;
			dst[i] = src[i0] + (src[i1] - src[i0]) * t;
		}

		channels[ch] = dst;
	}

	return {
		channels,
		frames: outFrames,
		sampleRate: targetSampleRate
	};
}

function sendPlanar(localGeneration: number, channels: Float32Array[], frames: number): void {
	if (localGeneration !== generation || frames <= 0) return;

	const channelCount = channels.length;
	const requiredSamples = frames * channelCount;
	const buffer = transferPool.take(requiredSamples);
	const interleaved = new Float32Array(buffer, 0, requiredSamples);

	let write = 0;
	for (let frame = 0; frame < frames; frame++) {
		for (let ch = 0; ch < channelCount; ch++) {
			interleaved[write++] = channels[ch][frame];
		}
	}

	queuedFrames += frames;

	rendererPort?.postMessage(
		{
			type: 'chunk',
			generation: localGeneration,
			buffer,
			frames,
			channels: channelCount,
			length: requiredSamples
		},
		[buffer]
	);
}

async function waitForBackpressure(localGeneration: number): Promise<void> {
	const highWaterFrames = Math.max(2048, Math.floor(HIGH_WATER_SEC * outputSampleRate));

	while (localGeneration === generation && queuedFrames > highWaterFrames) {
		await new Promise<void>((resolve) => decodeWaiters.push(resolve));
	}
}

function handleRendererMessage(msg: RendererMessage): void {
	if (msg.type !== 'release') return;

	transferPool.release(msg.buffer);

	if (msg.generation === generation) {
		queuedFrames = Math.max(0, queuedFrames - msg.frames);
		if (queuedFrames <= Math.floor(LOW_WATER_SEC * outputSampleRate)) {
			wakeDecodeWaiters();
		}
	}
}

function wakeDecodeWaiters(): void {
	const waiters = decodeWaiters;
	decodeWaiters = [];
	for (let i = 0; i < waiters.length; i++) waiters[i]();
}

async function closeIterator(): Promise<void> {
	const current = iterator;
	iterator = undefined;
	if (current?.return) {
		try {
			await current.return();
		} catch {
			// Ignore cancellation races from decoder shutdown.
		}
	}
	wakeDecodeWaiters();
}

function releasePlanar(block: PlanarBlock): void {
	for (let i = 0; i < block.channels.length; i++) {
		planarPool.release(block.channels[i]);
	}
}

function disposeInput(): void {
	sink = undefined;
	audioTrack = null;
	input?.dispose();
	input = undefined;
}

function postError(err: unknown): void {
	postMessage({
		type: 'error',
		message: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined
	});
}

function nextPow2(value: number): number {
	let n = 1;
	while (n < value) n *= 2;
	return n;
}
