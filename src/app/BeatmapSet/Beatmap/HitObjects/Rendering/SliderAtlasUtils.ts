import { Color, groupD8, Point, Rectangle } from 'pixi.js';
import { darken, lighten } from '../../../../utils.ts';
import type { SliderInstanceStyle, SliderUniformPatch } from './SliderAtlasTypes.ts';

export const DEFAULT_ATLAS_SIZE = 2048;
export const DEFAULT_GUTTER = 1;
export const PHYSICAL_PIXEL_EPSILON = 1e-6;
export const REDUCE_PRECISION = 0.01;
export const REDUCE_PRECISION_SQ = REDUCE_PRECISION * REDUCE_PRECISION;

export function transformD8(
	rotation: number,
	x: number,
	y: number,
	out: Point,
	absolute = false
): Point {
	const ux = groupD8.uX(rotation);
	const uy = groupD8.uY(rotation);
	const vx = groupD8.vX(rotation);
	const vy = groupD8.vY(rotation);

	if (absolute) {
		out.x = x * Math.abs(ux) + y * Math.abs(vx);
		out.y = x * Math.abs(uy) + y * Math.abs(vy);
	} else {
		out.x = x * ux + y * vx;
		out.y = x * uy + y * vy;
	}

	return out;
}

const BASE_COLOR = new Color([69 / 255, 71 / 255, 90 / 255, 0]);

export const DEFAULT_BODY_STYLE: SliderInstanceStyle = createStyle({
	borderColor: [205 / 255, 214 / 255, 244 / 255],
	innerColor: lighten(BASE_COLOR.toArray(), 0.5),
	outerColor: darken(BASE_COLOR.toArray(), 0.1),
	borderWidth: 0.128,
	bodyAlpha: 0.7
});

export const DEFAULT_SELECTION_STYLE: SliderInstanceStyle = createStyle({
	borderColor: [49 / 255, 151 / 255, 255 / 255],
	innerColor: lighten(BASE_COLOR.toArray(), 0.5),
	outerColor: darken(BASE_COLOR.toArray(), 0.1),
	borderWidth: 0.128,
	bodyAlpha: 0.0
});

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
	rect: Rectangle
): boolean {
	const pad = radius;
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
	return {
		borderColor: new Color(style.borderColor),
		innerColor: new Color(style.innerColor),
		outerColor: new Color(style.outerColor),
		borderWidth: style.borderWidth,
		bodyAlpha: style.bodyAlpha
	};
}

export function patchStyle(base: SliderInstanceStyle, patch: SliderUniformPatch): SliderInstanceStyle {
	return {
		borderColor: patch.borderColor === undefined
			? new Color(base.borderColor)
			: new Color(patch.borderColor),
		innerColor: patch.innerColor === undefined
			? new Color(base.innerColor)
			: new Color(patch.innerColor),
		outerColor: patch.outerColor === undefined
			? new Color(base.outerColor)
			: new Color(patch.outerColor),
		borderWidth: patch.borderWidth ?? base.borderWidth,
		bodyAlpha: patch.bodyAlpha ?? base.bodyAlpha
	};
}