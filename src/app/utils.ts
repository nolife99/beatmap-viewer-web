import * as d3 from 'd3';
import { Vibrant } from 'node-vibrant/browser';
import { Color, type ColorSource } from 'pixi.js';
import ColorConfig, { ColorPalette } from './Config/ColorConfig.ts';
import { inject } from './Context.ts';
import type { InputAudioTrack } from 'mediabunny';

export function lighten(
	color: ColorSource,
	amount: number
) {
	const a = amount * 0.5;
	const col = new Color(color);

	const ret = [];
	ret[0] = Math.min(1.0, col.red * (1.0 + 0.5 * a) + 1.0 * a);
	ret[1] = Math.min(1.0, col.green * (1.0 + 0.5 * a) + 1.0 * a);
	ret[2] = Math.min(1.0, col.blue * (1.0 + 0.5 * a) + 1.0 * a);

	return col.setValue(ret);
}

export function darken(
	color: ColorSource,
	amount: number
) {
	const col = new Color(color);

	const scalar = Math.max(1.0, 1.0 + amount);
	const ret = [];
	ret[0] = col.red / scalar;
	ret[1] = col.green / scalar;
	ret[2] = col.blue / scalar;

	return col.setValue(ret);
}

export function debounce<T extends unknown[]>(
	fn: (...args: T) => void,
	timeout = 100
) {
	let timer: number | undefined;

	return (...args: T) => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => fn(...args), timeout);
	};
}

export function binarySearch<T>(
	value: number,
	list: T[],
	compareFn: (mid: T, value: number) => number
) {
	let start = 0;
	let end = list.length - 1;
	let mid = start + Math.floor((end - start) / 2);

	while (end >= start) {
		mid = start + Math.floor((end - start) / 2);
		const compareValue = compareFn(list[mid], value);
		if (compareValue === 0) return mid;
		if (compareValue > 0) end = mid - 1;
		if (compareValue < 0) start = mid + 1;
	}

	return mid;
}

export function millisecondsToMinutesString(timestamp: number) {
	const minutes = Math.floor(timestamp / 60000) % 100;
	const seconds = Math.floor((timestamp % 60000) / 1000) % 60;
	const milliseconds = Math.floor(timestamp % 1000);

	return `${minutes.toString().padStart(2, '0')}:${
		seconds.toString().padStart(2, '0')
	}:${milliseconds.toString().padStart(3, '0')}`;
}

export function gcd(m: number, n: number) {
	let [a, b] = [m, n];
	if (a < b) [a, b] = [b, a];
	while (a % b !== 0) [a, b] = [b, a % b];
	return b;
}

const difficultyColourSpectrum = d3
	.scaleLinear<string>()
	.domain([0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9])
	.clamp(true)
	.range([
		'#4290FB',
		'#4FC0FF',
		'#4FFFD5',
		'#7CFF4F',
		'#F6F05C',
		'#FF8068',
		'#FF4E6F',
		'#C645B8',
		'#6563DE',
		'#18158E',
		'#000000'
	])
	.interpolate(d3.interpolateRgb.gamma(2.2));

export function getDiffColour(rating: number) {
	if (rating < 0.1) return '#AAAAAA';
	if (rating >= 9) return '#000000';
	return d3.rgb(difficultyColourSpectrum(rating)).formatHex();
}

export async function loadColorPalette(url: string) {
	const vibrant = new Vibrant(url);
	const swatches = await vibrant.getPalette();
	let palette: Partial<ColorPalette> = {};

	const primary = swatches.DarkMuted ?? swatches.Muted;
	if (primary) {
		const lumi = (0.299 * primary.rgb[0] +
				0.587 * primary.rgb[1] +
				0.114 * primary.rgb[2]) /
			255;

		let color = d3.color(primary.hex);
		if (color) {
			if (lumi < 0.1) {
				const ratio = 0.1 / lumi;
				const k = -Math.log(ratio) / Math.log(0.7);
				color = color.brighter(k);
			}

			palette = {
				...palette,
				crust: Number.parseInt(color.darker(3.0).formatHex().slice(1), 16),
				mantle: Number.parseInt(color.darker(2.0).formatHex().slice(1), 16),
				base: Number.parseInt(color.darker(1.0).formatHex().slice(1), 16),
				surface0: Number.parseInt(color.darker(0.5).formatHex().slice(1), 16),
				surface1: Number.parseInt(color.formatHex().slice(1), 16),
				surface2: Number.parseInt(color.brighter(0.5).formatHex().slice(1), 16),
				overlay0: Number.parseInt(color.brighter(1.0).formatHex().slice(1), 16),
				overlay1: Number.parseInt(color.brighter(1.5).formatHex().slice(1), 16),
				overlay2: Number.parseInt(color.brighter(2).formatHex().slice(1), 16)
			};
		}
	}

	const accent = swatches.LightMuted ?? swatches.Muted;
	if (accent) {
		const color = d3.color(accent.hex);
		if (color) {
			palette = {
				...palette,
				subtext0: Number.parseInt(color.formatHex().slice(1), 16),
				subtext1: Number.parseInt(color.brighter(0.5).formatHex().slice(1), 16),
				text: Number.parseInt(color.brighter(1.0).formatHex().slice(1), 16)
			};
		}
	}

	const colorConfig = inject<ColorConfig>('config/color');
	if (!colorConfig) return;
	colorConfig.color = palette;
}

export const Clamp = (val: number, min = 0, max = 1) => {
	return Math.min(max, Math.max(min, val));
};

export const difficultyRange = (
	val: number,
	min: number,
	mid: number,
	max: number
) => {
	if (val > 5) return mid + ((max - mid) * (val - 5)) / 5;
	if (val < 5) return mid - ((mid - min) * (5 - val)) / 5;
	return mid;
};

export function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const MP3_XING_MAGIC = 0x58696e67;
const MP3_INFO_MAGIC = 0x496e666f;
const MP3_DELAY_OFFSET_FROM_XING = 0x8d;
const MP3_DECODER_DELAY_SAMPLES = 528;
const DEFAULT_MP3_DELAY_MS = 25;
const MP3_PROBE_BYTES = 256 * 1024;

export async function getEncoderDelayMs(blob: Blob, audioTrack: InputAudioTrack): Promise<number> {
	const view = new DataView(await blob.slice(0, MP3_PROBE_BYTES).arrayBuffer());
	const xingOffset = findXingOffset(view);
	const isMp3 = hasMp3CodecHint(blob, audioTrack) || xingOffset >= 0 || findMp3FrameOffset(view) >= 0;

	if (!isMp3) return 0;
	if (xingOffset < 0) return defaultMp3DelayMs(audioTrack, 'no Xing/Info tag');

	const encoderDelaySamples = readLameEncoderDelaySamples(view, xingOffset);
	if (encoderDelaySamples < 0) return defaultMp3DelayMs(audioTrack, 'no LAME delay field');

	const sampleRate = audioTrack.sampleRate || 44100;
	const delay = ((encoderDelaySamples + MP3_DECODER_DELAY_SAMPLES) / sampleRate) * 1000;

	console.log(`MP3 encoder delay: ${encoderDelaySamples} samples @ ${sampleRate}Hz = ${delay.toFixed(2)}ms`);
	return delay;
}

function hasMp3CodecHint(blob: Blob, audioTrack: InputAudioTrack): boolean {
	const codec = (audioTrack.codec || blob.type).toLowerCase();
	return codec.includes('mp3') || codec.includes('mpeg');
}

function findXingOffset(view: DataView): number {
	const frameOffset = findMp3FrameOffset(view);
	const expectedOffset = frameOffset < 0 ? -1 : getExpectedXingOffset(view, frameOffset);

	if (isXingMagicAt(view, expectedOffset)) return expectedOffset;

	const start = Math.max(0, skipId3v2(view));
	const end = view.byteLength - MP3_DELAY_OFFSET_FROM_XING - 3;

	for (let i = start; i <= end; i++) {
		if (isXingMagicAt(view, i)) return i;
	}

	return -1;
}

function findMp3FrameOffset(view: DataView): number {
	const start = Math.max(0, skipId3v2(view));
	const end = view.byteLength - 4;

	for (let i = start; i <= end; i++) {
		if (isMp3FrameHeader(view.getUint32(i, false))) return i;
	}

	return -1;
}

function isMp3FrameHeader(header: number): boolean {
	const version = (header >>> 19) & 3;
	const layer = (header >>> 17) & 3;
	const bitrate = (header >>> 12) & 0xf;
	const sampleRate = (header >>> 10) & 3;

	return (header & 0xffe00000) === 0xffe00000 &&
		version !== 1 &&
		layer === 1 &&
		bitrate !== 0 &&
		bitrate !== 0xf &&
		sampleRate !== 3;
}

function getExpectedXingOffset(view: DataView, frameOffset: number): number {
	if (frameOffset + 4 > view.byteLength) return -1;

	const header = view.getUint32(frameOffset, false);
	const version = (header >>> 19) & 3;
	const channelMode = (header >>> 6) & 3;
	const sideInfoBytes = version === 3
		? channelMode === 3 ? 17 : 32
		: channelMode === 3 ? 9 : 17;

	return frameOffset + 4 + sideInfoBytes;
}

function isXingMagicAt(view: DataView, offset: number): boolean {
	if (offset < 0 || offset + 4 > view.byteLength) return false;

	const magic = view.getUint32(offset, false);
	return magic === MP3_XING_MAGIC || magic === MP3_INFO_MAGIC;
}

function skipId3v2(view: DataView): number {
	if (view.byteLength < 10) return 0;
	if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;

	const size =
		(view.getUint8(6) << 21) |
		(view.getUint8(7) << 14) |
		(view.getUint8(8) << 7) |
		view.getUint8(9);

	return 10 + size + ((view.getUint8(5) & 0x10) ? 10 : 0);
}

function readLameEncoderDelaySamples(view: DataView, xingOffset: number): number {
	const offset = xingOffset + MP3_DELAY_OFFSET_FROM_XING;
	if (offset + 3 > view.byteLength) return -1;

	const raw =
		(view.getUint8(offset) << 16) |
		(view.getUint8(offset + 1) << 8) |
		view.getUint8(offset + 2);

	const encoderDelaySamples = raw >>> 12;
	const encoderPaddingSamples = raw & 0xfff;

	return encoderDelaySamples || encoderPaddingSamples ? encoderDelaySamples : -1;
}

function defaultMp3DelayMs(audioTrack: InputAudioTrack, reason: string): number {
	console.log(`MP3 encoder delay: using ${DEFAULT_MP3_DELAY_MS}ms fallback (${reason}) @ ${audioTrack.sampleRate || 44100}Hz`);
	return DEFAULT_MP3_DELAY_MS;
}