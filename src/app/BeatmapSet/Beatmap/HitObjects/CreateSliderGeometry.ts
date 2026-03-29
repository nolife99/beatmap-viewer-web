import type { Vector2 } from "osu-classes";
import type { SliderProgressResult } from "@/BeatmapSet/Beatmap/HitObjects/CalculateSliderProgress.ts";

const RADIUS = 20;
const DIVIDES = 64;
const VECS = 3;

export default function updateGeometry(
	path: SliderProgressResult,
	radius: number,
	oldPositions: Float32Array | null,
	oldIndices: Uint32Array | null
) {
	const pointsCount = path.length;

	const requiredVerts = (pointsCount * 5 + pointsCount * DIVIDES) * VECS;
	const requiredIndices = (pointsCount * 12 + pointsCount * DIVIDES) * 3;

	let positions = (oldPositions && oldPositions.length >= requiredVerts)
		? oldPositions : new Float32Array(requiredVerts);
	let indices = (oldIndices && oldIndices.length >= requiredIndices)
		? oldIndices : new Uint32Array(requiredIndices);

	let vIdx = 0;
	let iIdx = 0;

	const writeV = (x: number, y: number, t: number) => {
		positions[vIdx++] = x || 0; // Guard against NaN
		positions[vIdx++] = y || 0;
		positions[vIdx++] = t;
	};

	// 1. Initial Point (Index 0)
	const pathPts = path.points;
	writeV(pathPts[0].x, pathPts[0].y, 0);

	for (let i = 1; i < pointsCount; i++) {
		const curr = pathPts[i];
		const prev = pathPts[i - 1];
		const dx = curr.x - prev.x;
		const dy = curr.y - prev.y;
		const len = Math.hypot(dx, dy);

		// If points are stacked, skip math to avoid NaN
		const ox = len === 0 ? 0 : (radius * -dy) / len;
		const oy = len === 0 ? 0 : (radius * dx) / len;

		// Vertices for this segment
		writeV(prev.x + ox, prev.y + oy, 1); // Index: 5*i - 4
		writeV(prev.x - ox, prev.y - oy, 1); // Index: 5*i - 3
		writeV(curr.x + ox, curr.y + oy, 1); // Index: 5*i - 2
		writeV(curr.x - ox, curr.y - oy, 1); // Index: 5*i - 1
		writeV(curr.x, curr.y, 0);           // Index: 5*i

		// Correct Indexing (n is the center of the current point)
		const n = 5 * i;

		// Quad 1
		indices[iIdx++] = n - 5; indices[iIdx++] = n - 4; indices[iIdx++] = n;
		indices[iIdx++] = n - 4; indices[iIdx++] = n;     indices[iIdx++] = n - 2;
		// Quad 2
		indices[iIdx++] = n - 5; indices[iIdx++] = n - 3; indices[iIdx++] = n;
		indices[iIdx++] = n - 3; indices[iIdx++] = n;     indices[iIdx++] = n - 1;
	}

	const addArc = (centerIdx: number, p1Idx: number, p2Idx: number) => {
		const cx = positions[VECS * centerIdx];
		const cy = positions[VECS * centerIdx + 1];
		const t1 = Math.atan2(positions[VECS * p1Idx + 1] - cy, positions[VECS * p1Idx] - cx);
		let t2 = Math.atan2(positions[VECS * p2Idx + 1] - cy, positions[VECS * p2Idx] - cx);

		if (t1 > t2) t2 += Math.PI * 2;
		let delta = t2 - t1;
		const divs = Math.ceil((DIVIDES * Math.abs(delta)) / (Math.PI * 2));
		delta /= divs;

		let last = p1Idx;
		for (let j = 1; j < divs; ++j) {
			writeV(cx + radius * Math.cos(t1 + j * delta), cy + radius * Math.sin(t1 + j * delta), 1);
			const newV = (vIdx / VECS) - 1;
			indices[iIdx++] = centerIdx;
			indices[iIdx++] = last;
			indices[iIdx++] = newV;
			last = newV;
		}
		indices[iIdx++] = centerIdx;
		indices[iIdx++] = last;
		indices[iIdx++] = p2Idx;
	};

	// Joins and Caps
	for (let i = 1; i < pointsCount - 1; ++i) {
		const d1 = { x: pathPts[i].x - pathPts[i-1].x, y: pathPts[i].y - pathPts[i-1].y };
		const d2 = { x: pathPts[i+1].x - pathPts[i].x, y: pathPts[i+1].y - pathPts[i].y };
		if (d1.x * d2.y - d1.y * d2.x > 0) addArc(5 * i, 5 * i - 1, 5 * i + 2);
		else addArc(5 * i, 5 * i + 1, 5 * i - 2);
	}

	addArc(0, 1, 2);
	const lastBase = 5 * (pointsCount - 1);
	addArc(lastBase, lastBase - 1, lastBase - 2);

	return {
		// We return subarrays so Pixi knows exactly how many elements to draw,
		// but the underlying ArrayBuffer is reused.
		positions: positions.subarray(0, vIdx),
		indices: indices.subarray(0, iIdx)
	};
}