import pool from '@stdlib/array-pool';
import { Texture } from 'pixi.js';
import FFT, { applyFilterBank, createFilterBankForScale, setupColorMap } from 'wavesurfer.js/dist/fft.js';
import type { AudioBufferSink } from 'mediabunny';

type WrappedBufferLike = {
	buffer: AudioBuffer;
	timestamp: number;
};

type SpectrogramProcessorOptions = {
	sink: AudioBufferSink;
	durationSec: number;
	sampleRate: number;
	channels: number;
	width?: number;
	height?: number;
	fftSamples?: number;
	frequencyMin?: number;
	frequencyMax?: number;
	scale?: 'linear' | 'logarithmic' | 'mel' | 'bark' | 'erb';
	gainDB?: number;
	rangeDB?: number;
	colorMap?: number[][] | 'gray' | 'igray' | 'roseus';
	container?: HTMLElement | string;
	onTextureUpdate?: (texture: Texture) => void;
};

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 400;
const DEFAULT_FFT_SAMPLES = 512;
const DEFAULT_FLUSH_COLUMNS = 4;

export default class SpectrogramProcessor {
	private readonly sink: AudioBufferSink;
	private readonly durationSec: number;
	private readonly sampleRate: number;
	private readonly channelCount: number;

	private readonly width: number;
	private readonly height: number;
	private readonly fftSamples: number;
	private readonly frequencyMin: number;
	private readonly frequencyMax: number;
	private readonly scale: NonNullable<SpectrogramProcessorOptions['scale']>;
	private readonly gainDB: number;
	private readonly rangeDB: number;
	private readonly colorMap: number[][];
	private readonly onTextureUpdate?: (texture: Texture) => void;

	private readonly root: HTMLDivElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly imageData: ImageData;

	private readonly fft: FFT;
	private readonly filterBank: number[][] | null;

	private texture?: Texture;
	private destroyed = false;
	private renderToken = 0;

	private columnAccum: Float32Array;
	private columnCounts: Uint16Array;
	private readonly smoothingBins: number;
	private windowBuffer: Float32Array;
	private carryBuffer: Float32Array;
	private carryLength = 0;

	private writeColumn = 0;
	private lastFlushedColumn = 0;

	constructor(options: SpectrogramProcessorOptions) {
		this.sink = options.sink;
		this.durationSec = options.durationSec;
		this.sampleRate = options.sampleRate;
		this.channelCount = Math.max(1, options.channels | 0);

		this.width = options.width ?? DEFAULT_WIDTH;
		this.height = options.height ?? DEFAULT_HEIGHT;
		this.fftSamples = options.fftSamples ?? DEFAULT_FFT_SAMPLES;
		this.frequencyMin = options.frequencyMin ?? 0;
		this.frequencyMax = options.frequencyMax ?? this.sampleRate / 2;
		this.scale = options.scale ?? 'linear';
		this.gainDB = options.gainDB ?? 0;
		this.rangeDB = options.rangeDB ?? 80;
		this.colorMap = setupColorMap(options.colorMap);
		this.onTextureUpdate = options.onTextureUpdate;

		this.root = document.createElement('div');
		this.root.style.position = 'relative';
		this.root.style.width = `${this.width}px`;
		this.root.style.height = `${this.height}px`;
		this.root.style.overflow = 'hidden';

		this.canvas = document.createElement('canvas');
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.canvas.style.display = 'block';

		this.root.appendChild(this.canvas);

		const ctx = this.canvas.getContext('2d', {
			alpha: true,
			willReadFrequently: false
		});

		if (!ctx) throw new Error('Failed to create spectrogram canvas context');

		this.ctx = ctx;
		this.imageData = new ImageData(this.width, this.height);

		// deno-lint-ignore no-explicit-any
		this.fft = new (FFT as any)(this.fftSamples, this.sampleRate, 'hann');
		this.filterBank = createFilterBankForScale(
			this.scale,
			this.fftSamples / 2,
			this.fftSamples,
			this.sampleRate
		);

		this.smoothingBins = this.fftSamples / 2;
		this.columnAccum = pool.malloc(this.width * this.smoothingBins, 'float32') as Float32Array;
		this.columnCounts = pool.malloc(this.width, 'uint16') as Uint16Array;

		this.windowBuffer = pool.malloc(this.fftSamples, 'float32') as Float32Array;
		this.carryBuffer = pool.malloc(this.fftSamples * 2, 'float32') as Float32Array;

		const parent =
			typeof options.container === 'string'
				? document.querySelector(options.container)
				: options.container;

		parent?.appendChild(this.root);
	}

	getTexture() {
		if (!this.texture) {
			this.texture = Texture.from(this.canvas);
		}

		return this.texture;
	}

	async render() {
		const token = ++this.renderToken;

		this.clear();

		const hopSize = this.computeHopSize();
		let absoluteSample = 0;

		for await (const wrapped of this.sink.buffers(0) as AsyncGenerator<WrappedBufferLike>) {
			if (this.destroyed || token !== this.renderToken) break;

			const buffer = wrapped.buffer;
			const mono = this.mixToMono(buffer);

			try {
				absoluteSample = this.consumeMonoChunk(mono, absoluteSample, hopSize);
				this.flushIfNeeded();
			} finally {
				pool.free(mono);
			}

			if (this.writeColumn >= this.width) break;
		}

		this.flush(true);
		return this.getTexture();
	}

	destroy() {
		this.destroyed = true;
		this.renderToken++;

		this.texture?.destroy(true);
		this.texture = undefined;

		pool.free(this.columnAccum);
		pool.free(this.columnCounts);
		pool.free(this.windowBuffer);
		pool.free(this.carryBuffer);

		this.root.remove();
	}

	private clear() {
		this.writeColumn = 0;
		this.lastFlushedColumn = 0;
		this.carryLength = 0;

		this.columnAccum.fill(0);
		this.columnCounts.fill(0);

		this.fillImageDataBlack();
		this.ctx.clearRect(0, 0, this.width, this.height);
		this.drawFullFrameWithProgress();

		this.updateTexture();
	}

	private computeHopSize() {
		return Math.max(64, this.fftSamples >> 2);
	}

	private mixToMono(buffer: AudioBuffer): Float32Array {
		const length = buffer.length;
		const mono = pool.malloc(length, 'float32') as Float32Array;
		mono.fill(0);

		const channels = Math.min(this.channelCount, buffer.numberOfChannels);

		for (let ch = 0; ch < channels; ch++) {
			const src = buffer.getChannelData(ch);
			const gain = 1 / channels;

			for (let i = 0; i < length; i++) {
				mono[i] += src[i] * gain;
			}
		}

		return mono;
	}

	private consumeMonoChunk(
		chunk: Float32Array,
		absoluteSample: number,
		hopSize: number
	): number {
		let read = 0;

		while (read < chunk.length && this.writeColumn < this.width) {
			const needed = this.fftSamples - this.carryLength;
			const copyCount = Math.min(needed, chunk.length - read);

			this.carryBuffer.set(chunk.subarray(read, read + copyCount), this.carryLength);
			this.carryLength += copyCount;
			read += copyCount;

			if (this.carryLength < this.fftSamples) break;

			this.windowBuffer.set(this.carryBuffer.subarray(0, this.fftSamples));
			this.drawFftWindow(this.windowBuffer, absoluteSample);

			const remaining = this.carryLength - hopSize;

			if (remaining > 0) {
				this.carryBuffer.copyWithin(0, hopSize, this.carryLength);
				this.carryLength = remaining;
			} else {
				this.carryLength = 0;
			}

			absoluteSample += hopSize;
		}

		return absoluteSample;
	}

	private drawFftWindow(samples: Float32Array, absoluteSample: number) {
		const column = Math.floor(
			(absoluteSample / Math.max(1, this.durationSec * this.sampleRate)) * this.width
		);

		if (column < 0 || column >= this.width) return;

		let spectrum = this.fft.calculateSpectrum(samples);

		if (this.filterBank) {
			spectrum = applyFilterBank(spectrum, this.filterBank);
		}

		const bins = Math.min(this.smoothingBins, spectrum.length);
		const base = column * this.smoothingBins;

		for (let i = 0; i < bins; i++) {
			this.columnAccum[base + i] += spectrum[i];
		}

		if (this.columnCounts[column] < 65535) {
			this.columnCounts[column]++;
		}

		if (column >= this.writeColumn) {
			this.writeColumn = column + 1;
		}
	}

	private drawAveragedColumn(x: number, count: number) {
		const data = this.imageData.data;
		const bins = this.smoothingBins;
		const base = x * bins;
		const gainPlusRange = this.gainDB + this.rangeDB;
		const invCount = 1 / count;

		for (let y = 0; y < this.height; y++) {
			const freqRatio = 1 - y / Math.max(1, this.height - 1);
			const freq = this.frequencyMin + freqRatio * (this.frequencyMax - this.frequencyMin);
			const bin = Math.min(
				bins - 1,
				Math.max(0, Math.floor((freq / (this.sampleRate / 2)) * bins))
			);

			const magnitude = Math.max(1e-12, this.columnAccum[base + bin] * invCount);
			const valueDB = 20 * Math.log10(magnitude);

			let colorIndex: number;

			if (valueDB < -gainPlusRange) {
				colorIndex = 0;
			} else if (valueDB > -this.gainDB) {
				colorIndex = 255;
			} else {
				colorIndex = Math.round(((valueDB + gainPlusRange) / this.rangeDB) * 255);
			}

			const color = this.colorMap[colorIndex];
			const pixel = (y * this.width + x) * 4;

			data[pixel] = color[0] * 255;
			data[pixel + 1] = color[1] * 255;
			data[pixel + 2] = color[2] * 255;
			data[pixel + 3] = color[3] * 255;
		}
	}
	private flushIfNeeded() {
		if (this.writeColumn - this.lastFlushedColumn >= DEFAULT_FLUSH_COLUMNS) {
			this.flush(false);
		}
	}

	private flush(force: boolean) {
		if (!force && this.writeColumn === this.lastFlushedColumn) return;

		const start = this.lastFlushedColumn;
		const end = Math.min(this.writeColumn, this.width);

		for (let x = start; x < end; x++) {
			const count = this.columnCounts[x];

			if (count === 0) continue;

			this.drawAveragedColumn(x, count);
		}

		this.lastFlushedColumn = end;
		this.drawFullFrameWithProgress();
		this.updateTexture();
	}

	private fillImageDataBlack() {
		const data = this.imageData.data;

		for (let i = 0; i < data.length; i += 4) {
			data[i] = 0;
			data[i + 1] = 0;
			data[i + 2] = 0;
			data[i + 3] = 255;
		}
	}

	private drawFullFrameWithProgress() {
		this.ctx.putImageData(this.imageData, 0, 0);
		this.drawProgressLine();
	}

	private drawProgressLine() {
		if (this.writeColumn >= this.width) return;

		const x = Math.max(0, Math.min(this.width - 1, this.writeColumn));

		this.ctx.fillStyle = '#fff';
		this.ctx.fillRect(x, 0, 1, this.height);
	}

	private updateTexture() {
		const texture = this.getTexture();

		texture.source.update();
		this.onTextureUpdate?.(texture);
	}
}