/**
 * AudioDecoderWorker
 * ──────────────────
 * Owns the mediabunny Input + AudioSampleSink, decodes audio off the main
 * thread, resamples to the AudioContext sample rate when necessary, and
 * continuously feeds the SAB_RING shared ring buffer consumed by
 * ClockBridgeProcessor.
 *
 * Communication with the main thread is via postMessage (not SAB) because:
 *  - Commands (play/seek/pause) are rare, and latency requirements are loose
 *    compared to individual process() quanta.
 *  - It lets the Worker's JS event loop remain responsive for cancellation.
 *
 * Channel policy
 * ──────────────
 * The ring is always written with RING_CHANNELS (2) channels.  Mono source
 * tracks have their single channel duplicated.  Source tracks with >2 channels
 * are downmixed to the first two.
 */

import { ALL_FORMATS, AudioSample, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { RING_CHANNELS, RING_FRAME_CAPACITY, RingBufferWriter } from './RingBuffer.ts';
import { factory } from '@stdlib/array-pool';
import { sleep } from '../utils.ts';

const pool = factory();

let ringWriter: RingBufferWriter | null = null;
let contextSampleRate = 44_100;

let currentInput: Input | null = null;
let currentSink: AudioSampleSink | null = null;

let cancelToken = { cancelled: false };

onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerInMessage;

	switch (msg.type) {
		case 'init': {
			contextSampleRate = msg.contextSampleRate;
			ringWriter = new RingBufferWriter(msg.sabRing, RING_CHANNELS, RING_FRAME_CAPACITY);
			break;
		}

		case 'load':
			await handleLoad(msg.blob, msg.encoderDelayMs);
			break;

		case 'play':
		case 'seek': {
			cancelToken.cancelled = true;
			const token = (cancelToken = { cancelled: false });

			if (!ringWriter || !currentSink) break;

			ringWriter.resetForSeek(msg.generation);
			void fillLoop(msg.seekSec, token);

			break;
		}

		case 'pause':
		case 'stop':
			cancelToken.cancelled = true;
			break;

		case 'destroy':
			cancelToken.cancelled = true;
			disposeInput();
			self.close();
			break;
	}
};

async function handleLoad(blob: Blob, encoderDelayMs: number): Promise<void> {
	cancelToken.cancelled = true;
	disposeInput();

	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		input.dispose();
		throw new Error('No primary audio track found');
	}

	if (!(await track.canDecode())) {
		input.dispose();
		throw new Error('Track cannot be decoded');
	}

	currentInput = input;
	currentSink = new AudioSampleSink(track);

	const reply: WorkerOutMessage = {
		type: 'loaded',
		sampleRate: track.sampleRate,
		numberOfChannels: track.numberOfChannels,
		encoderDelayMs
	};
	self.postMessage(reply);
}

async function fillLoop(
	seekSec: number,
	token: { cancelled: boolean }
): Promise<void> {
	const sink = currentSink;
	const writer = ringWriter;
	if (!sink || !writer) return;

	try {
		for await (const sample of sink.samples(seekSec)) {
			if (token.cancelled) {
				sample.close();
				break;
			}

			const channels = extractAndResample(sample);
			sample.close();

			if (!channels) continue;

			const totalFrames = channels[0].length;
			let written = 0;

			while (written < totalFrames && !token.cancelled) {
				const chunkFrames = Math.min(totalFrames - written, RING_FRAME_CAPACITY >> 2);
				const slices = channels.map((ch) => ch.subarray(written, written + chunkFrames));

				if (!writer.write(slices, chunkFrames)) {
					await sleep(1);
					continue;
				}

				written += chunkFrames;
			}

			freeChannels(channels);
		}
	} catch (err) {
		if (!token.cancelled) {
			const reply: WorkerOutMessage = { type: 'error', message: String(err) };
			self.postMessage(reply);
			return;
		}
	}

	if (!token.cancelled) {
		const reply: WorkerOutMessage = { type: 'ended' };
		self.postMessage(reply);
	}
}

function extractAndResample(sample: AudioSample): Float32Array[] | null {
	const srcFrames = sample.numberOfFrames;
	if (srcFrames <= 0) return null;

	const srcRate = sample.sampleRate;
	const srcCh = sample.numberOfChannels;

	const raw: Float32Array[] = [];

	for (let c = 0; c < srcCh; c++) {
		const bytes = sample.allocationSize({ format: 'f32-planar', planeIndex: c });
		const buf = mallocF32(bytes >> 2);
		sample.copyTo(buf, { format: 'f32-planar', planeIndex: c });
		raw.push(buf);
	}

	const stereo = downmixToStereo(raw, srcFrames);
	freeChannels(raw);

	if (srcRate === contextSampleRate) {
		return stereo;
	}

	const resampled = [
		linearResample(stereo[0], srcFrames, srcRate, contextSampleRate),
		linearResample(stereo[1], srcFrames, srcRate, contextSampleRate)
	];

	freeChannels(stereo);
	return resampled;
}

function downmixToStereo(
	channels: Float32Array[],
	frameCount: number
): Float32Array[] {
	const srcCh = channels.length;
	const left = mallocF32(frameCount);
	const right = mallocF32(frameCount);

	left.fill(0);
	right.fill(0);

	if (srcCh === 0) return [left, right];

	if (srcCh === 1) {
		left.set(channels[0]);
		right.set(channels[0]);
		return [left, right];
	}

	if (srcCh === 2) {
		left.set(channels[0]);
		right.set(channels[1]);
		return [left, right];
	}

	const gainsL = new Float32Array(srcCh);
	const gainsR = new Float32Array(srcCh);

	// 0 = FL, 1 = FR, 2 = C, 3 = LFE, 4 = SL/BL, 5 = SR/BR, 6+ = fallback
	gainsL[0] = 1.0;
	gainsR[1] = 1.0;

	if (srcCh > 2) {
		gainsL[2] = 0.7071067811865476;
		gainsR[2] = 0.7071067811865476;
	}

	if (srcCh > 3) {
		gainsL[3] = 0;
		gainsR[3] = 0;
	}

	if (srcCh > 4) gainsL[4] = 0.7071067811865476;
	if (srcCh > 5) gainsR[5] = 0.7071067811865476;

	for (let c = 6; c < srcCh; c++) {
		const g = 0.5 / Math.sqrt(srcCh - 6 + 1);
		gainsL[c] = g;
		gainsR[c] = g;
	}

	let sumSqL = 0;
	let sumSqR = 0;

	for (let c = 0; c < srcCh; c++) {
		sumSqL += gainsL[c] * gainsL[c];
		sumSqR += gainsR[c] * gainsR[c];
	}

	const normL = sumSqL > 1 ? 1 / Math.sqrt(sumSqL) : 1;
	const normR = sumSqR > 1 ? 1 / Math.sqrt(sumSqR) : 1;

	for (let i = 0; i < frameCount; i++) {
		let l = 0;
		let r = 0;

		for (let c = 0; c < srcCh; c++) {
			const v = channels[c][i];
			l += v * gainsL[c];
			r += v * gainsR[c];
		}

		left[i] = l * normL;
		right[i] = r * normR;
	}

	return [left, right];
}

function linearResample(
	input: Float32Array,
	frameCount: number,
	inRate: number,
	outRate: number
): Float32Array {
	const ratio = inRate / outRate;
	const outLen = Math.round(frameCount / ratio);
	const out = mallocF32(outLen);
	const last = frameCount - 1;

	for (let i = 0; i < outLen; i++) {
		const src = i * ratio;
		const lo = src | 0;
		const t = src - lo;
		out[i] = input[lo] * (1 - t) + input[Math.min(lo + 1, last)] * t;
	}

	return out;
}

function disposeInput(): void {
	currentSink = null;
	currentInput?.dispose();
	currentInput = null;
}

function mallocF32(length: number): Float32Array {
	const array = pool(length, 'float32');
	if (!array) throw new Error(`Out of memory: ${length} f32s`);

	return array as Float32Array;
}

function freeChannels(channels: Float32Array[]): void {
	for (const ch of channels) pool.free(ch);
}

type WorkerInMessage =
	| { type: 'init'; sabRing: SharedArrayBuffer; contextSampleRate: number }
	| { type: 'load'; blob: Blob; encoderDelayMs: number }
	| { type: 'play'; seekSec: number; generation: number }
	| { type: 'seek'; seekSec: number; generation: number }
	| { type: 'pause' }
	| { type: 'stop' }
	| { type: 'destroy' };

export type WorkerOutMessage =
	| { type: 'loaded'; sampleRate: number; numberOfChannels: number; encoderDelayMs: number }
	| { type: 'ended' }
	| { type: 'error'; message: string };
