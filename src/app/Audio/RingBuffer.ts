/**
 * Lock-free ring buffer for transferring planar f32 audio frames from the
 * AudioDecoderWorker (writer) to the ClockBridgeProcessor AudioWorklet (reader)
 *
 * SAB_RING layout
 * ───────────────
 *  Bytes 0–15 Int32Array header [writeHead, readHead, generation, flags]
 *  Bytes 16+  Float32Array body [ch0 × capacity | ch1 × capacity | …]
 *
 * Both heads are frame indices in [0, capacity). Available frames to read =
 * (writeHead − readHead + capacity) % capacity. The −1 in available-to-write
 * prevents the buffer from being simultaneously "empty" and "full".
 *
 * Memory ordering
 * ───────────────
 * Atomics operations are sequentially consistent. All audio data written in
 * write() are committed before the writeHead store is visible to the reader,
 * and all reads in read() happen after the writeHead load. This is enough
 * for a single-producer / single-consumer ring.
 *
 * SAB_CLOCK layout (32 bytes, separate SAB)
 * ─────────────────────────────────────────
 *  Bytes 0–15     Int32Array [seqno, generation, isPlaying, _pad]
 *  Bytes 16–31 BigInt64Array [hardwareTimeMicros, audioPosMicros]
 *
 * seqno is odd while the worklet is writing and even otherwise (seqlock).
 * The main thread spins until it reads a stable even seqno.
 */

export const RING_FRAME_CAPACITY = 8_192;
export const RING_CHANNELS = 2;

// Header slot indices
const H_WRITE = 0;
const H_READ = 1;
const H_GEN = 2;
const H_FLAGS = 3;
const HEADER_INT32S = 4;

export const RING_FLAG_UNDERRUN = 1;

export const CLOCK_SAB_BYTES = 32;
export const CLOCK_INT_SEQNO = 0;   // Int32Array index
export const CLOCK_INT_GEN = 1;
export const CLOCK_INT_PLAYING = 2;
export const CLOCK_BIG_HW_TIME = 0;   // BigInt64Array index (byte offset 16)
export const CLOCK_BIG_AUDIO_POS = 1;

export function createRingSAB(
	numChannels: number = RING_CHANNELS,
	capacity: number = RING_FRAME_CAPACITY
): SharedArrayBuffer {
	return new SharedArrayBuffer(HEADER_INT32S * 4 + numChannels * capacity * 4);
}

export function createClockSAB(): SharedArrayBuffer {
	return new SharedArrayBuffer(CLOCK_SAB_BYTES);
}

export class RingBufferWriter {
	private readonly hdr: Int32Array;
	private readonly data: Float32Array;
	private readonly cap: number;
	private readonly ch: number;

	constructor(sab: SharedArrayBuffer, numChannels: number, capacity: number) {
		this.hdr = new Int32Array(sab, 0, HEADER_INT32S);
		this.data = new Float32Array(sab, HEADER_INT32S * 4);
		this.cap = capacity;
		this.ch = numChannels;
	}

	get availableWrite(): number {
		const rh = Atomics.load(this.hdr, H_READ);
		const wh = Atomics.load(this.hdr, H_WRITE);
		return (this.cap - 1) - ((wh - rh + this.cap) % this.cap);
	}

	write(channels: Float32Array[], frameCount: number): boolean {
		if (frameCount > this.availableWrite) return false;

		const wh = Atomics.load(this.hdr, H_WRITE);

		for (let c = 0; c < this.ch; c++) {
			const base = c * this.cap;
			const src = channels[c];
			const part1 = Math.min(frameCount, this.cap - wh);
			this.data.set(src.subarray(0, part1), base + wh);
			if (part1 < frameCount) this.data.set(src.subarray(part1), base);
		}

		Atomics.store(this.hdr, H_WRITE, (wh + frameCount) % this.cap);
		Atomics.notify(this.hdr, H_WRITE, 1);
		return true;
	}

	resetForSeek(generation: number): void {
		Atomics.store(this.hdr, H_FLAGS, 0);
		Atomics.store(this.hdr, H_READ, 0);
		Atomics.store(this.hdr, H_WRITE, 0);
		Atomics.store(this.hdr, H_GEN, generation);
	}
}

export class RingBufferReader {
	readonly hdr: Int32Array;
	private readonly data: Float32Array;
	private readonly cap: number;
	private readonly ch: number;

	constructor(sab: SharedArrayBuffer, numChannels: number, capacity: number) {
		this.hdr = new Int32Array(sab, 0, HEADER_INT32S);
		this.data = new Float32Array(sab, HEADER_INT32S * 4);
		this.cap = capacity;
		this.ch = numChannels;
	}

	get availableRead(): number {
		const wh = Atomics.load(this.hdr, H_WRITE);
		const rh = Atomics.load(this.hdr, H_READ);
		return (wh - rh + this.cap) % this.cap;
	}

	get generation(): number {
		return Atomics.load(this.hdr, H_GEN);
	}

	read(output: Float32Array[], frameCount: number): boolean {
		if (frameCount > this.availableRead) {
			Atomics.or(this.hdr, H_FLAGS, RING_FLAG_UNDERRUN);
			for (let c = 0; c < this.ch; c++) output[c].fill(0, 0, frameCount);
			return false;
		}
		const rh = Atomics.load(this.hdr, H_READ);
		this.copyOut(output, frameCount, rh);
		Atomics.store(this.hdr, H_READ, (rh + frameCount) % this.cap);
		Atomics.notify(this.hdr, H_READ, 1);
		return true;
	}

	readAndConsume(
		output: Float32Array[],
		framesToPeek: number,
		framesToConsume: number
	): boolean {
		if (framesToPeek > this.availableRead) {
			Atomics.or(this.hdr, H_FLAGS, RING_FLAG_UNDERRUN);
			for (let c = 0; c < this.ch; c++) output[c].fill(0, 0, framesToPeek);
			return false;
		}
		const rh = Atomics.load(this.hdr, H_READ);
		this.copyOut(output, framesToPeek, rh);
		Atomics.store(this.hdr, H_READ, (rh + framesToConsume) % this.cap);
		Atomics.notify(this.hdr, H_READ, 1);
		return true;
	}

	private copyOut(dst: Float32Array[], n: number, rh: number): void {
		for (let c = 0; c < this.ch; c++) {
			const base = c * this.cap;
			const part1 = Math.min(n, this.cap - rh);
			dst[c].set(this.data.subarray(base + rh, base + rh + part1), 0);
			if (part1 < n) dst[c].set(this.data.subarray(base, base + n - part1), part1);
		}
	}
}