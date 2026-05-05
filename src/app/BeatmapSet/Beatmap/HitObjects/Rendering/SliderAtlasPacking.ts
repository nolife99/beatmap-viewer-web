import { Bin, IRectangle, MaxRectsPacker, PACKING_LOGIC } from 'maxrects-packer';
import { ceilPowerOfTwo } from './SliderAtlasUtils.ts';

export type AtlasPackRequest<T> = {
	width: number;
	height: number;
	data: T;
};

export type AtlasPackOptions = {
	width: number;
	height: number;
	gutter: number;
};

const MAX_PACK_DIMENSION = 16384;

export function packAtlasTargets<T>(
	targets: AtlasPackRequest<T>[],
	options: AtlasPackOptions
): Bin<IRectangle>[] {
	const validTargets = targets.filter(isValidTarget);
	if (validTargets.length === 0) return [];

	const page = getPageSize(validTargets, options);
	if (!isValidDimension(page.width) || !isValidDimension(page.height)) {
		return [];
	}

	const packer = new MaxRectsPacker(page.width, page.height, options.gutter, {
		smart: true,
		pot: false,
		square: false,
		allowRotation: true,
		logic: PACKING_LOGIC.MAX_AREA
	});

	packer.addArray(validTargets as []);
	return packer.bins.filter((bin) =>
		isValidDimension(bin.width) &&
		isValidDimension(bin.height) &&
		bin.rects.length > 0
	);
}

function getPageSize<T>(
	targets: AtlasPackRequest<T>[],
	options: AtlasPackOptions
): { width: number; height: number } {
	let minWidth = sanitizeBaseDimension(options.width);
	let minHeight = sanitizeBaseDimension(options.height);
	const gutter = Math.max(0, Math.ceil(options.gutter));

	for (const target of targets) {
		const outerWidth = target.width + gutter * 2;
		const outerHeight = target.height + gutter * 2;

		minWidth = Math.max(minWidth, outerWidth);
		minHeight = Math.max(minHeight, outerHeight);
	}

	return {
		width: minWidth > options.width ? ceilPowerOfTwo(minWidth) : minWidth,
		height: minHeight > options.height ? ceilPowerOfTwo(minHeight) : minHeight
	};
}

function isValidTarget<T>(target: AtlasPackRequest<T>): boolean {
	return isValidDimension(target.width) &&
		isValidDimension(target.height);
}

function sanitizeBaseDimension(value: number): number {
	return isValidDimension(value) ? Math.ceil(value) : 1;
}

function isValidDimension(value: number): boolean {
	return Number.isFinite(value) &&
		value > 0 &&
		value <= MAX_PACK_DIMENSION;
}
