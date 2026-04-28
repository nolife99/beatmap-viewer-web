import pool from '@stdlib/array-pool';

/**
 * Utility class for performing time stretching on a multichannel audio signal. The input audio will be stretched by
 * a configurable factor without changing its pitch.
 *
 * Internally, this uses a WSOLA-like algorithm.
 * Credits to Vanilagy: https://gist.github.com/Vanilagy/05f7901f4c4398356657e3a86c7aee05
 */
export class TimeStretcher {
	factor: number; // This value can be changed at runtime

	private readonly numberOfChannels: number;
	private readonly synthesisHopSize: number;
	private readonly windowSize: number;
	private readonly overlapSize: number;
	private readonly tolerance: number;
	private readonly blendValues: Float32Array;

	private buffers: Float32Array[];
	private outputBuffers: Float32Array[];

	private bufferLength: number;
	private bufferEndIndex: number;
	private outputBufferLength: number;
	private nextOutputBufferShiftAmount: number;

	private hasDoneOutput: boolean;
	private finalized: boolean;
	private disposed: boolean;

	constructor(numberOfChannels: number, sampleRate: number, factor: number) {
		this.numberOfChannels = numberOfChannels;
		this.synthesisHopSize = Math.floor((512 * sampleRate) / 48000);
		this.windowSize = 2 * this.synthesisHopSize;
		this.overlapSize = this.synthesisHopSize;
		this.tolerance = this.synthesisHopSize;
		this.factor = factor;

		this.bufferLength = 2 ** 16;
		this.outputBufferLength = 2 ** 16;
		this.bufferEndIndex = this.tolerance;
		this.nextOutputBufferShiftAmount = 0;

		this.hasDoneOutput = false;
		this.finalized = false;
		this.disposed = false;

		this.buffers = new Array<Float32Array>(numberOfChannels);
		this.outputBuffers = new Array<Float32Array>(numberOfChannels);

		for (let i = 0; i < numberOfChannels; i++) {
			this.buffers[i] = mallocFloat32(this.bufferLength);
			this.outputBuffers[i] = mallocFloat32(this.outputBufferLength);
		}

		this.blendValues = mallocFloat32(this.overlapSize);
		for (let i = 0; i < this.overlapSize; i++) {
			this.blendValues[i] = 0.5 * (1 - Math.cos((Math.PI * i) / this.overlapSize));
		}
	}

	append(newBuffers: Float32Array[]): Float32Array[] | null {
		this.assertWritable();

		if (newBuffers.length !== this.numberOfChannels) {
			throw new Error(`Expected ${this.numberOfChannels} channels, got ${newBuffers.length}.`);
		}

		const frameCount = newBuffers[0]?.length ?? 0;
		if (frameCount <= 0) return null;

		this.ensureInputBufferLength(this.bufferEndIndex + frameCount);

		for (let i = 0; i < this.numberOfChannels; i++) {
			const newBuffer = newBuffers[i];

			if (newBuffer.length !== frameCount) {
				throw new Error('All channel buffers must have the same length.');
			}

			this.buffers[i].set(newBuffer, this.bufferEndIndex);
		}

		this.bufferEndIndex += frameCount;
		return this.process();
	}

	finalize(): Float32Array[] | null {
		this.assertAlive();

		if (this.finalized) return null;
		this.finalized = true;

		if (this.bufferEndIndex <= this.tolerance) {
			return null;
		}

		this.clearOutputBuffers();

		const synthesisLength = this.bufferEndIndex - this.tolerance;
		this.ensureOutputBufferLength(synthesisLength);

		this.synthesizeSegment(0, synthesisLength, this.tolerance, 0);

		return this.outputSlices(synthesisLength);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		for (let i = 0; i < this.buffers.length; i++) {
			freeFloat32(this.buffers[i]);
		}

		for (let i = 0; i < this.outputBuffers.length; i++) {
			freeFloat32(this.outputBuffers[i]);
		}

		freeFloat32(this.blendValues);

		this.buffers = [];
		this.outputBuffers = [];

		this.bufferLength = 0;
		this.outputBufferLength = 0;
		this.bufferEndIndex = 0;
		this.nextOutputBufferShiftAmount = 0;
	}

	private ensureInputBufferLength(requiredLength: number): void {
		if (requiredLength <= this.bufferLength) return;

		const nextLength = nextPow2Capacity(this.bufferLength, requiredLength);

		for (let i = 0; i < this.numberOfChannels; i++) {
			const oldBuffer = this.buffers[i];
			const largerBuffer = mallocFloat32(nextLength);

			largerBuffer.set(oldBuffer.subarray(0, this.bufferEndIndex), 0);
			freeFloat32(oldBuffer);

			this.buffers[i] = largerBuffer;
		}

		this.bufferLength = nextLength;
	}

	private ensureOutputBufferLength(requiredLength: number): void {
		if (requiredLength <= this.outputBufferLength) return;

		const nextLength = nextPow2Capacity(this.outputBufferLength, requiredLength);

		for (let i = 0; i < this.numberOfChannels; i++) {
			const oldBuffer = this.outputBuffers[i];
			const largerBuffer = mallocFloat32(nextLength);

			largerBuffer.set(oldBuffer.subarray(0, this.outputBufferLength), 0);
			freeFloat32(oldBuffer);

			this.outputBuffers[i] = largerBuffer;
		}

		this.outputBufferLength = nextLength;
	}

	private clearOutputBuffers(): void {
		const shift = this.nextOutputBufferShiftAmount;
		if (shift <= 0) return;

		const keepLength = Math.max(0, this.outputBufferLength - shift);

		for (let i = 0; i < this.numberOfChannels; i++) {
			const buffer = this.outputBuffers[i];

			if (keepLength > 0) {
				buffer.copyWithin(0, shift, this.outputBufferLength);
			}

			buffer.fill(0, keepLength);
		}

		this.nextOutputBufferShiftAmount = 0;
	}

	private synthesizeSegment(
		i: number,
		windowSize: number,
		inputStartPos: number,
		maxPositiveOffset: number = this.tolerance
	): void {
		let bestCorr = -Infinity;
		let bestOffset = 0;

		if (this.hasDoneOutput && this.factor !== 1) {
			let k = -this.tolerance;
			bestCorr = this.crossCorrelateAllChannels(i, inputStartPos, k);
			bestOffset = k;

			const minStepSize = 1;
			const maxStepSize = 16;
			let prevCorr = bestCorr;

			while (k < maxPositiveOffset) {
				const nextK = Math.min(k + 1, maxPositiveOffset);
				const corr = this.crossCorrelateAllChannels(i, inputStartPos, nextK);
				const gradient = Math.abs(corr - prevCorr);
				const adaptiveStep = Math.max(
					minStepSize,
					Math.min(maxStepSize, Math.floor(maxStepSize * Math.exp(-gradient * 3)))
				);

				if (corr > bestCorr) {
					bestCorr = corr;
					bestOffset = nextK;
				}

				prevCorr = corr;
				k += adaptiveStep;
			}

			const fineRange = 8;
			for (k = bestOffset - fineRange; k <= bestOffset + fineRange; k++) {
				if (k < -this.tolerance || k > maxPositiveOffset) continue;

				const corr = this.crossCorrelateAllChannels(i, inputStartPos, k);
				if (corr > bestCorr) {
					bestCorr = corr;
					bestOffset = k;
				}
			}
		}

		for (let chan = 0; chan < this.numberOfChannels; chan++) {
			const inputBuffer = this.buffers[chan];
			const outputBuffer = this.outputBuffers[chan];

			for (let j = 0; j < windowSize; j++) {
				const blendValue = j < this.overlapSize ? this.blendValues[j] : 1;
				const outIndex = i + j;

				outputBuffer[outIndex] *= 1 - blendValue;
				outputBuffer[outIndex] += blendValue * inputBuffer[inputStartPos + bestOffset + j];
			}
		}

		this.hasDoneOutput = true;
	}

	private crossCorrelateAllChannels(i: number, inputStartPos: number, k: number): number {
		let dot = 0;
		let normOldTotal = 0;
		let normNewTotal = 0;

		for (let chan = 0; chan < this.numberOfChannels; chan++) {
			const inputBuffer = this.buffers[chan];
			const outputBuffer = this.outputBuffers[chan];

			for (let j = 0; j < this.overlapSize; j++) {
				const oldValue = outputBuffer[i + j];
				const newValue = inputBuffer[inputStartPos + k + j];

				dot += oldValue * newValue;
				normOldTotal += oldValue * oldValue;
				normNewTotal += newValue * newValue;
			}
		}

		return dot / (Math.sqrt(normOldTotal * normNewTotal) || 1e-10);
	}

	private process(): Float32Array[] | null {
		let synthesisLength = 0;

		for (; true; synthesisLength += this.synthesisHopSize) {
			const inputShiftAmount = Math.floor(synthesisLength / this.factor);

			if (inputShiftAmount + this.windowSize + 2 * this.tolerance > this.bufferEndIndex) {
				synthesisLength -= this.synthesisHopSize;
				break;
			}
		}

		if (synthesisLength <= 0) {
			return null;
		}

		const inputShiftAmount = Math.floor(synthesisLength / this.factor);
		const outputLength = synthesisLength - this.synthesisHopSize + this.windowSize;

		this.clearOutputBuffers();
		this.ensureOutputBufferLength(outputLength);

		for (let i = 0; i < synthesisLength; i += this.synthesisHopSize) {
			const inputStartPos = this.tolerance + Math.floor(i / this.factor);
			this.synthesizeSegment(i, this.windowSize, inputStartPos);
		}

		this.shiftInputBuffers(inputShiftAmount);

		this.nextOutputBufferShiftAmount = synthesisLength;
		return this.outputSlices(synthesisLength);
	}

	private shiftInputBuffers(inputShiftAmount: number): void {
		if (inputShiftAmount <= 0) return;

		const oldEndIndex = this.bufferEndIndex;
		const newEndIndex = oldEndIndex - inputShiftAmount;

		for (let chan = 0; chan < this.numberOfChannels; chan++) {
			const inputBuffer = this.buffers[chan];

			if (newEndIndex > 0) {
				inputBuffer.copyWithin(0, inputShiftAmount, oldEndIndex);
			}

			inputBuffer.fill(0, newEndIndex, oldEndIndex);
		}

		this.bufferEndIndex = newEndIndex;
	}

	private outputSlices(length: number): Float32Array[] {
		const out = new Array<Float32Array>(this.numberOfChannels);

		for (let i = 0; i < this.numberOfChannels; i++) {
			out[i] = this.outputBuffers[i].subarray(0, length);
		}

		return out;
	}

	private assertWritable(): void {
		this.assertAlive();

		if (this.finalized) {
			throw new Error('Cannot append more buffers after calling finalize.');
		}
	}

	private assertAlive(): void {
		if (this.disposed) {
			throw new Error('Cannot use TimeStretcher after dispose().');
		}
	}
}

function mallocFloat32(length: number): Float32Array {
	return pool.calloc(Math.max(1, length), 'float32') as Float32Array;
}

function freeFloat32(buffer?: Float32Array): void {
	if (!buffer) return;
	pool.free(buffer);
}

function nextPow2Capacity(current: number, required: number): number {
	let capacity = Math.max(1, current);

	while (capacity < required) {
		capacity *= 2;
	}

	return capacity;
}