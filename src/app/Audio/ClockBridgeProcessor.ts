/// <reference types="@types/audioworklet" />

import { TimeStretcher } from './TimeStretcher.ts';
import {
	CLOCK_BIG_AUDIO_POS,
	CLOCK_BIG_HW_TIME,
	CLOCK_INT_GEN,
	CLOCK_INT_PLAYING,
	CLOCK_INT_RATE_PPM,
	CLOCK_INT_SEQNO,
	RING_CHANNELS,
	RING_FRAME_CAPACITY,
	RingBufferReader
} from './RingBuffer.ts';

const WSOLA_FEED_CHUNK = 512;
const INITIAL_WSOLA_FIFO_CAPACITY = 4_096;
const INITIAL_SHIFT_SCRATCH_CAPACITY = 1_025;
const EPSILON_RATE = 1e-6;

type PitchMode = 'preserve' | 'shift';

class ClockBridgeProcessor extends AudioWorkletProcessor {
	private readonly ring: RingBufferReader;
	private readonly clockInt: Int32Array;
	private readonly clockBig: BigInt64Array;

	private rate = 1;
	private pitchMode: PitchMode = 'preserve';
	private isPlaying = false;

	private desiredGeneration = 0;
	private activeGeneration = -1;
	private timelineBaseSec = 0;
	private timelineFrames = 0;

	private scratchCapacity = INITIAL_SHIFT_SCRATCH_CAPACITY;
	private scratch: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(INITIAL_SHIFT_SCRATCH_CAPACITY)
	);

	private readonly outBufs: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(0)
	);

	private readonly stretcher = new TimeStretcher(RING_CHANNELS, sampleRate, 1);

	private fifoCapacity = INITIAL_WSOLA_FIFO_CAPACITY;
	private fifoBuf: Float32Array[] = Array.from(
		{ length: RING_CHANNELS },
		() => new Float32Array(INITIAL_WSOLA_FIFO_CAPACITY)
	);
	private fifoSourceAdvance = new Float32Array(INITIAL_WSOLA_FIFO_CAPACITY);

	private fifoWriteHead = 0;
	private fifoReadHead = 0;
	private fifoFilled = 0;
	private shiftPhase = 0;
	private clockRate = 0;

	private preservePipelineActive = false;
	private shiftPipelineActive = false;

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

		this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as WorkletInMessage);
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0];
		if (!out || out.length === 0 || !out[0]) return true;

		const quantum = out[0].length;
		for (let c = 0; c < RING_CHANNELS; c++) this.outBufs[c] = out[c];

		const ready = this.syncRingGeneration();
		let timelineAdvanceFrames = 0;

		if (!this.isPlaying || !ready || !(this.rate > 0)) {
			this.zero(quantum);
		} else if (this.shouldUseDirectPath()) {
			if (this.ring.read(this.outBufs, quantum)) timelineAdvanceFrames = quantum;
		} else if (this.pitchMode === 'preserve') {
			this.preservePipelineActive = true;
			timelineAdvanceFrames = this.processPreserve(quantum);
		} else {
			this.shiftPipelineActive = true;
			timelineAdvanceFrames = this.processShift(quantum) * this.rate;
		}

		if (timelineAdvanceFrames > 0) this.timelineFrames += timelineAdvanceFrames;
		this.clockRate = this.isPlaying && ready ? timelineAdvanceFrames / quantum : 0;
		this.writeClock();
		return true;
	}

	private handleMessage(msg: WorkletInMessage): void {
		switch (msg.type) {
			case 'seek':
			case 'prime':
				this.beginAt(msg.generation, msg.userPositionSec, msg.type !== 'prime', msg.rate, msg.pitchMode);
				break;

			case 'play':
				this.desiredGeneration = msg.generation;
				this.setRate(msg.rate, msg.pitchMode);
				this.isPlaying = true;
				this.writeClock();
				break;

			case 'pause':
				this.anchorTimeline();
				this.desiredGeneration = msg.generation;
				this.isPlaying = false;
				this.clockRate = 0;
				this.writeClock();
				break;

			case 'setRate':
				this.setRate(msg.rate, msg.pitchMode);
				break;
		}
	}

	private beginAt(
		generation: number,
		positionSec: number,
		playing: boolean,
		rate: number,
		pitchMode: PitchMode
	): void {
		this.desiredGeneration = generation;
		this.timelineBaseSec = positionSec;
		this.timelineFrames = 0;
		this.isPlaying = playing;
		this.setRate(rate, pitchMode, true);
		this.clockRate = 0;
		this.writeClock();
	}

	private anchorTimeline(): void {
		this.timelineBaseSec += this.timelineFrames / sampleRate;
		this.timelineFrames = 0;
	}

	private setRate(rate: number, pitchMode: PitchMode, forceReset = false): void {
		const safeRate = Math.max(rate, EPSILON_RATE);
		const modeChanged = pitchMode !== this.pitchMode;
		const rateChanged = Math.abs(safeRate - this.rate) > EPSILON_RATE;

		if (!forceReset && !modeChanged && !rateChanged) return;

		// Anchor exactly where the render thread applies the change.
		// Do not clear DSP state for same-mode rate changes; that discards
		// source frames already consumed into WSOLA/FIFO and causes desync.
		this.anchorTimeline();
		this.rate = safeRate;

		if (forceReset || modeChanged) {
			this.pitchMode = pitchMode;
			this.resetDSP();
		} else {
			this.pitchMode = pitchMode;
			this.stretcher.factor = 1 / safeRate;
		}
	}

	private syncRingGeneration(): boolean {
		const generation = this.ring.generation;
		if (generation !== this.activeGeneration) {
			this.activeGeneration = generation;
			this.resetDSP();
		}

		return generation === this.desiredGeneration;
	}

	private resetDSP(): void {
		this.shiftPhase = 0;
		this.clockRate = 0;
		this.preservePipelineActive = false;
		this.shiftPipelineActive = false;
		this.fifoReadHead = 0;
		this.fifoWriteHead = 0;
		this.fifoFilled = 0;
		this.stretcher.reset(1 / Math.max(this.rate, EPSILON_RATE));
	}

	private shouldUseDirectPath(): boolean {
		if (Math.abs(this.rate - 1) > EPSILON_RATE) return false;

		if (this.pitchMode === 'preserve') return !this.preservePipelineActive;
		return !this.shiftPipelineActive;
	}

	private processPreserve(quantum: number): number {
		this.stretcher.factor = 1 / this.rate;

		while (this.fifoFilled < quantum) {
			if (!this.ring.read(this.wsolaScratch, WSOLA_FEED_CHUNK)) break;

			const stretched = this.stretcher.appendDetailed(this.wsolaScratch);
			if (stretched) {
				this.fifoEnqueue(
					stretched.channels,
					stretched.sourceAdvanceFrames / Math.max(1, stretched.outputFrames)
				);
			}
		}

		const take = Math.min(quantum, this.fifoFilled);
		if (take <= 0) {
			this.zero(quantum);
			return 0;
		}

		const rh = this.fifoReadHead;
		const p1 = Math.min(take, this.fifoCapacity - rh);
		const p2 = take - p1;

		for (let c = 0; c < RING_CHANNELS; c++) {
			const src = this.fifoBuf[c];
			const dst = this.outBufs[c];

			dst.set(src.subarray(rh, rh + p1), 0);
			if (p2 > 0) dst.set(src.subarray(0, p2), p1);
			if (take < quantum) dst.fill(0, take, quantum);
		}

		let timelineAdvance = 0;
		for (let i = 0; i < p1; i++) timelineAdvance += this.fifoSourceAdvance[rh + i];
		for (let i = 0; i < p2; i++) timelineAdvance += this.fifoSourceAdvance[i];

		this.fifoReadHead = (rh + take) % this.fifoCapacity;
		this.fifoFilled -= take;
		return timelineAdvance;
	}

	private processShift(quantum: number): number {
		const totalPhase = this.shiftPhase + quantum * this.rate;
		const consume = Math.floor(totalPhase);
		const peek = consume + 1;

		this.ensureScratchCapacity(peek);

		if (!this.ring.readAndConsume(this.scratch, peek, consume)) {
			this.zero(quantum);
			return 0;
		}

		let phase = this.shiftPhase;
		for (let i = 0; i < quantum; i++) {
			const lo = phase | 0;
			const t = phase - lo;
			const hi = lo + 1;

			for (let c = 0; c < RING_CHANNELS; c++) {
				const src = this.scratch[c];
				this.outBufs[c][i] = src[lo] * (1 - t) + src[hi] * t;
			}

			phase += this.rate;
		}

		this.shiftPhase = totalPhase - consume;
		return quantum;
	}

	private fifoEnqueue(channels: Float32Array[], sourceAdvancePerOutputFrame: number): void {
		const n = channels[0]?.length ?? 0;
		if (n <= 0) return;

		this.ensureFifoCapacity(n);

		const wh = this.fifoWriteHead;
		const p1 = Math.min(n, this.fifoCapacity - wh);
		const p2 = n - p1;

		for (let c = 0; c < RING_CHANNELS; c++) {
			const src = channels[c];
			const dst = this.fifoBuf[c];

			dst.set(src.subarray(0, p1), wh);
			if (p2 > 0) dst.set(src.subarray(p1), 0);
		}

		this.fifoSourceAdvance.fill(sourceAdvancePerOutputFrame, wh, wh + p1);
		if (p2 > 0) this.fifoSourceAdvance.fill(sourceAdvancePerOutputFrame, 0, p2);

		this.fifoWriteHead = (wh + n) % this.fifoCapacity;
		this.fifoFilled += n;
	}

	private ensureFifoCapacity(extraFrames: number): void {
		const required = this.fifoFilled + extraFrames;
		if (required <= this.fifoCapacity) return;

		let next = this.fifoCapacity;
		while (next < required) next <<= 1;

		const rh = this.fifoReadHead;
		const p1 = Math.min(this.fifoFilled, this.fifoCapacity - rh);
		const p2 = this.fifoFilled - p1;

		for (let c = 0; c < RING_CHANNELS; c++) {
			const old = this.fifoBuf[c];
			const fresh = new Float32Array(next);

			fresh.set(old.subarray(rh, rh + p1), 0);
			if (p2 > 0) fresh.set(old.subarray(0, p2), p1);
			this.fifoBuf[c] = fresh;
		}

		const freshRate = new Float32Array(next);
		freshRate.set(this.fifoSourceAdvance.subarray(rh, rh + p1), 0);
		if (p2 > 0) freshRate.set(this.fifoSourceAdvance.subarray(0, p2), p1);
		this.fifoSourceAdvance = freshRate;

		this.fifoCapacity = next;
		this.fifoReadHead = 0;
		this.fifoWriteHead = this.fifoFilled;
	}

	private ensureScratchCapacity(requiredFrames: number): void {
		if (requiredFrames <= this.scratchCapacity) return;

		let next = this.scratchCapacity;
		while (next < requiredFrames) next <<= 1;

		for (let c = 0; c < RING_CHANNELS; c++) this.scratch[c] = new Float32Array(next);
		this.scratchCapacity = next;
	}

	private zero(frameCount: number): void {
		for (let c = 0; c < RING_CHANNELS; c++) this.outBufs[c].fill(0, 0, frameCount);
	}

	private writeClock(): void {
		const audioPosSec = this.timelineBaseSec + this.timelineFrames / sampleRate;
		const nextSeq = (Atomics.load(this.clockInt, CLOCK_INT_SEQNO) + 2) & ~1;

		Atomics.store(this.clockInt, CLOCK_INT_SEQNO, nextSeq | 1);
		Atomics.store(this.clockBig, CLOCK_BIG_HW_TIME, BigInt(Math.round(currentTime * 1_000_000)));
		Atomics.store(this.clockBig, CLOCK_BIG_AUDIO_POS, BigInt(Math.round(audioPosSec * 1_000_000)));
		Atomics.store(this.clockInt, CLOCK_INT_GEN, this.desiredGeneration);
		Atomics.store(this.clockInt, CLOCK_INT_PLAYING, this.isPlaying ? 1 : 0);
		Atomics.store(this.clockInt, CLOCK_INT_RATE_PPM, Math.round(Math.max(0, this.clockRate) * 1_000_000));
		Atomics.store(this.clockInt, CLOCK_INT_SEQNO, nextSeq);
	}
}

type SeekMessage = {
	type: 'seek' | 'prime';
	generation: number;
	rate: number;
	pitchMode: PitchMode;
	userPositionSec: number;
};

type PlayMessage = {
	type: 'play';
	generation: number;
	rate: number;
	pitchMode: PitchMode;
};

type WorkletInMessage =
	| SeekMessage
	| PlayMessage
	| {
		type: 'pause';
		generation: number;
	}
	| {
		type: 'setRate';
		rate: number;
		pitchMode: PitchMode;
	};

registerProcessor('clock-bridge-processor', ClockBridgeProcessor);
