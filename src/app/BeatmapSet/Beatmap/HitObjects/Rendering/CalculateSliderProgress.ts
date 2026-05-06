import { type SliderPath, Vector2 } from 'osu-classes';

type BoundsLike = {
	set(x: number, y: number, width: number, height: number): unknown;
};

type BoundsScratch = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
};

const AABB_BLOCK_SHIFT = 6;
const AABB_BLOCK_SIZE = 1 << AABB_BLOCK_SHIFT;

const pathAabbIndexes = new WeakMap<Vector2[], PathAabbIndex>();

const boundsScratch: BoundsScratch = {
	minX: 0,
	minY: 0,
	maxX: 0,
	maxY: 0
};

export default class SliderProgressView {
	public length = 0;
	public calcPath: Vector2[] = [];
	public startX = 0;
	public startY = 0;
	public endX = 0;
	public endY = 0;
	public interiorBase = 0;
	public interiorLength = 0;

	constructor(private path: SliderPath) {
		this.reset(0, 1);
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

	computeRenderBoundsInto(radius: number, out: BoundsLike): BoundsLike {
		if (this.length <= 0) {
			out.set(0, 0, 0, 0);
			return out;
		}

		let minX = this.startX;
		let minY = this.startY;
		let maxX = this.startX;
		let maxY = this.startY;

		if (this.interiorLength > 0) {
			const index = getPathAabbIndex(this.calcPath);

			if (index.query(this.interiorBase, this.interiorLength, boundsScratch)) {
				if (boundsScratch.minX < minX) minX = boundsScratch.minX;
				if (boundsScratch.maxX > maxX) maxX = boundsScratch.maxX;
				if (boundsScratch.minY < minY) minY = boundsScratch.minY;
				if (boundsScratch.maxY > maxY) maxY = boundsScratch.maxY;
			}
		}

		if (this.length > 1) {
			const endX = this.endX;
			const endY = this.endY;

			if (endX < minX) minX = endX;
			else if (endX > maxX) maxX = endX;

			if (endY < minY) minY = endY;
			else if (endY > maxY) maxY = endY;
		}

		const pad = radius * 2;

		out.set(
			minX - radius,
			minY - radius,
			maxX - minX + pad,
			maxY - minY + pad
		);

		return out;
	}

	invalidateBoundsIndex(): void {
		pathAabbIndexes.delete(this.calcPath);
	}

	static invalidateBoundsIndex(calcPath: Vector2[]): void {
		pathAabbIndexes.delete(calcPath);
	}
}

class PathAabbIndex {
	private readonly points: Vector2[];
	private readonly blockMinX: Float64Array;
	private readonly blockMinY: Float64Array;
	private readonly blockMaxX: Float64Array;
	private readonly blockMaxY: Float64Array;

	readonly length: number;

	constructor(points: Vector2[]) {
		this.points = points;
		this.length = points.length;

		const blockCount = Math.ceil(this.length / AABB_BLOCK_SIZE);

		this.blockMinX = new Float64Array(blockCount);
		this.blockMinY = new Float64Array(blockCount);
		this.blockMaxX = new Float64Array(blockCount);
		this.blockMaxY = new Float64Array(blockCount);

		for (let block = 0; block < blockCount; block++) {
			const start = block << AABB_BLOCK_SHIFT;
			const end = Math.min(start + AABB_BLOCK_SIZE, this.length);

			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;

			for (let i = start; i < end; i++) {
				const p = points[i];
				const x = p.x;
				const y = p.y;

				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}

			this.blockMinX[block] = minX;
			this.blockMinY[block] = minY;
			this.blockMaxX[block] = maxX;
			this.blockMaxY[block] = maxY;
		}
	}

	query(start: number, length: number, out: BoundsScratch): boolean {
		let from = start | 0;
		let to = (start + length) | 0;

		if (from < 0) from = 0;
		if (to > this.length) to = this.length;
		if (from >= to) return false;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		const points = this.points;

		const firstFullBlock = (from + AABB_BLOCK_SIZE - 1) >> AABB_BLOCK_SHIFT;
		const lastFullBlock = to >> AABB_BLOCK_SHIFT;

		const leftEdgeEnd = Math.min(to, firstFullBlock << AABB_BLOCK_SHIFT);

		for (let i = from; i < leftEdgeEnd; i++) {
			const p = points[i];
			const x = p.x;
			const y = p.y;

			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}

		for (let block = firstFullBlock; block < lastFullBlock; block++) {
			const blockMinX = this.blockMinX[block];
			const blockMinY = this.blockMinY[block];
			const blockMaxX = this.blockMaxX[block];
			const blockMaxY = this.blockMaxY[block];

			if (blockMinX < minX) minX = blockMinX;
			if (blockMaxX > maxX) maxX = blockMaxX;
			if (blockMinY < minY) minY = blockMinY;
			if (blockMaxY > maxY) maxY = blockMaxY;
		}

		const rightEdgeStart = Math.max(leftEdgeEnd, lastFullBlock << AABB_BLOCK_SHIFT);

		for (let i = rightEdgeStart; i < to; i++) {
			const p = points[i];
			const x = p.x;
			const y = p.y;

			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}

		out.minX = minX;
		out.minY = minY;
		out.maxX = maxX;
		out.maxY = maxY;

		return true;
	}
}

function getPathAabbIndex(points: Vector2[]): PathAabbIndex {
	let index = pathAabbIndexes.get(points);

	if (!index || index.length !== points.length) {
		index = new PathAabbIndex(points);
		pathAabbIndexes.set(points, index);
	}

	return index;
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