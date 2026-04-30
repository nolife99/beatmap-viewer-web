/**
 * Decoder worker.
 * It owns Mediabunny decode/resample and keeps the SAB ring primed.
 * Pause does not cancel decode; the writer naturally blocks when the ring is full.
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
let token: FillToken = { cancelled: true, generation: 0 };

onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerInMessage;

	try {
		switch (msg.type) {
			case 'init':
				contextSampleRate = msg.contextSampleRate;
				ringWriter = new RingBufferWriter(msg.sabRing, RING_CHANNELS, RING_FRAME_CAPACITY);
				break;

			case 'load':
				await handleLoad(msg.blob, msg.encoderDelayMs);
				break;

			case 'play':
			case 'seek':
				startFill(msg.seekSec, msg.generation);
				break;

			case 'pause':
				// Keep filling until full. This makes resume after pause/paused-seek immediate.
				break;

			case 'stop':
				token.cancelled = true;
				break;

			case 'destroy':
				token.cancelled = true;
				disposeInput();
				self.close();
				break;
		}
	} catch (err) {
		post({ type: 'error', generation: token.generation, message: String(err) });
	}
};

async function handleLoad(blob: Blob, encoderDelayMs: number): Promise<void> {
	token.cancelled = true;
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

	post({
		type: 'loaded',
		sampleRate: track.sampleRate,
		numberOfChannels: track.numberOfChannels,
		encoderDelayMs
	});
}

function startFill(seekSec: number, generation: number): void {
	const writer = ringWriter;
	if (!writer || !currentSink) return;

	token.cancelled = true;
	token = { cancelled: false, generation };
	writer.resetForSeek(generation);
	void fillLoop(seekSec, token);
}

async function fillLoop(seekSec: number, localToken: FillToken): Promise<void> {
	const sink = currentSink;
	const writer = ringWriter;
	if (!sink || !writer) return;

	try {
		for await (const sample of sink.samples(seekSec)) {
			if (localToken.cancelled) {
				sample.close();
				break;
			}

			const channels = extractAndResample(sample);
			sample.close();
			if (!channels) continue;

			let written = 0;
			const totalFrames = channels[0].length;

			while (written < totalFrames && !localToken.cancelled) {
				const chunk = Math.min(totalFrames - written, RING_FRAME_CAPACITY >> 2);

				if (writer.write(channels, chunk, written)) {
					written += chunk;
				} else {
					await sleep(1);
				}
			}

			freeChannels(channels);
		}
	} catch (err) {
		if (!localToken.cancelled) {
			post({ type: 'error', generation: localToken.generation, message: String(err) });
		}
		return;
	}

	if (!localToken.cancelled) post({ type: 'ended', generation: localToken.generation });
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

	if (srcRate === contextSampleRate) return stereo;

	const resampled = [
		linearResample(stereo[0], srcFrames, srcRate, contextSampleRate),
		linearResample(stereo[1], srcFrames, srcRate, contextSampleRate)
	];

	freeChannels(stereo);
	return resampled;
}

function downmixToStereo(channels: Float32Array[], frameCount: number): Float32Array[] {
	const srcCh = channels.length;
	const left = mallocF32(frameCount);
	const right = mallocF32(frameCount);

	if (srcCh === 0) {
		left.fill(0);
		right.fill(0);
		return [left, right];
	}

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

	left.fill(0);
	right.fill(0);

	for (let i = 0; i < frameCount; i++) {
		let l = channels[0][i] + channels[2][i] * 0.7071067811865476;
		let r = channels[1][i] + channels[2][i] * 0.7071067811865476;

		if (srcCh > 4) l += channels[4][i] * 0.7071067811865476;
		if (srcCh > 5) r += channels[5][i] * 0.7071067811865476;

		for (let c = 6; c < srcCh; c++) {
			const v = channels[c][i] * 0.25;
			l += v;
			r += v;
		}

		left[i] = Math.max(-1, Math.min(1, l));
		right[i] = Math.max(-1, Math.min(1, r));
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
	const array = pool(Math.max(1, length), 'float32');
	if (!array) throw new Error(`Out of memory: ${length} f32s`);
	return array as Float32Array;
}

function freeChannels(channels: Float32Array[]): void {
	for (const ch of channels) pool.free(ch);
}

function post(msg: WorkerOutMessage): void {
	self.postMessage(msg);
}

type FillToken = { cancelled: boolean; generation: number };

type WorkerInMessage =
	| { type: 'init'; sabRing: SharedArrayBuffer; contextSampleRate: number }
	| { type: 'load'; blob: Blob; encoderDelayMs: number }
	| { type: 'play' | 'seek'; seekSec: number; generation: number }
	| { type: 'pause' | 'stop' | 'destroy' };

export type WorkerOutMessage =
	| { type: 'loaded'; sampleRate: number; numberOfChannels: number; encoderDelayMs: number }
	| { type: 'ended'; generation: number }
	| { type: 'error'; generation: number; message: string };
