import { Assets, Texture } from "pixi.js";
import WaveSurfer from "wavesurfer.js";
import { inject } from "@/Context";
import type SpectrogramContainer from "@/UI/sidepanel/Modding/Spectrogram";
import SpectrogramPlugin from "@/Audio/spectrogram/spectrogram.js";

const sampleRate = 40000;
const emptyWavBlob = createEmptyWavBlob();

function createEmptyWavBlob() {
	const numChannels = 1;
	const bitsPerSample = 16;
	const durationSeconds = 1;
	const numSamples = sampleRate * durationSeconds;
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const dataSize = numSamples * blockAlign;

	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	const writeString = (offset: number, string: string) => {
		for (let i = 0; i < string.length; i++)
			view.setUint8(offset + i, string.charCodeAt(i));
	};

	/* RIFF identifier */
	writeString(0, 'RIFF');
	/* file length */
	view.setUint32(4, 36 + dataSize, true);
	/* RIFF type */
	writeString(8, 'WAVE');
	/* format chunk identifier */
	writeString(12, 'fmt ');
	/* format chunk length */
	view.setUint32(16, 16, true);
	/* sample format (raw) */
	view.setUint16(20, 1, true);
	/* channel count */
	view.setUint16(22, numChannels, true);
	/* sample rate */
	view.setUint32(24, sampleRate, true);
	/* byte rate (sample rate * block align) */
	view.setUint32(28, byteRate, true);
	/* block align (channel count * bytes per sample) */
	view.setUint16(32, blockAlign, true);
	/* bits per sample */
	view.setUint16(34, bitsPerSample, true);
	/* data chunk identifier */
	writeString(36, 'data');
	/* data chunk length */
	view.setUint32(40, dataSize, true);

	return new Blob([buffer], { type: 'audio/wav' });
}

export default class SpectrogramProcessor {
	constructor(buffer: AudioBuffer) {
		console.time("Spectrogram ready");

		const waveSurfer = WaveSurfer.create({
			container: "#a",
			sampleRate: sampleRate,
			width: 400
		});

		const spectrogram = SpectrogramPlugin.create({
			labels: false,
			splitChannels: false,
			scale: "linear",
			frequencyMax: sampleRate / 2,
			frequencyMin: 0,
			fftSamples: 512,
			gainDB: 0,
			useWebWorker: true,
			maxCanvasWidth: 2000,
			height: 400
		});

		waveSurfer.registerPlugin(spectrogram);

		spectrogram.on("ready", () => {
			const canvas: HTMLCanvasElement | null | undefined = document
				.querySelector("#a > div")
				?.shadowRoot?.querySelector(".wrapper > div:last-child canvas");

			if (!canvas) return;

			setTimeout(async () => {
				console.timeEnd("Spectrogram ready");
				waveSurfer.destroy();

				inject<SpectrogramContainer>("ui/sidepanel/modding/spectrogram",)?.setTexture(Texture.from(canvas));
			});
		}, { once: true });

		const channelData = new Float32Array(buffer.length);
		buffer.copyFromChannel(channelData, 0);

		waveSurfer.loadBlob(emptyWavBlob, [channelData], buffer.duration);
	}
}
