import { Point, Rectangle } from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import SliderCoverageBatch from './SliderCoverageBatch.ts';
import type { AtlasSlot } from './SliderAtlasTypes.ts';
import {
	REDUCE_PRECISION,
	REDUCE_PRECISION_SQ,
	segmentCapsuleIntersectsRect,
	transformD8
} from './SliderAtlasUtils.ts';

export default class SliderSegmentReducer {
	private readonly point = new Point();

	reduce(path: SliderProgressView, batch: SliderCoverageBatch, renderRect: Rectangle, slot: AtlasSlot, radius: number, rotation: number) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		const scratch = this.point;
		transformD8(rotation, renderRect.x, renderRect.y, scratch);
		const originX = scratch.x;
		const originY = scratch.y;
		let ax = path.startX;
		let ay = path.startY;

		if (pointsCount === 1) {
			this.pushVisible(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, ax, ay);
			return;
		}

		let bx = pathPointX(path, 1);
		let by = pathPointY(path, 1);

		for (let i = 1; i < pointsCount - 1; i++) {
			const nx = pathPointX(path, i + 1);
			const ny = pathPointY(path, i + 1);
			const dx = bx - ax;
			const dy = by - ay;
			const lenSq = dx * dx + dy * dy;

			if (lenSq < REDUCE_PRECISION) {
				bx = nx;
				by = ny;
				continue;
			}

			const dx2 = nx - ax;
			const dy2 = ny - ay;
			const cross = dx * dy2 - dy * dx2;

			if ((cross * cross) / lenSq < REDUCE_PRECISION_SQ) {
				const dot = dx * dx2 + dy * dy2;
				if (dot < 0) {
					ax = nx;
					ay = ny;
				} else if (dot > lenSq) {
					bx = nx;
					by = ny;
				}
				continue;
			}

			this.pushVisible(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, bx, by);
			ax = pathPointX(path, i);
			ay = pathPointY(path, i);
			bx = nx;
			by = ny;
		}

		this.pushVisible(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, bx, by);
	}

	private pushVisible(
		batch: SliderCoverageBatch,
		renderRect: Rectangle,
		slot: AtlasSlot,
		radius: number,
		rotation: number,
		originX: number,
		originY: number,
		ax: number,
		ay: number,
		bx: number,
		by: number
	) {
		if (!segmentCapsuleIntersectsRect(ax, ay, bx, by, radius, renderRect)) return;

		const scratch = this.point;
		transformD8(rotation, ax, ay, scratch);
		const rAx = scratch.x;
		const rAy = scratch.y;
		transformD8(rotation, bx, by, scratch);
		batch.pushSegment(
			rAx, rAy, scratch.x, scratch.y, originX, originY,
			slot.scaleX, slot.scaleY, slot.x, slot.y, slot.width, slot.height, radius
		);
	}
}

function pathPointX(path: SliderProgressView, index: number): number {
	if (index === 0) return path.startX;
	const interiorIndex = index - 1;
	return interiorIndex < path.interiorLength
		? path.calcPath[path.interiorBase + interiorIndex].x
		: path.endX;
}

function pathPointY(path: SliderProgressView, index: number): number {
	if (index === 0) return path.startY;
	const interiorIndex = index - 1;
	return interiorIndex < path.interiorLength
		? path.calcPath[path.interiorBase + interiorIndex].y
		: path.endY;
}
