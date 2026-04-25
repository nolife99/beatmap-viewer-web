/// <reference types="@types/audioworklet" />

type RendererControlMessage =
	| {
		type: 'decoder-port';
		port: MessagePort;
	}
	| {
		type: 'reset';
		generation: number;
		baseMediaMs: number;
		rate: number;
		sourceChannels: number;
		minStartFrames: number;
	}
	| {
		type: 'play';
		generation: number;
	}
	| {
		type: 'pause';
		generation?: number;
	}
	| {
		type: 'dispose';
	};

type DecoderMessage =
	| {
		type: 'chunk';
		generation: number;
		buffer: ArrayBuffer;
		frames: number;
		channels: number;
		length: number;
	}
	| {
		type: 'end';
		generation: number;
	}
	| {
		type: 'clear';
		generation: number;
	};

type Chunk = {
	generation: number;
	buffer: ArrayBuffer;
	data: Float32Array;
	frames: number;
	channels: number;
	offsetFrames: number;
};

const QUEUE_CAPACITY = 256;
const QUEUE_MASK = QUEUE_CAPACITY - 1;
const CLOCK_INTERVAL_FRAMES = 2048;

class AudioRendererProcessor extends AudioWorkletProcessor {
	private decoderPort?: MessagePort;

	private readonly queue: Array<Chunk | undefined> = new Array(QUEUE_CAPACITY);
	private head = 0;
	private tail = 0;
	private queuedChunks = 0;
	private queuedFrames = 0;

	private generation = 0;
	private baseMediaMs = 0;
	private rate = 1;
	private minStartFrames = 2048;
	private renderedFrames = 0;
	private lastClockFrame = 0;
	private underruns = 0;
	private readySent = false;
	private playing = false;
	private ended = false;

	constructor() {
		super();

		this.port.onmessage = (event: MessageEvent<RendererControlMessage>) => {
			const msg = event.data;

			switch (msg.type) {
				case 'decoder-port':
					this.decoderPort = msg.port;
					this.decoderPort.onmessage = (decoderEvent: MessageEvent<DecoderMessage>) => {
						this.handleDecoderMessage(decoderEvent.data);
					};
					this.decoderPort.start();
					break;

				case 'reset':
					this.flushQueue();
					this.generation = msg.generation;
					this.baseMediaMs = msg.baseMediaMs;
					this.rate = msg.rate;
					this.minStartFrames = Math.max(128, msg.minStartFrames | 0);
					this.renderedFrames = 0;
					this.lastClockFrame = 0;
					this.underruns = 0;
					this.readySent = false;
					this.playing = false;
					this.ended = false;
					this.postClock();
					break;

				case 'play':
					if (msg.generation === this.generation) {
						this.playing = true;
						this.postClock();
					}
					break;

				case 'pause':
					if (msg.generation === undefined || msg.generation === this.generation) {
						this.playing = false;
						this.postClock();
					}
					break;

				case 'dispose':
					this.playing = false;
					this.flushQueue();
					this.decoderPort?.close();
					this.decoderPort = undefined;
					break;
			}
		};
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const output = outputs[0];
		if (!output || output.length === 0) return true;

		const frameCount = output[0].length;
		for (let ch = 0; ch < output.length; ch++) {
			output[ch].fill(0);
		}

		if (!this.playing) return true;

		let outFrame = 0;

		while (outFrame < frameCount) {
			const chunk = this.queue[this.head];

			if (!chunk) {
				this.underruns++;
				if ((this.underruns & 31) === 1) {
					this.port.postMessage({
						type: 'underrun',
						generation: this.generation,
						mediaMs: this.mediaMs(),
						contextTimeSec: currentTime,
						bufferedFrames: this.queuedFrames,
						underruns: this.underruns
					});
				}
				break;
			}

			const framesAvailable = chunk.frames - chunk.offsetFrames;
			const framesToCopy = Math.min(frameCount - outFrame, framesAvailable);

			this.copyInterleavedChunk(output, outFrame, chunk, framesToCopy);

			outFrame += framesToCopy;
			chunk.offsetFrames += framesToCopy;
			this.renderedFrames += framesToCopy;
			this.queuedFrames -= framesToCopy;

			if (chunk.offsetFrames >= chunk.frames) {
				this.releaseHeadChunk();
			}
		}

		if (this.renderedFrames - this.lastClockFrame >= CLOCK_INTERVAL_FRAMES) {
			this.lastClockFrame = this.renderedFrames;
			this.postClock();
		}

		return true;
	}

	private handleDecoderMessage(msg: DecoderMessage): void {
		if (msg.generation !== this.generation) {
			if (msg.type === 'chunk') {
				this.releaseBuffer(msg.generation, msg.buffer, msg.frames);
			}
			return;
		}

		switch (msg.type) {
			case 'chunk':
				this.enqueueChunk(msg);
				break;

			case 'clear':
				this.flushQueue();
				break;

			case 'end':
				this.ended = true;
				break;
		}
	}

	private enqueueChunk(msg: Extract<DecoderMessage, { type: 'chunk' }>): void {
		if (this.queuedChunks >= QUEUE_CAPACITY) {
			this.releaseBuffer(msg.generation, msg.buffer, msg.frames);
			this.port.postMessage({
				type: 'overflow',
				generation: msg.generation,
				bufferedFrames: this.queuedFrames
			});
			return;
		}

		this.queue[this.tail] = {
			generation: msg.generation,
			buffer: msg.buffer,
			data: new Float32Array(msg.buffer, 0, msg.length),
			frames: msg.frames,
			channels: msg.channels,
			offsetFrames: 0
		};
		this.tail = (this.tail + 1) & QUEUE_MASK;
		this.queuedChunks++;
		this.queuedFrames += msg.frames;

		if (!this.readySent && this.queuedFrames >= this.minStartFrames) {
			this.readySent = true;
			this.port.postMessage({
				type: 'ready',
				generation: this.generation,
				bufferedFrames: this.queuedFrames
			});
		}
	}

	private copyInterleavedChunk(
		output: Float32Array[],
		outFrame: number,
		chunk: Chunk,
		framesToCopy: number
	): void {
		const src = chunk.data;
		const srcChannels = chunk.channels;
		const srcBase = chunk.offsetFrames * srcChannels;
		const outChannels = output.length;

		for (let frame = 0; frame < framesToCopy; frame++) {
			const srcFrame = srcBase + frame * srcChannels;
			const dstFrame = outFrame + frame;

			if (srcChannels === 1) {
				const sample = src[srcFrame];
				for (let ch = 0; ch < outChannels; ch++) output[ch][dstFrame] = sample;
				continue;
			}

			const copyChannels = Math.min(outChannels, srcChannels);
			for (let ch = 0; ch < copyChannels; ch++) {
				output[ch][dstFrame] = src[srcFrame + ch];
			}
		}
	}

	private releaseHeadChunk(): void {
		const chunk = this.queue[this.head];
		if (!chunk) return;

		this.queue[this.head] = undefined;
		this.head = (this.head + 1) & QUEUE_MASK;
		this.queuedChunks--;

		this.releaseBuffer(chunk.generation, chunk.buffer, chunk.frames);
	}

	private flushQueue(): void {
		while (this.queuedChunks > 0) this.releaseHeadChunk();

		this.head = 0;
		this.tail = 0;
		this.queuedFrames = 0;
		this.queuedChunks = 0;
	}

	private releaseBuffer(generation: number, buffer: ArrayBuffer, frames: number): void {
		this.decoderPort?.postMessage(
			{ type: 'release', generation, buffer, frames },
			[buffer]
		);
	}

	private mediaMs(): number {
		return this.baseMediaMs + (this.renderedFrames / sampleRate) * this.rate * 1000;
	}

	private postClock(): void {
		this.port.postMessage({
			type: 'clock',
			generation: this.generation,
			mediaMs: this.mediaMs(),
			contextTimeSec: currentTime,
			bufferedFrames: this.queuedFrames,
			underruns: this.underruns,
			playing: this.playing,
			ended: this.ended
		});
	}
}

registerProcessor('beatmap-audio-renderer', AudioRendererProcessor);