import { type SliderPath, Vector2 } from 'osu-classes';

export type SliderProgressResult = {
	points: Vector2[];
	length: number;
};

export default function calculateSliderProgress(
	path: SliderPath,
	p0: number,
	p1: number,
	out: Vector2[] = []
): SliderProgressResult {
	const calcPath = path.calculatedPath;
	const pathLen = calcPath.length;

	const d0: number = path['_progressToDistance'](p0);
	const d1: number = path['_progressToDistance'](p1);

	const cumLengths: number[] = path['_cumulativeLength'];

	const startIdx = lowerBound(cumLengths, d0, 0, pathLen);
	const endIdx = upperBound(cumLengths, d1, startIdx, pathLen);

	const pStart: Vector2 = path['_interpolateVertices'](startIdx, d0);
	const pEnd: Vector2 = path['_interpolateVertices'](endIdx, d1);

	let finalLen = 0;
	out[finalLen++] = pStart;

	for (let j = startIdx; j < endIdx; j++) {
		const pt = calcPath[j];
		if (!out[finalLen - 1].equals(pt)) {
			out[finalLen++] = pt;
		}
	}

	if (!out[finalLen - 1].equals(pEnd)) {
		out[finalLen++] = pEnd;
	}

	return { points: out, length: finalLen };
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