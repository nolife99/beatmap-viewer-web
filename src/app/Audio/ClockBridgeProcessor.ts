/// <reference types="@types/audioworklet" />

import { TimeStretcher } from './TimeStretcher.ts';
import {
	CLOCK_BIG_AUDIO_POS,
	CLOCK_BIG_HW_TIME,
	CLOCK_INT_GEN,
	CLOCK_INT_PLAYING,
	CLOCK_INT_SEQNO,
	RING_CHANNELS,
	RING_FRAME_CAPACITY,
	RingBufferReader
} from './RingBuffer.ts';

const WSOLA_FEED_CHUNK = 512;
const INITIAL_WSOLA_FIFO_CAPACITY = 4_096;
const INITIAL_SHIFT_SCRATCH_CAPACITY = 1_025;
const EPSILON_RATE = 1e-6;

class ClockBridgeProcessor extends AudioWorkletProcessor {
	private readonly ring: RingBufferReader;

	private readonly clockInt: Int32Array;
	private readonly clockBig: BigInt64Array;

	private rate = 1;
	private pitchMode: 'preserve' | 'shift' = 'preserve';
	private isPlaying = false;

	private userPosAtStartSec = 0;
	private currentGeneration = -1;

	private readonly quantum = 128;

	private emittedFrames = 0;

	private scratchCapacity = INITIAL_SHIFT_SCRATCH_CAPACITY;
	private scratch: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(INITIAL_SHIFT_SCRATCH_CAPACITY)
	);

	private readonly outBufs: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(0)
	);

	private stretcher?: TimeStretcher;

	private fifoCapacity = INITIAL_WSOLA_FIFO_CAPACITY;
	private fifoBuf: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(INITIAL_WSOLA_FIFO_CAPACITY)
	);

	private fifoWriteHead = 0;
	private fifoReadHead = 0;
	private fifoFilled = 0;

	private shiftPhase = 0;

	private readonly wsolaScratch: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(WSOLA_FEED_CHUNK)
	);

	constructor(options: AudioWorkletNodeOptions) {
		super();

		const { sabRing, sabClock } = options.processorOptions as {
			sabRing: SharedArrayBuffer;
			sabClock: SharedArrayBuffer;
		};

		this.ring = new RingBufferReader(sabRing, RING_CHANNELS, RING_FRAME_CAPACITY);
		this.clockInt = new Int32Array(sabClock, 0, 4);
		this.clockBig = new BigInt64Array(sabClock, 16, 2);

		this.port.onmessage = (e: MessageEvent) => {
			const msg = e.data as WorkletInMessage;
			switch (msg.type) {
				case 'play':
				case 'seek':
					this.rate = msg.rate;
					this.pitchMode = msg.pitchMode;
					this.userPosAtStartSec = msg.userPositionSec;
					this.emittedFrames = 0;
					this.isPlaying = true;
					break;

				case 'pause':
					this.isPlaying = false;
					break;

				case 'setRate':
					this.rate = msg.rate;
					this.pitchMode = msg.pitchMode;
					if (this.stretcher) this.stretcher.factor = 1 / msg.rate;
					break;
			}
		};
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0];
		if (!out || out.length === 0) return true;

		for (let c = 0; c < RING_CHANNELS; c++) {
			this.outBufs[c] = out[c];
		}

		const ringGen = this.ring.generation;
		if (ringGen !== this.currentGeneration) {
			this.stretcher?.dispose();
			this.stretcher = undefined;

			this.fifoWriteHead = 0;
			this.fifoReadHead = 0;
			this.fifoFilled = 0;
			this.shiftPhase = 0;
			this.emittedFrames = 0;
			this.currentGeneration = ringGen;
		}

		let emitted = 0;

		if (!this.isPlaying) {
			for (let c = 0; c < RING_CHANNELS; c++) {
				this.outBufs[c].fill(0);
			}
		} else if (Math.abs(this.rate - 1) <= EPSILON_RATE) {
			emitted = this.ring.read(this.outBufs, this.quantum) ? this.quantum : 0;
		} else if (this.pitchMode === 'preserve') {
			this.stretcher ??= new TimeStretcher(RING_CHANNELS, sampleRate, 1 / this.rate);
			this.stretcher.factor = 1 / this.rate;

			while (this.fifoFilled < this.quantum) {
				if (!this.ring.read(this.wsolaScratch, WSOLA_FEED_CHUNK)) break;

				const stretched = this.stretcher.append(this.wsolaScratch);
				if (stretched) this.fifoEnqueue(stretched);
			}

			const take = Math.min(this.quantum, this.fifoFilled);

			for (let c = 0; c < RING_CHANNELS; c++) {
				const src = this.fifoBuf[c];
				const dst = this.outBufs[c];
				const rh = this.fifoReadHead;
				const p1 = Math.min(take, this.fifoCapacity - rh);

				dst.set(src.subarray(rh, rh + p1), 0);
				if (p1 < take) dst.set(src.subarray(0, take - p1), p1);
				if (take < this.quantum) dst.fill(0, take, this.quantum);
			}

			this.fifoReadHead = (this.fifoReadHead + take) % this.fifoCapacity;
			this.fifoFilled -= take;

			emitted = take;
		} else {
			emitted = this.processShift();
		}

		this.emittedFrames += emitted;

		const hwNow = currentTime;

		const audioPosSec = this.isPlaying
			? this.userPosAtStartSec + (this.emittedFrames * this.rate) / sampleRate
			: this.userPosAtStartSec;

		const hwMicros = BigInt(Math.round(hwNow * 1_000_000));
		const audioMicros = BigInt(Math.round(audioPosSec * 1_000_000));

		const seq = Atomics.load(this.clockInt, CLOCK_INT_SEQNO);

		Atomics.store(this.clockInt, CLOCK_INT_SEQNO, seq | 1);
		Atomics.store(this.clockBig, CLOCK_BIG_HW_TIME, hwMicros);
		Atomics.store(this.clockBig, CLOCK_BIG_AUDIO_POS, audioMicros);
		Atomics.store(this.clockInt, CLOCK_INT_GEN, this.currentGeneration);
		Atomics.store(this.clockInt, CLOCK_INT_PLAYING, this.isPlaying ? 1 : 0);
		Atomics.store(this.clockInt, CLOCK_INT_SEQNO, seq + 2);

		return true;
	}

	private processShift(): number {
		const totalPhase = this.shiftPhase + this.quantum * this.rate;
		const framesConsumed = Math.floor(totalPhase);
		const framesToPeek = framesConsumed + 1;

		this.ensureScratchCapacity(framesToPeek);

		if (!this.ring.readAndConsume(this.scratch, framesToPeek, framesConsumed)) {
			this.shiftPhase = totalPhase - framesConsumed;
			return 0;
		}

		let phase = this.shiftPhase;

		for (let i = 0; i < this.quantum; i++) {
			const lo = phase | 0;
			const t = phase - lo;
			const hi = lo + 1;

			for (let c = 0; c < RING_CHANNELS; c++) {
				const src = this.scratch[c];
				this.outBufs[c][i] = src[lo] * (1 - t) + src[hi] * t;
			}

			phase += this.rate;
		}

		this.shiftPhase = totalPhase - framesConsumed;
		return this.quantum;
	}

	private ensureScratchCapacity(requiredFrames: number): void {
		if (requiredFrames <= this.scratchCapacity) return;

		let next = this.scratchCapacity;
		while (next < requiredFrames) next <<= 1;

		for (let c = 0; c < RING_CHANNELS; c++) {
			this.scratch[c] = new Float32Array(next);
		}

		this.scratchCapacity = next;
	}

	private fifoEnqueue(channels: Float32Array[]): void {
		const n = channels[0]?.length ?? 0;
		if (n <= 0) return;

		this.ensureFifoCapacity(n);

		for (let c = 0; c < RING_CHANNELS; c++) {
			const src = channels[c];
			const dst = this.fifoBuf[c];
			const wh = this.fifoWriteHead;
			const p1 = Math.min(n, this.fifoCapacity - wh);

			dst.set(src.subarray(0, p1), wh);
			if (p1 < n) dst.set(src.subarray(p1), 0);
		}

		this.fifoWriteHead = (this.fifoWriteHead + n) % this.fifoCapacity;
		this.fifoFilled += n;
	}

	private ensureFifoCapacity(extraFrames: number): void {
		const required = this.fifoFilled + extraFrames;
		if (required <= this.fifoCapacity) return;

		let next = this.fifoCapacity;
		while (next < required) next <<= 1;

		for (let c = 0; c < RING_CHANNELS; c++) {
			const old = this.fifoBuf[c];
			const fresh = new Float32Array(next);

			const rh = this.fifoReadHead;
			const p1 = Math.min(this.fifoFilled, this.fifoCapacity - rh);

			fresh.set(old.subarray(rh, rh + p1), 0);
			if (p1 < this.fifoFilled) {
				fresh.set(old.subarray(0, this.fifoFilled - p1), p1);
			}

			this.fifoBuf[c] = fresh;
		}

		this.fifoCapacity = next;
		this.fifoReadHead = 0;
		this.fifoWriteHead = this.fifoFilled;
	}
}

type WorkletInMessage =
	| {
	type: 'play' | 'seek';
	rate: number;
	pitchMode: 'preserve' | 'shift';
	userPositionSec: number;
}
	| {
	type: 'setRate';
	rate: number;
	pitchMode: 'preserve' | 'shift';
}
	| { type: 'pause' };

registerProcessor('clock-bridge-processor', ClockBridgeProcessor);