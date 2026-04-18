import { Vector2, type SliderPath } from "osu-classes";

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

	const d0 = (path as any)._progressToDistance(p0);
	const d1 = (path as any)._progressToDistance(p1);

	const cumLengths = (path as any)._cumulativeLength;

	const startIdx = lowerBound(cumLengths, d0, 0, pathLen);
	const endIdx = upperBound(cumLengths, d1, startIdx, pathLen);

	const pStart: Vector2 = (path as any)._interpolateVertices(startIdx, d0);
	const pEnd: Vector2 = (path as any)._interpolateVertices(endIdx, d1);

	// const numPoints = endIdx - startIdx + 2;
	// if ((path as any).curveType === "P" || numPoints <= 3) {
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

	/* }
	ensureCapacity(numPoints * 2);

	spatialGrid.clear();
	addedEdges.clear();
	gridArrayPoolIdx = 0;

	const mergeEpsilonSq = 9;
	let nextNodeId = 0;

	function getOrCreateNode(p: Vector2): GraphNode {
		const gx = Math.round(p.x);
		const gy = Math.round(p.y);

		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const cellIds = spatialGrid.get(pairSigned(gx + dx, gy + dy));
				if (!cellIds) continue;

				for (let i = 0; i < cellIds.length; i++) {
					const node = globalNodes[cellIds[i]];
					if (distanceSq(node.p!, p) < mergeEpsilonSq) return node;
				}
			}
		}

		if (nextNodeId >= globalNodes.length) globalNodes.push(new GraphNode());

		const newNode = globalNodes[nextNodeId];
		newNode.reset(nextNodeId, p);
		nextNodeId++;

		const hash = pairSigned(gx, gy);
		let cellIds = spatialGrid.get(hash);

		if (!cellIds) {
			if (gridArrayPoolIdx >= gridArrayPool.length) gridArrayPool.push([]);
			cellIds = gridArrayPool[gridArrayPoolIdx++];
			cellIds.length = 0;
			spatialGrid.set(hash, cellIds);
		}

		cellIds.push(newNode.id);
		return newNode;
	}

	let mergedLen = 0;
	let prevMergedId = -1;

	for (let i = 0; i < numPoints; i++) {
		const node = getOrCreateNode(
			getVirtualPoint(path, startIdx, numPoints, pStart, pEnd, i)
		);

		if (node.id !== prevMergedId) {
			mergedSequence[mergedLen++] = node.id;
			prevMergedId = node.id;
		}
	}

	if (mergedLen === 0) {
		out[0] = pStart;
		if (!pStart.equals(pEnd)) out[1] = pEnd;
		return { points: out, length: pStart.equals(pEnd) ? 1 : 2 };
	}

	edgeVisitCount.clear();

	for (let i = 1; i < mergedLen; i++) {
		const aId = mergedSequence[i - 1];
		const bId = mergedSequence[i];
		if (aId === bId) continue;

		const minId = Math.min(aId, bId);
		const maxId = Math.max(aId, bId);
		const edgeId = pairUnsigned(minId, maxId);

		edgeVisitCount.set(edgeId, (edgeVisitCount.get(edgeId) ?? 0) + 1);
	}

	let reducedLen = 0;
	for (let i = 0; i < mergedLen; i++) {
		const nodeId = mergedSequence[i];

		if (reducedLen >= 2 && nodeId === reducedSeq[reducedLen - 2]) {
			const aId = reducedSeq[reducedLen - 2];
			const bId = reducedSeq[reducedLen - 1];

			const edgeId = pairUnsigned(Math.min(aId, bId), Math.max(aId, bId));

			const remainingVisits = edgeVisitCount.get(edgeId) ?? 0;
			if (remainingVisits > 2) {
				edgeVisitCount.set(edgeId, remainingVisits - 2);
				reducedLen--;
				continue;
			}
		}

		if (reducedLen === 0 || nodeId !== reducedSeq[reducedLen - 1]) {
			reducedSeq[reducedLen++] = nodeId;
		}
	}

	if (reducedLen === 0) {
		out[0] = pStart;
		if (!pStart.equals(pEnd)) out[1] = pEnd;
		return { points: out, length: pStart.equals(pEnd) ? 1 : 2 };
	}

	for (let i = 0; i < nextNodeId; i++) {
		globalNodes[i].edgeCount = 0;
	}
	addedEdges.clear();

	for (let i = 1; i < reducedLen; i++) {
		const aId = reducedSeq[i - 1];
		const bId = reducedSeq[i];
		if (aId === bId) continue;

		const minId = Math.min(aId, bId);
		const maxId = Math.max(aId, bId);
		const edgeId = pairUnsigned(minId, maxId);

		if (addedEdges.has(edgeId)) continue;
		addedEdges.add(edgeId);

		const a = globalNodes[aId];
		const b = globalNodes[bId];

		a.orderedEdges[a.edgeCount++] = bId;
		b.orderedEdges[b.edgeCount++] = aId;
	}

	// let finalLen = 0;
	out[finalLen++] = pStart;

	let chunkLen = 0;
	chunkPoints[chunkLen++] = globalNodes[reducedSeq[0]].p!;

	for (let i = 1; i < reducedLen; i++) {
		const node = globalNodes[reducedSeq[i]];
		chunkPoints[chunkLen++] = node.p!;

		const isJunction = node.edgeCount !== 2 || i === reducedLen - 1;
		if (!isJunction) continue;

		finalLen = simplifyChunkAveraged(
			chunkPoints,
			chunkLen,
			out,
			finalLen,
			0.1,     // fitEpsilonSq
			0.0005,  // collinearEpsilonSq
			0.72     // sharpTurnCos
		);

		if (i !== reducedLen - 1) {
			chunkLen = 0;
			chunkPoints[chunkLen++] = node.p!;
		}
	}

	if (!out[finalLen - 1].equals(pEnd)) {
		out[finalLen++] = pEnd;
	}

	return { points: out, length: finalLen };
}

class GraphNode {
	id: number = 0;
	p: Vector2 | null = null;
	orderedEdges: number[] = [];
	edgeCount: number = 0;

	reset(id: number, p: Vector2) {
		this.id = id;
		this.p = p;
		this.edgeCount = 0;
	}
}

let currentBufferSize = 4096;

const globalNodes: GraphNode[] = [];
const spatialGrid = new Map<number, number[]>();
const gridArrayPool: number[][] = [];
let gridArrayPoolIdx = 0;

const addedEdges = new Set<number>();
const edgeVisitCount = new Map<number, number>();

let mergedSequence = new Uint32Array(currentBufferSize);
let reducedSeq = new Uint32Array(currentBufferSize);
let chunkPoints: Vector2[] = new Array(currentBufferSize);

function ensureCapacity(size: number) {
	if (size <= currentBufferSize) return;

	currentBufferSize = Math.ceil(size * 1.61803399);

	mergedSequence = new Uint32Array(currentBufferSize);
	reducedSeq = new Uint32Array(currentBufferSize);
	chunkPoints.length = currentBufferSize;
}

function simplifyChunkAveraged(
	chunkPoints: Vector2[],
	chunkLen: number,
	out: Vector2[],
	finalLen: number,
	fitEpsilonSq: number,
	collinearEpsilonSq: number,
	sharpTurnCos: number
): number {
	if (chunkLen <= 0) return finalLen;
	if (finalLen === 0 || !out[finalLen - 1].equals(chunkPoints[0])) {
		out[finalLen++] = chunkPoints[0];
	}
	if (chunkLen === 1) return finalLen;

	let anchor = 0;
	while (anchor < chunkLen - 1) {
		if (
			anchor + 2 < chunkLen &&
			isSharpTurn(chunkPoints[anchor], chunkPoints[anchor + 1], chunkPoints[anchor + 2], sharpTurnCos)
		) {
			if (!out[finalLen - 1].equals(chunkPoints[anchor + 1])) {
				out[finalLen++] = chunkPoints[anchor + 1];
			}
			anchor++;
			continue;
		}

		let end = anchor + 1;
		let sumX = 0;
		let sumY = 0;
		let interiorCount = 0;
		let worstDistSq = 0;
		let sawNonCollinear = false;

		while (end + 1 < chunkLen) {
			const candidateEnd = end + 1;

			if (
				candidateEnd < chunkLen - 1 &&
				isSharpTurn(
					chunkPoints[candidateEnd - 1],
					chunkPoints[candidateEnd],
					chunkPoints[candidateEnd + 1],
					sharpTurnCos
				)
			) {
				break;
			}

			let localWorst = 0;
			let localNonCollinear: boolean = sawNonCollinear;

			for (let i = anchor + 1; i < candidateEnd; i++) {
				const dSq = pointSegmentDistanceSq(
					chunkPoints[i],
					chunkPoints[anchor],
					chunkPoints[candidateEnd]
				);
				if (dSq > localWorst) localWorst = dSq;
				if (dSq > collinearEpsilonSq) localNonCollinear = true;
			}

			if (localWorst > fitEpsilonSq) break;

			end = candidateEnd;
			worstDistSq = localWorst;
			sawNonCollinear = localNonCollinear;
		}

		if (end === anchor + 1) {
			if (!out[finalLen - 1].equals(chunkPoints[end])) {
				out[finalLen++] = chunkPoints[end];
			}
			anchor = end;
			continue;
		}

		for (let i = anchor + 1; i < end; i++) {
			sumX += chunkPoints[i].x;
			sumY += chunkPoints[i].y;
			interiorCount++;
		}

		if (!sawNonCollinear || worstDistSq <= collinearEpsilonSq) {
			if (!out[finalLen - 1].equals(chunkPoints[end])) {
				out[finalLen++] = chunkPoints[end];
			}
			anchor = end;
			continue;
		}

		const avg = new Vector2(sumX / interiorCount, sumY / interiorCount);

		const ax = chunkPoints[anchor].x;
		const ay = chunkPoints[anchor].y;
		const bx = chunkPoints[end].x;
		const by = chunkPoints[end].y;
		const dx = bx - ax;
		const dy = by - ay;
		const lenSq = dx * dx + dy * dy;

		if (lenSq > 1e-12) {
			const t = ((avg.x - ax) * dx + (avg.y - ay) * dy) / lenSq;
			const projX = ax + t * dx;
			const projY = ay + t * dy;

			const rawDistSq = pointSegmentDistanceSq(avg, chunkPoints[anchor], chunkPoints[end]);
			const projDx = avg.x - projX;
			const projDy = avg.y - projY;
			const projErrSq = projDx * projDx + projDy * projDy;

			if (projErrSq < rawDistSq) {
				avg.x = projX;
				avg.y = projY;
			}
		}

		if (
			!out[finalLen - 1].equals(avg) &&
			!isCollinearTriplet(
				out[finalLen - 1],
				avg,
				chunkPoints[end],
				collinearEpsilonSq
			)
		) {
			out[finalLen++] = avg;
		}

		if (!out[finalLen - 1].equals(chunkPoints[end])) {
			out[finalLen++] = chunkPoints[end];
		}

		anchor = end;
	}

	return finalLen;
}

function isSharpTurn(a: Vector2, b: Vector2, c: Vector2, sharpTurnCos: number): boolean {
	let abx = b.x - a.x;
	let aby = b.y - a.y;
	let bcx = c.x - b.x;
	let bcy = c.y - b.y;

	const abLen = Math.sqrt(abx * abx + aby * aby);
	const bcLen = Math.sqrt(bcx * bcx + bcy * bcy);

	if (abLen < 1e-12 || bcLen < 1e-12) return false;

	abx /= abLen;
	aby /= abLen;
	bcx /= bcLen;
	bcy /= bcLen;

	const cosTheta = abx * bcx + aby * bcy;
	return cosTheta < sharpTurnCos;
}

function isCollinearTriplet(
	a: Vector2,
	b: Vector2,
	c: Vector2,
	collinearEpsilonSq: number
) {
	return pointSegmentDistanceSq(b, a, c) <= collinearEpsilonSq;
}

function pairSigned(x: number, y: number) {
	const BITS_PER_COORD = 26;
	const OFFSET = 1 << (BITS_PER_COORD - 1);
	return ((x + OFFSET) << BITS_PER_COORD) | (y + OFFSET);
}

function pairUnsigned(x: number, y: number) {
	return ((x + y) * (x + y + 1)) / 2 + y;
}

function distanceSq(a: Vector2, b: Vector2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function pointSegmentDistanceSq(p: Vector2, v: Vector2, w: Vector2): number {
	const l2 = distanceSq(v, w);
	if (l2 === 0) return distanceSq(p, v);

	let t =
		((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;

	t = Math.max(0, Math.min(1, t));

	const projX = v.x + t * (w.x - v.x);
	const projY = v.y + t * (w.y - v.y);
	const dx = p.x - projX;
	const dy = p.y - projY;

	return dx * dx + dy * dy;
}

function getVirtualPoint(
	path: SliderPath,
	startIdx: number,
	numPoints: number,
	pStart: Vector2,
	pEnd: Vector2,
	idx: number
): Vector2 {
	if (idx === 0) return pStart;
	if (idx === numPoints - 1) return pEnd;
	return path.calculatedPath[startIdx + idx - 1]; */
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