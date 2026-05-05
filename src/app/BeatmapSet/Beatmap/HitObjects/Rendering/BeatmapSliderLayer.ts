import { Application, Container, groupD8, Matrix, Point, Rectangle, Sprite, Texture } from 'pixi.js';
import { inject } from '../../../../Context.ts';
import type SliderProgressView from './CalculateSliderProgress.ts';
import SliderAtlasPage from './SliderAtlasPage.ts';
import SliderInstanceBatch from './SliderInstanceBatch.ts';
import type { AtlasSlot, SliderEntry, SliderUniformPatch, SliderVisualTarget } from './SliderAtlasTypes.ts';
import { type AtlasPackRequest, packAtlasTargets } from './SliderAtlasPacking.ts';
import {
	computePathRenderBounds,
	DEFAULT_ATLAS_SIZE,
	DEFAULT_BODY_STYLE,
	DEFAULT_GUTTER,
	DEFAULT_SELECTION_STYLE,
	intersectBounds,
	normalizeResolution,
	patchStyle,
	REDUCE_PRECISION,
	REDUCE_PRECISION_SQ,
	segmentCapsuleIntersectsRect,
	toPhysicalPixels,
	transformD8
} from './SliderAtlasUtils.ts';

export type BeatmapSliderLayerOptions = {
	app?: Application;
	coordinateSpace?: Container;
	atlasWidth?: number;
	atlasHeight?: number;
	gutter?: number;
};

type FrameMetrics = {
	viewport: Rectangle;
	resolution: number;
};

type PackablePayload = {
	entry: SliderEntry;
	target: SliderVisualTarget;
	renderRect: Rectangle;
	renderScaleX: number;
	renderScaleY: number;
	physicalWidth: number;
	physicalHeight: number;
};

const MAX_EFFECTIVE_RESOLUTION = 4;
const MAX_TARGET_DIMENSION = 32768;

export default class BeatmapSliderLayer {
	readonly entries: SliderEntry[] = [];

	private readonly freeIds: number[] = [];
	private readonly pages: SliderAtlasPage[] = [];
	private readonly app: Application;
	private readonly coordinateSpace?: Container;
	private readonly atlasWidth: number;
	private readonly atlasHeight: number;
	private readonly gutter: number;
	private readonly viewportBounds = new Rectangle;
	private readonly retiredTextures: Array<{ texture: Texture; retireFrame: number }> = [];
	private readonly retiredPages: Array<{ page: SliderAtlasPage; retireFrame: number }> = [];

	private readonly d8PointScratch = { x: 0, y: 0 };
	private readonly d8ExtentScratch = { x: 0, y: 0 };
	private readonly viewportScratch = [new Point(), new Point(), new Point(), new Point()];
	private readonly matrixScratch = new Matrix();

	private frameId = 0;
	private destroyed = false;
	private flushing = false;

	constructor(options: BeatmapSliderLayerOptions = {}) {
		const app = options.app ?? inject<Application>('ui/app');
		if (!app) throw new Error('BeatmapSliderLayer requires an Application.');

		this.app = app;
		this.coordinateSpace = options.coordinateSpace;
		this.atlasWidth = options.atlasWidth ?? DEFAULT_ATLAS_SIZE;
		this.atlasHeight = options.atlasHeight ?? DEFAULT_ATLAS_SIZE;
		this.gutter = options.gutter ?? DEFAULT_GUTTER;
	}

	createSlider(): number {
		const id = this.freeIds.pop() ?? this.entries.length;

		this.entries[id] = {
			alive: true,
			x: 0,
			y: 0,
			body: this.createVisualTarget(DEFAULT_BODY_STYLE, true, true),
			selection: this.createVisualTarget(DEFAULT_SELECTION_STYLE, false, true)
		};
		return id;
	}

	getEntry(id: number): SliderEntry {
		const entry = this.entries[id];
		if (!entry?.alive) throw new Error(`Slider entry ${id} is not alive.`);
		return entry;
	}

	deleteSlider(id: number) {
		const entry = this.entries[id];
		if (!entry?.alive) return;

		entry.alive = false;
		this.destroyVisualTarget(entry.body);
		this.destroyVisualTarget(entry.selection);
		this.freeIds.push(id);
	}

	setBodyVisible(id: number, visible: boolean) {
		this.setTargetVisible(this.getEntry(id).body, visible);
	}

	setSelectionVisible(id: number, visible: boolean) {
		this.setTargetVisible(this.getEntry(id).selection, visible);
	}

	setPosition(id: number, x: number, y: number) {
		const entry = this.getEntry(id);
		entry.x = x;
		entry.y = y;
	}

	setBodyStyle(id: number, patch: SliderUniformPatch) {
		const entry = this.getEntry(id);
		entry.body.style = patchStyle(entry.body.style, patch);
	}

	setSelectionStyle(id: number, patch: SliderUniformPatch) {
		const entry = this.getEntry(id);
		entry.selection.style = patchStyle(entry.selection.style, patch);
	}

	setBodyGeometrySource(id: number, path: SliderProgressView, radius: number) {
		const entry = this.getEntry(id);
		entry.body.path = path;
		entry.body.radius = radius;
		entry.body.enabled = true;
	}

	setSelectionGeometrySource(id: number, path: SliderProgressView, radius: number) {
		const entry = this.getEntry(id);
		entry.selection.path = path;
		entry.selection.radius = radius;
		entry.selection.enabled = true;
	}

	flush() {
		if (this.destroyed || this.flushing) return;

		this.flushing = true;
		this.frameId++;

		try {
			this.collectRetiredTextures();
			this.collectRetiredPages();
			this.prepareFrame();
			this.renderAtlasPages();
		} finally {
			this.releaseStaging();
			this.flushing = false;
		}
	}

	prepareFrame() {
		this.beginPages();

		const metrics = this.computeFrameMetrics();
		if (!metrics) {
			this.hideAllSprites();
			return;
		}

		const pendingAllocations: AtlasPackRequest<PackablePayload>[] = [];

		for (const entry of this.entries) {
			if (!entry?.alive) continue;
			this.gatherTarget(entry, entry.body, metrics, pendingAllocations);
			this.gatherTarget(entry, entry.selection, metrics, pendingAllocations);
		}

		if (pendingAllocations.length === 0) return;

		let packed;
		try {
			packed = packAtlasTargets(pendingAllocations, {
				width: this.atlasWidth,
				height: this.atlasHeight,
				gutter: this.gutter
			});
		} catch (error) {
			console.warn('Failed to pack slider atlas targets. Skipping this frame.', error);
			this.hidePendingTargets(pendingAllocations);
			return;
		}

		if (packed.length === 0) {
			this.hidePendingTargets(pendingAllocations);
			return;
		}

		packed.forEach((bin, binIndex) => {
			const page = this.getOrCreatePage(binIndex, bin.width, bin.height);

			for (const rect of bin.rects) {
				const payload = rect.data;
				const rotation = rect.rot ? groupD8.MAIN_DIAGONAL : groupD8.E;

				const slotSize = transformD8(
					rotation,
					payload.physicalWidth,
					payload.physicalHeight,
					this.d8ExtentScratch,
					true
				);

				const slotScale = transformD8(
					rotation,
					payload.renderScaleX,
					payload.renderScaleY,
					this.d8PointScratch,
					true
				);

				const slot: AtlasSlot = {
					page,
					x: rect.x,
					y: rect.y,
					width: slotSize.x,
					height: slotSize.y,
					scaleX: slotScale.x,
					scaleY: slotScale.y
				};

				this.reduceProgressViewIntoBatch(
					payload.target.path!,
					page.batch,
					payload.renderRect,
					slot,
					payload.target.radius,
					payload.target.style,
					rotation
				);

				slot.page.markUsed();
				this.updateSprite(payload.entry, payload.target, slot, payload.renderRect, rotation);
			}
		});

		for (const page of this.pages) page.upload();
	}

	private beginPages() {
		for (const page of this.pages) page.beginFrame(this.app.renderer);
	}

	private hidePendingTargets(pendingAllocations: AtlasPackRequest<PackablePayload>[]) {
		for (const allocation of pendingAllocations) {
			allocation.data.target.sprite.visible = false;
		}
	}

	renderAtlasPages() {
		for (const page of this.pages) page.render(this.app);
	}

	releaseStaging() {
		for (const page of this.pages) page.releaseStaging();
	}

	destroy() {
		this.destroyed = true;
		
		for (const entry of this.entries) {
			if (!entry?.alive) continue;
			this.destroyVisualTarget(entry.body);
			this.destroyVisualTarget(entry.selection);
			entry.alive = false;
		}

		for (const page of this.pages) page.destroy();
		this.pages.length = 0;
		this.entries.length = 0;
		this.freeIds.length = 0;

		for (const retired of this.retiredTextures) retired.texture.destroy(false);
		this.retiredTextures.length = 0;

		for (const retired of this.retiredPages) retired.page.destroy();
		this.retiredPages.length = 0;
	}

	private createVisualTarget(
		style: SliderVisualTarget['style'],
		enabled: boolean,
		visible: boolean
	): SliderVisualTarget {
		const sprite = new Sprite(Texture.EMPTY);
		sprite.anchor.set(0, 0);
		sprite.visible = false;
		sprite.blendMode = 'normal';

		return {
			sprite,
			frame: new Rectangle(),
			radius: 1,
			style,
			enabled,
			visible
		};
	}

	private setTargetVisible(target: SliderVisualTarget, visible: boolean) {
		target.visible = visible;
		if (!visible) target.sprite.visible = false;
	}

	private destroyVisualTarget(target: SliderVisualTarget) {
		if (target.texture) {
			this.retireTexture(target.texture);
			target.texture = undefined;
		}

		target.sprite.texture = Texture.EMPTY;
		target.sprite.destroy(true);
	}

	private canPrepareTarget(target: SliderVisualTarget): target is SliderVisualTarget & { path: SliderProgressView } {
		if (!target.visible || !target.enabled || !target.path || target.path.length <= 0) {
			return false;
		}

		let cur: Container | null = target.sprite.parent;
		while (cur) {
			if (!cur.visible || !cur.renderable) return false;
			if (cur === this.app.stage) return true;
			cur = cur.parent;
		}

		return false;
	}

	private gatherTarget(
		entry: SliderEntry,
		target: SliderVisualTarget,
		metrics: FrameMetrics,
		pendingAllocations: AtlasPackRequest<PackablePayload>[]
	) {
		if (!this.canPrepareTarget(target)) {
			target.sprite.visible = false;
			return;
		}

		const localBounds = computePathRenderBounds(target.path!, target.radius);
		if (!isUsableRect(localBounds)) {
			target.sprite.visible = false;
			return;
		}
		const worldRenderBounds = new Rectangle(
			entry.x + localBounds.x,
			entry.y + localBounds.y,
			localBounds.width,
			localBounds.height
		);

		if (!isUsableRect(worldRenderBounds)) {
			target.sprite.visible = false;
			return;
		}

		const clippedWorld = intersectBounds(worldRenderBounds, metrics.viewport);
		if (!clippedWorld) {
			target.sprite.visible = false;
			return;
		}

		const renderRect = new Rectangle(
			clippedWorld.x - entry.x,
			clippedWorld.y - entry.y,
			clippedWorld.width,
			clippedWorld.height
		);

		if (!isUsableRect(renderRect)) {
			target.sprite.visible = false;
			return;
		}

		const logicalWidth = renderRect.width;
		const logicalHeight = renderRect.height;
		const physicalWidth = toPhysicalPixels(logicalWidth, metrics.resolution);
		const physicalHeight = toPhysicalPixels(logicalHeight, metrics.resolution);

		if (!isUsableDimension(physicalWidth) || !isUsableDimension(physicalHeight)) {
			target.sprite.visible = false;
			return;
		}

		const renderScaleX = physicalWidth / logicalWidth;
		const renderScaleY = physicalHeight / logicalHeight;

		if (!Number.isFinite(renderScaleX) || !Number.isFinite(renderScaleY)) {
			target.sprite.visible = false;
			return;
		}

		pendingAllocations.push({
			width: physicalWidth,
			height: physicalHeight,
			data: {
				entry,
				target,
				renderRect,
				renderScaleX,
				renderScaleY,
				physicalWidth,
				physicalHeight
			}
		});
	}

	private updateSprite(
		entry: SliderEntry,
		target: SliderVisualTarget,
		slot: AtlasSlot,
		renderRect: Rectangle,
		rotation: number
	) {
		target.frame.x = slot.x;
		target.frame.y = slot.y;
		target.frame.width = slot.width;
		target.frame.height = slot.height;

		const sourceChanged = target.texture?.source !== slot.page.texture.source;
		const frameSizeChanged = !!target.texture && (
			target.texture.frame.width !== slot.width ||
			target.texture.frame.height !== slot.height
		);
		const rotationChanged = target.texture?.rotate !== rotation;

		if (!target.texture || sourceChanged || frameSizeChanged || rotationChanged) {
			if (target.texture) this.retireTexture(target.texture);

			target.texture = new Texture({
				source: slot.page.texture.source,
				frame: target.frame.clone(),
				rotate: rotation
			});

			target.sprite.texture = target.texture;
		} else {
			target.texture.frame.copyFrom(target.frame);
			target.texture.updateUvs();
		}

		target.sprite.position.set(entry.x + renderRect.x, entry.y + renderRect.y);
		target.sprite.rotation = 0;
		target.sprite.scale.set(
			renderRect.width / slot.width,
			renderRect.height / slot.height
		);
		target.sprite.visible = true;
	}

	private retirePage(page: SliderAtlasPage) {
		this.retiredPages.push({ page, retireFrame: this.frameId });
	}

	private collectRetiredPages() {
		let write = 0;

		for (let i = 0; i < this.retiredPages.length; i++) {
			const retired = this.retiredPages[i];
			if (this.frameId - retired.retireFrame >= 4) {
				retired.page.destroy();
			} else {
				this.retiredPages[write++] = retired;
			}
		}

		this.retiredPages.length = write;
	}

	private retireTexture(texture: Texture) {
		this.retiredTextures.push({ texture, retireFrame: this.frameId });
	}

	private collectRetiredTextures() {
		let write = 0;

		for (let i = 0; i < this.retiredTextures.length; i++) {
			const retired = this.retiredTextures[i];
			if (this.frameId - retired.retireFrame >= 2) {
				retired.texture.destroy(false);
			} else {
				this.retiredTextures[write++] = retired;
			}
		}

		this.retiredTextures.length = write;
	}


	private getOrCreatePage(
		index: number,
		width: number,
		height: number
	): SliderAtlasPage {
		let page = this.pages[index];
		if (page && page.width === width && page.height === height) return page;

		if (page) this.retirePage(page);

		page = new SliderAtlasPage(width, height, `slider-atlas-${index}-${width}x${height}`);
		this.pages[index] = page;
		return page;
	}

	private reduceProgressViewIntoBatch(
		path: SliderProgressView,
		batch: SliderInstanceBatch,
		renderRect: Rectangle,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style'],
		rotation: number
	) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		const calcPath = path.calcPath;
		const interiorBase = path.interiorBase;
		const interiorLength = path.interiorLength;

		let ax = path.startX;
		let ay = path.startY;

		if (pointsCount === 1) {
			this.pushClippedSegment(batch, ax, ay, ax, ay, renderRect, slot, radius, style, rotation);
			return;
		}

		let bx: number;
		let by: number;

		if (interiorLength > 0) {
			const p = calcPath[interiorBase];
			bx = p.x;
			by = p.y;
		} else {
			bx = path.endX;
			by = path.endY;
		}

		for (let i = 1; i < pointsCount - 1; i++) {
			const nextInteriorIndex = i;
			let nx: number;
			let ny: number;

			if (nextInteriorIndex < interiorLength) {
				const p = calcPath[interiorBase + nextInteriorIndex];
				nx = p.x;
				ny = p.y;
			} else {
				nx = path.endX;
				ny = path.endY;
			}

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

			this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style, rotation);

			if (i - 1 < interiorLength) {
				const p = calcPath[interiorBase + i - 1];
				ax = p.x;
				ay = p.y;
			} else {
				ax = path.endX;
				ay = path.endY;
			}

			bx = nx;
			by = ny;
		}

		this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style, rotation);
	}

	private pushClippedSegment(
		batch: SliderInstanceBatch,
		ax: number,
		ay: number,
		bx: number,
		by: number,
		renderRect: Rectangle,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style'],
		rotation: number
	) {
		if (!segmentCapsuleIntersectsRect(ax, ay, bx, by, radius, renderRect)) return;

		const a = transformD8(rotation, ax, ay, this.d8PointScratch);
		const tax = a.x;
		const tay = a.y;

		const b = transformD8(rotation, bx, by, this.d8PointScratch);
		const tbx = b.x;
		const tby = b.y;

		const renderOrigin = transformD8(
			rotation,
			renderRect.x,
			renderRect.y,
			this.d8ExtentScratch
		);

		batch.pushSegment(
			tax,
			tay,
			tbx,
			tby,

			renderOrigin.x,
			renderOrigin.y,

			slot.scaleX,
			slot.scaleY,
			slot.x,
			slot.y,
			slot.width,
			slot.height,
			radius,
			style
		);
	}

	private resolveCoordinateSpace(): Container | undefined {
		const space = this.coordinateSpace ?? this.app.stage;
		if (!this.isAttachedToStage(space)) return undefined;
		return space;
	}

	private isAttachedToStage(node: Container): boolean {
		let cur: Container | null = node;

		while (cur) {
			if (cur === this.app.stage) return true;
			cur = cur.parent;
		}

		return false;
	}

	private hideAllSprites() {
		for (const entry of this.entries) {
			if (!entry?.alive) continue;
			entry.body.sprite.visible = false;
			entry.selection.sprite.visible = false;
		}
	}

	private computeFrameMetrics(): FrameMetrics | undefined {
		const space = this.resolveCoordinateSpace();
		if (!space) return undefined;

		const screen = this.app.renderer.screen;
		if (!Number.isFinite(screen.width) || !Number.isFinite(screen.height) ||
			screen.width <= 0 || screen.height <= 0) {
			return undefined;
		}

		const worldTransform = space.getGlobalTransform(this.matrixScratch, false);
		const scaleX = Math.sqrt(worldTransform.a * worldTransform.a + worldTransform.b * worldTransform.b);
		const scaleY = Math.sqrt(worldTransform.c * worldTransform.c + worldTransform.d * worldTransform.d);
		const worldScale = Math.max(scaleX, scaleY);

		if (!Number.isFinite(worldScale) || worldScale <= 0) return undefined;

		this.computeViewportBoundsInto(space, this.viewportBounds);
		if (!isUsableRect(this.viewportBounds)) return undefined;

		const resolution = Math.min(
			MAX_EFFECTIVE_RESOLUTION,
			normalizeResolution(this.app.renderer.resolution * worldScale)
		);

		if (!Number.isFinite(resolution) || resolution <= 0) return undefined;

		return {
			viewport: this.viewportBounds,
			resolution
		};
	}

	private computeViewportBoundsInto(space: Container, out: Rectangle): void {
		const screen = this.app.renderer.screen;
		const points = this.viewportScratch;

		space.updateLocalTransform();
		space.toLocal({ x: screen.left, y: screen.top }, undefined, points[0], true);
		space.toLocal({ x: screen.right, y: screen.top }, undefined, points[1], true);
		space.toLocal({ x: screen.left, y: screen.bottom }, undefined, points[2], true);
		space.toLocal({ x: screen.right, y: screen.bottom }, undefined, points[3], true);

		const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
		const maxX = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
		const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
		const maxY = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);

		out.set(minX, minY, maxX - minX, maxY - minY);
	}
}

function isUsableRect(rect: Rectangle): boolean {
	return Number.isFinite(rect.x) &&
		Number.isFinite(rect.y) &&
		isUsableDimension(rect.width) &&
		isUsableDimension(rect.height);
}

function isUsableDimension(value: number): boolean {
	return Number.isFinite(value) &&
		value > 0 &&
		value <= MAX_TARGET_DIMENSION;
}
