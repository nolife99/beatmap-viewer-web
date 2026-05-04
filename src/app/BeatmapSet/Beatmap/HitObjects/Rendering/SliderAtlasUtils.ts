import { Color, type ColorSource } from 'pixi.js';
import { darken, lighten } from '../../../../utils.ts';
import type { SliderBounds, MutableBounds, SliderInstanceStyle, SliderUniformPatch } from './SliderAtlasTypes.ts';

export const DEFAULT_ATLAS_SIZE = 2048;
export const DEFAULT_GUTTER = 2;
export const EXTRA_AA_PIXELS = 2;
export const PHYSICAL_PIXEL_EPSILON = 1e-6;
export const REDUCE_PRECISION = 0.01;
export const REDUCE_PRECISION_SQ = REDUCE_PRECISION * REDUCE_PRECISION;

const COLOR: ColorSource = [69 / 255, 71 / 255, 90 / 255, 0];

export const DEFAULT_BODY_STYLE: SliderInstanceStyle = createStyle({
	borderColor: [205 / 255, 214 / 255, 244 / 255],
	innerColor: lighten(COLOR, 0.5),
	outerColor: darken(COLOR, 0.1),
	borderWidth: 0.128,
	bodyAlpha: 0.7
});

export const DEFAULT_SELECTION_STYLE: SliderInstanceStyle = createStyle({
	borderColor: [49 / 255, 151 / 255, 255 / 255],
	innerColor: lighten(COLOR, 0.5),
	outerColor: darken(COLOR, 0.1),
	borderWidth: 0.128,
	bodyAlpha: 0.0
});

export const EMPTY_BOUNDS: MutableBounds = { x: 0, y: 0, width: 0, height: 0 };

export function cloneBounds(bounds: SliderBounds | MutableBounds): MutableBounds {
	return {
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height
	};
}

export function padBounds(base: MutableBounds, pad: number): MutableBounds {
	return {
		x: base.x - pad,
		y: base.y - pad,
		width: base.width + pad * 2,
		height: base.height + pad * 2
	};
}

export function intersectBounds(a: MutableBounds, b: MutableBounds): MutableBounds | undefined {
	const minX = Math.max(a.x, b.x);
	const minY = Math.max(a.y, b.y);
	const maxX = Math.min(a.x + a.width, b.x + b.width);
	const maxY = Math.min(a.y + a.height, b.y + b.height);

	if (maxX <= minX || maxY <= minY) return undefined;

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY
	};
}

export function normalizeResolution(value: number): number {
	return Number.isFinite(value) ? Math.max(1, value) : 1;
}

export function toPhysicalPixels(logicalPixels: number, resolution: number): number {
	return Math.max(
		1,
		Math.ceil(logicalPixels * resolution - PHYSICAL_PIXEL_EPSILON)
	);
}

export function ceilPowerOfTwo(value: number): number {
	let result = 1;
	while (result < value) result <<= 1;
	return result;
}

export function segmentCapsuleIntersectsRect(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	radius: number,
	rect: MutableBounds,
	extra = EXTRA_AA_PIXELS
): boolean {
	const pad = radius + extra;
	const minX = Math.min(ax, bx) - pad;
	const minY = Math.min(ay, by) - pad;
	const maxX = Math.max(ax, bx) + pad;
	const maxY = Math.max(ay, by) + pad;

	return !(maxX <= rect.x ||
		maxY <= rect.y ||
		minX >= rect.x + rect.width ||
		minY >= rect.y + rect.height);
}

export function createStyle(style: Required<Pick<SliderUniformPatch,
	'borderColor' | 'innerColor' | 'outerColor' | 'borderWidth' | 'bodyAlpha'
>>): SliderInstanceStyle {
	const border = colorToRgb(style.borderColor, [205 / 255, 214 / 255, 244 / 255]);
	const inner = colorToRgb(style.innerColor, [0, 0, 0]);
	const outer = colorToRgb(style.outerColor, [0, 0, 0]);

	return {
		borderR: border[0],
		borderG: border[1],
		borderB: border[2],
		borderA: border[3],

		innerR: inner[0],
		innerG: inner[1],
		innerB: inner[2],
		innerA: inner[3],

		outerR: outer[0],
		outerG: outer[1],
		outerB: outer[2],
		outerA: outer[3],

		borderWidth: style.borderWidth,
		bodyAlpha: style.bodyAlpha
	};
}

export function patchStyle(base: SliderInstanceStyle, patch: SliderUniformPatch): SliderInstanceStyle {
	const border = patch.borderColor === undefined
		? [base.borderR, base.borderG, base.borderB, base.borderA] as [number, number, number, number]
		: colorToRgb(patch.borderColor, [base.borderR, base.borderG, base.borderB, base.borderA]);

	const inner = patch.innerColor === undefined
		? [base.innerR, base.innerG, base.innerB, base.innerA] as [number, number, number, number]
		: colorToRgb(patch.innerColor, [base.innerR, base.innerG, base.innerB, base.innerA]);

	const outer = patch.outerColor === undefined
		? [base.outerR, base.outerG, base.outerB, base.outerA] as [number, number, number, number]
		: colorToRgb(patch.outerColor, [base.outerR, base.outerG, base.outerB, base.outerA]);

	return {
		borderR: border[0],
		borderG: border[1],
		borderB: border[2],
		borderA: border[3],

		innerR: inner[0],
		innerG: inner[1],
		innerB: inner[2],
		innerA: inner[3],

		outerR: outer[0],
		outerG: outer[1],
		outerB: outer[2],
		outerA: outer[3],

		borderWidth: patch.borderWidth ?? base.borderWidth,
		bodyAlpha: patch.bodyAlpha ?? base.bodyAlpha
	};
}

function colorToRgb(
	source: ColorSource,
	fallback: readonly number[]
): [number, number, number, number] {
	let rgba: number[];

	if (Array.isArray(source)) {
		rgba = [
			source[0] ?? fallback[0] ?? 0,
			source[1] ?? fallback[1] ?? 0,
			source[2] ?? fallback[2] ?? 0,
			source[3] ?? fallback[3] ?? 1
		];
	} else if (typeof source === 'number') {
		rgba = [
			((source >> 16) & 255) / 255,
			((source >> 8) & 255) / 255,
			(source & 255) / 255,
			1
		];
	} else {
		rgba = new Color(source).toArray();
	}

	return [
		clamp01(rgba[0] ?? fallback[0] ?? 0),
		clamp01(rgba[1] ?? fallback[1] ?? 0),
		clamp01(rgba[2] ?? fallback[2] ?? 0),
		clamp01(rgba[3] ?? fallback[3] ?? 1)
	];
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
