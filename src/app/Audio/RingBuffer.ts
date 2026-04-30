/**
 * SPSC planar f32 ring: AudioDecoderWorker writes, AudioWorklet reads.
 * Header = [writeHead, readHead, generation, flags]. Heads are frame indices.
 */

export const RING_FRAME_CAPACITY = 8_192;
export const RING_CHANNELS = 2;

const H_WRITE = 0;
const H_READ = 1;
const H_GEN = 2;
const H_FLAGS = 3;
const HEADER_INT32S = 4;

export const RING_FLAG_UNDERRUN = 1;

export const CLOCK_SAB_BYTES = 32;
export const CLOCK_INT_SEQNO = 0;
export const CLOCK_INT_GEN = 1;
export const CLOCK_INT_PLAYING = 2;
export const CLOCK_INT_RATE_PPM = 3;
export const CLOCK_BIG_HW_TIME = 0;
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

	constructor(
		sab: SharedArrayBuffer,
		private readonly ch: number,
		private readonly cap: number
	) {
		this.hdr = new Int32Array(sab, 0, HEADER_INT32S);
		this.data = new Float32Array(sab, HEADER_INT32S * 4);
	}

	get availableWrite(): number {
		const rh = Atomics.load(this.hdr, H_READ);
		const wh = Atomics.load(this.hdr, H_WRITE);
		return this.cap - 1 - ((wh - rh + this.cap) % this.cap);
	}

	write(channels: Float32Array[], frameCount: number, srcOffset = 0): boolean {
		if (frameCount > this.availableWrite) return false;

		const wh = Atomics.load(this.hdr, H_WRITE);
		const part1 = Math.min(frameCount, this.cap - wh);
		const part2 = frameCount - part1;

		for (let c = 0; c < this.ch; c++) {
			const src = channels[c];
			const base = c * this.cap;

			this.data.set(src.subarray(srcOffset, srcOffset + part1), base + wh);
			if (part2 > 0) {
				this.data.set(src.subarray(srcOffset + part1, srcOffset + frameCount), base);
			}
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
		Atomics.notify(this.hdr, H_GEN, 1);
	}
}

export class RingBufferReader {
	readonly hdr: Int32Array;
	private readonly data: Float32Array;

	constructor(
		sab: SharedArrayBuffer,
		private readonly ch: number,
		private readonly cap: number
	) {
		this.hdr = new Int32Array(sab, 0, HEADER_INT32S);
		this.data = new Float32Array(sab, HEADER_INT32S * 4);
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
			this.underrun(output, frameCount);
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
			this.underrun(output, framesToPeek);
			return false;
		}

		const rh = Atomics.load(this.hdr, H_READ);
		this.copyOut(output, framesToPeek, rh);
		Atomics.store(this.hdr, H_READ, (rh + framesToConsume) % this.cap);
		Atomics.notify(this.hdr, H_READ, 1);
		return true;
	}

	private underrun(output: Float32Array[], frameCount: number): void {
		Atomics.or(this.hdr, H_FLAGS, RING_FLAG_UNDERRUN);
		for (let c = 0; c < this.ch; c++) output[c].fill(0, 0, frameCount);
	}

	private copyOut(dst: Float32Array[], n: number, rh: number): void {
		const part1 = Math.min(n, this.cap - rh);
		const part2 = n - part1;

		for (let c = 0; c < this.ch; c++) {
			const base = c * this.cap;
			dst[c].set(this.data.subarray(base + rh, base + rh + part1), 0);
			if (part2 > 0) dst[c].set(this.data.subarray(base, base + part2), part1);
		}
	}
}
