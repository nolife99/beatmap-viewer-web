import { type SliderPath, Vector2 } from 'osu-classes';

export type SliderProgressSource = {
	readonly length: number;
	getPointX(index: number): number;
	getPointY(index: number): number;
};

export type SliderPathBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export class SliderProgressView implements SliderProgressSource {
	public length = 0;
	public readonly fullBounds: SliderPathBounds;

	/**
	 * Hot-path fields used by the batched slider renderer.
	 * They intentionally avoid virtual getPointX/getPointY calls while reducing segments.
	 */
	public calcPath: Vector2[] = [];
	public startX = 0;
	public startY = 0;
	public endX = 0;
	public endY = 0;
	public interiorBase = 0;
	public interiorLength = 0;

	constructor(private path: SliderPath) {
		this.fullBounds = computeSliderPathBounds(path);
	}

	reset(p0: number, p1: number): this {
		const calcPath = this.path.calculatedPath;
		const pathLen = calcPath.length;

		this.calcPath = calcPath;
		this.length = 0;
		this.interiorBase = 0;
		this.interiorLength = 0;

		if (pathLen === 0) {
			this.startX = 0;
			this.startY = 0;
			this.endX = 0;
			this.endY = 0;
			return this;
		}

		const d0: number = this.path['_progressToDistance'](p0);
		const d1: number = this.path['_progressToDistance'](p1);

		const cumLengths: number[] | Float64Array = this.path['_cumulativeLength'];

		const startIdx = lowerBound(cumLengths, d0, 0, pathLen);
		const endIdx = upperBound(cumLengths, d1, startIdx, pathLen);

		const pStart: Vector2 = this.path['_interpolateVertices'](startIdx, d0);
		const pEnd: Vector2 = this.path['_interpolateVertices'](endIdx, d1);

		this.startX = pStart.x;
		this.startY = pStart.y;
		this.endX = pEnd.x;
		this.endY = pEnd.y;

		const rawInteriorLength = endIdx - startIdx;
		const skipFirstInterior =
			rawInteriorLength > 0 && pStart.equals(calcPath[startIdx]);

		this.interiorBase = startIdx + (skipFirstInterior ? 1 : 0);
		this.interiorLength = rawInteriorLength - (skipFirstInterior ? 1 : 0);

		const skipEnd = this.interiorLength > 0
			? pEnd.equals(calcPath[endIdx - 1])
			: pEnd.equals(pStart);
		this.length = 1 + this.interiorLength + (skipEnd ? 0 : 1);

		return this;
	}

	getPointX(index: number): number {
		if (index === 0) return this.startX;

		const interiorIndex = index - 1;
		if (interiorIndex < this.interiorLength) {
			return this.calcPath[this.interiorBase + interiorIndex].x;
		}

		return this.endX;
	}

	getPointY(index: number): number {
		if (index === 0) return this.startY;

		const interiorIndex = index - 1;
		if (interiorIndex < this.interiorLength) {
			return this.calcPath[this.interiorBase + interiorIndex].y;
		}

		return this.endY;
	}
}

function lowerBound(
	arr: number[] | Float64Array,
	target: number,
	start: number,
	end: number
): number {
	let left = start;
	let right = end - 1;
	let result = end;

	while (left <= right) {
		const mid = (left + right) >> 1;
		if (arr[mid] >= target) {
			result = mid;
			right = mid - 1;
		} else {
			left = mid + 1;
		}
	}

	return result;
}

function upperBound(
	arr: number[] | Float64Array,
	target: number,
	start: number,
	end: number
): number {
	let left = start;
	let right = end - 1;
	let result = end;

	while (left <= right) {
		const mid = (left + right) >> 1;
		if (arr[mid] > target) {
			result = mid;
			right = mid - 1;
		} else {
			left = mid + 1;
		}
	}

	return result;
}

export function computeSliderPathBounds(path: SliderPath): SliderPathBounds {
	const points = path.calculatedPath;
	const length = points.length;

	if (length === 0) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}

	let minX = points[0].x;
	let minY = points[0].y;
	let maxX = minX;
	let maxY = minY;

	for (let i = 1; i < length; i++) {
		const point = points[i];
		const x = point.x;
		const y = point.y;

		if (x < minX) minX = x;
		else if (x > maxX) maxX = x;

		if (y < minY) minY = y;
		else if (y > maxY) maxY = y;
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY
	};
}
