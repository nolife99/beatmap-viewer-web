import {
	Container,
	type DestroyOptions,
	Matrix,
	Point,
	Rectangle,
	RenderContainer,
	type Renderer,
	Sprite,
	Texture
} from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import SliderAtlasPage from './SliderAtlasPage.ts';
import SliderInstanceBatch from './SliderInstanceBatch.ts';
import type {
	AtlasSlot,
	SliderBodyHandle,
	SliderInstanceStyle,
	SliderUniformPatch,
	SliderVisualTarget
} from './SliderAtlasTypes.ts';
import { type AtlasPackRequest, packAtlasTargets } from './SliderAtlasPacking.ts';
import {
	computePathRenderBounds,
	DEFAULT_ATLAS_SIZE,
	DEFAULT_BODY_STYLE,
	DEFAULT_GUTTER,
	DEFAULT_SELECTION_STYLE,
	getAtlasRotation,
	normalizeResolution,
	patchStyle,
	REDUCE_PRECISION,
	REDUCE_PRECISION_SQ,
	segmentCapsuleIntersectsRect,
	toPhysicalPixels,
	transformD8
} from './SliderAtlasUtils.ts';

export type BeatmapSliderLayerOptions = {
	app?: unknown;
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
	handle: SliderBodyHandle;
	target: SliderVisualTarget;
	renderRect: Rectangle;
	renderScaleX: number;
	renderScaleY: number;
	physicalWidth: number;
	physicalHeight: number;
};

const MAX_EFFECTIVE_RESOLUTION = 4;
const MAX_TARGET_DIMENSION = 32768;
const TEXTURE_RETIRE_FRAMES = 2;
const PAGE_RETIRE_FRAMES = TEXTURE_RETIRE_FRAMES + 2;

export default class BeatmapSliderLayer extends RenderContainer {
	readonly handles: SliderBodyHandle[] = [];

	private readonly pages: SliderAtlasPage[] = [];
	private readonly atlasWidth: number;
	private readonly atlasHeight: number;
	private readonly gutter: number;

	private readonly matrixScratch = new Matrix();
	private readonly pointScratch = new Point();
	private readonly viewportBounds = new Rectangle();

	private readonly visibilityCache = new Map<Container, boolean>();
	private lastCheckedParent: Container | null = null;
	private lastCheckedParentVisible: boolean = false;

	private previouslyRenderedTargets: SliderVisualTarget[] = [];
	private currentlyRenderedTargets: SliderVisualTarget[] = [];

	private readonly retiredTextures: Array<{ texture: Texture; retireFrame: number }> = [];
	private readonly retiredPages: Array<{ page: SliderAtlasPage; retireFrame: number }> = [];

	private frameId = 0;
	private lastPreparedFrameId = -1;
	private lastAtlasRenderedFrameId = -1;

	private preparing = false;
	private disposed = false;
	private registeredRenderer: Renderer | null = null;

	constructor(options: BeatmapSliderLayerOptions = {}) {
		super({});
		this.atlasWidth = options.atlasWidth ?? DEFAULT_ATLAS_SIZE;
		this.atlasHeight = options.atlasHeight ?? DEFAULT_ATLAS_SIZE;
		this.gutter = options.gutter ?? DEFAULT_GUTTER;
	}

	prerender() {
		if (this.disposed || !this.registeredRenderer) return;
		this.frameId++;
		this.runPrepare(this.registeredRenderer);
	}

	override render(renderer: Renderer) {
		if (this.registeredRenderer !== renderer) {
			if (this.registeredRenderer) {
				this.registeredRenderer.runners.prerender.remove(this);
			}

			this.registeredRenderer = renderer;
			renderer.runners.prerender.add(this);
		}

		this.runPrepare(renderer);
		this.runAtlasRender(renderer);
	}

	createSlider(bodySprite: Sprite, selectionSprite: Sprite): SliderBodyHandle {
		const handle: SliderBodyHandle = {
			alive: true,
			x: 0,
			y: 0,
			body: this.createVisualTarget(bodySprite, DEFAULT_BODY_STYLE, false, false),
			selection: this.createVisualTarget(selectionSprite, DEFAULT_SELECTION_STYLE, false, false)
		};

		this.handles.push(handle);
		return handle;
	}

	deleteSlider(handle: SliderBodyHandle) {
		if (!handle.alive) return;

		handle.alive = false;
		this.releaseVisualTarget(handle.body);
		this.releaseVisualTarget(handle.selection);

		const index = this.handles.indexOf(handle);
		if (index >= 0) this.handles.splice(index, 1);
	}

	setBodyVisible(handle: SliderBodyHandle, visible: boolean) {
		this.setTargetVisible(handle.body, visible);
	}

	setSelectionVisible(handle: SliderBodyHandle, visible: boolean) {
		this.setTargetVisible(handle.selection, visible);
	}

	setPosition(handle: SliderBodyHandle, x: number, y: number) {
		handle.x = x;
		handle.y = y;
	}

	setBodyStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) {
		handle.body.style = patchStyle(handle.body.style, patch);
	}

	setSelectionStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) {
		handle.selection.style = patchStyle(handle.selection.style, patch);
	}

	setBodyGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) {
		handle.body.path = path;
		handle.body.radius = radius;
		handle.body.enabled = true;
	}

	setSelectionGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) {
		handle.selection.path = path;
		handle.selection.radius = radius;
		handle.selection.enabled = true;
	}

	override destroy(options?: DestroyOptions) {
		if (this.disposed) return;
		this.disposed = true;

		if (this.registeredRenderer) {
			this.registeredRenderer.runners.prerender.remove(this);
			this.registeredRenderer = null;
		}

		for (const handle of this.handles) {
			if (!handle.alive) continue;

			this.releaseVisualTarget(handle.body);
			this.releaseVisualTarget(handle.selection);
			handle.alive = false;
		}

		for (const page of this.pages) page.destroy();
		this.pages.length = 0;
		this.handles.length = 0;

		for (const retired of this.retiredTextures) retired.texture.destroy(false);
		this.retiredTextures.length = 0;

		for (const retired of this.retiredPages) retired.page.destroy();
		this.retiredPages.length = 0;
		this.previouslyRenderedTargets.length = 0;
		this.currentlyRenderedTargets.length = 0;

		super.destroy(options);
	}

	private runPrepare(renderer: Renderer) {
		if (this.disposed || this.preparing) return;
		if (this.lastPreparedFrameId >= this.frameId) return;

		this.preparing = true;
		this.lastPreparedFrameId = this.frameId;

		this.visibilityCache.clear();
		this.lastCheckedParent = null;

		try {
			this.collectRetiredTextures();
			this.collectRetiredPages();
			this.prepareFrame(renderer);
		} finally {
			this.preparing = false;
		}
	}

	private runAtlasRender(renderer: Renderer) {
		if (this.disposed) return;
		if (this.lastAtlasRenderedFrameId >= this.frameId) return;

		this.lastAtlasRenderedFrameId = this.frameId;

		try {
			this.renderAtlasPages(renderer);
		} finally {
			this.releaseStaging();
		}
	}

	private prepareFrame(renderer: Renderer) {
		this.beginPages();

		const metrics = this.computeFrameMetrics(renderer);
		const root = this.getSceneRoot();

		if (!metrics || !root || !this.isBranchRenderableToRoot(this, root)) {
			this.hideAllSprites();
			return;
		}

		this.currentlyRenderedTargets.length = 0;
		const pendingAllocations: AtlasPackRequest<PackablePayload>[] = [];

		for (const handle of this.handles) {
			if (!handle.alive) continue;

			this.gatherTarget(handle, handle.body, metrics, root, pendingAllocations);
			this.gatherTarget(handle, handle.selection, metrics, root, pendingAllocations);
		}

		if (pendingAllocations.length > 0) {
			let packed;

			try {
				packed = packAtlasTargets(pendingAllocations, {
					width: this.atlasWidth,
					height: this.atlasHeight,
					gutter: this.gutter
				});
			} catch (error) {
				console.warn('Failed to pack slider atlas targets. Skipping this frame.', error);
				this.hideAllSprites();
				return;
			}

			if (packed.length === 0) {
				this.hideAllSprites();
				return;
			}

			for (let binIndex = 0; binIndex < packed.length; binIndex++) {
				const bin = packed[binIndex];
				const page = this.getOrCreatePage(binIndex, bin.width, bin.height);

				for (const rect of bin.rects) {
					const payload = rect.data as PackablePayload;
					const target = payload.target;
					const rotation = getAtlasRotation(!!rect.rot);

					const scratch = this.pointScratch;

					transformD8(rotation, payload.physicalWidth, payload.physicalHeight, scratch, true);
					const slotWidth = scratch.x;
					const slotHeight = scratch.y;

					transformD8(rotation, payload.renderScaleX, payload.renderScaleY, scratch, true);
					const slotScaleX = scratch.x;
					const slotScaleY = scratch.y;

					const slot: AtlasSlot = {
						page, x: rect.x, y: rect.y,
						width: slotWidth, height: slotHeight,
						scaleX: slotScaleX, scaleY: slotScaleY
					};

					this.reduceProgressViewIntoBatch(
						target.path!, page.batch, payload.renderRect,
						slot, target.radius, target.style, rotation
					);

					page.markUsed();
					this.updateSprite(payload.handle, target, slot, payload.renderRect, rotation);

					target.placedFrame = this.frameId;
					this.currentlyRenderedTargets.push(target);
				}
			}
		}

		for (let i = 0; i < this.previouslyRenderedTargets.length; i++) {
			const oldTarget = this.previouslyRenderedTargets[i];
			if (oldTarget.placedFrame !== this.frameId && oldTarget.sprite.renderable) {
				oldTarget.sprite.renderable = false;
			}
		}

		const temp = this.previouslyRenderedTargets;
		this.previouslyRenderedTargets = this.currentlyRenderedTargets;
		this.currentlyRenderedTargets = temp;

		for (const page of this.pages) page.upload();
	}

	private beginPages() {
		for (const page of this.pages) page.beginFrame();
	}

	private renderAtlasPages(renderer: Renderer) {
		for (const page of this.pages) page.render(renderer);
	}

	private releaseStaging() {
		for (const page of this.pages) page.releaseStaging();
	}

	private createVisualTarget(
		sprite: Sprite, style: SliderInstanceStyle, enabled: boolean, visible: boolean
	): SliderVisualTarget {
		if (sprite.anchor.x !== 0 || sprite.anchor.y !== 0) sprite.anchor.set(0, 0);

		if (!sprite.visible) sprite.visible = true;
		if (sprite.renderable) sprite.renderable = false;

		return {
			sprite, texture: undefined, path: undefined, frame: new Rectangle(),
			radius: 1, style, enabled, visible, placedFrame: -1
		};
	}

	private setTargetVisible(target: SliderVisualTarget, visible: boolean) {
		target.visible = visible;
		if (!visible && target.sprite.renderable) {
			target.sprite.renderable = false;
		}
	}

	private releaseVisualTarget(target: SliderVisualTarget) {
		if (target.sprite.texture !== Texture.EMPTY) target.sprite.texture = Texture.EMPTY;
		if (target.sprite.renderable) target.sprite.renderable = false;

		if (target.texture) {
			this.retireTexture(target.texture);
			target.texture = undefined;
		}

		target.path = undefined;
		target.enabled = false;
	}

	private updateSprite(
		handle: SliderBodyHandle, target: SliderVisualTarget, slot: AtlasSlot,
		renderRect: Rectangle, rotation: number
	) {
		target.frame.set(slot.x, slot.y, slot.width, slot.height);

		const existing = target.texture;
		const sourceChanged = existing?.source !== slot.page.texture.source;
		const sizeChanged = !!existing && (
			existing.frame.width !== slot.width ||
			existing.frame.height !== slot.height
		);
		const rotationChanged = existing?.rotate !== rotation;

		if (!existing || sourceChanged || sizeChanged || rotationChanged) {
			const next = new Texture({
				source: slot.page.texture.source,
				frame: target.frame.clone(),
				rotate: rotation
			});

			if (target.sprite.texture !== next) target.sprite.texture = next;
			if (existing) this.retireTexture(existing);
			target.texture = next;
		} else if (existing.frame.x !== slot.x || existing.frame.y !== slot.y) {
			existing.frame.copyFrom(target.frame);
			existing.updateUvs();
		}

		const sprite = target.sprite;
		const nextX = handle.x + renderRect.x;
		const nextY = handle.y + renderRect.y;
		const nextScaleX = renderRect.width / slot.width;
		const nextScaleY = renderRect.height / slot.height;

		if (sprite.position.x !== nextX || sprite.position.y !== nextY) {
			sprite.position.set(nextX, nextY);
		}

		if (sprite.rotation !== 0) sprite.rotation = 0;

		if (sprite.scale.x !== nextScaleX || sprite.scale.y !== nextScaleY) {
			sprite.scale.set(nextScaleX, nextScaleY);
		}

		if (!sprite.renderable) sprite.renderable = true;
	}

	private isBranchRenderableToRoot(container: Container, root: Container): boolean {
		const cached = this.visibilityCache.get(container);
		if (cached !== undefined) return cached;

		let visible: boolean;

		if (!container.visible || !container.renderable) {
			visible = false;
		} else if (container === root) {
			visible = true;
		} else {
			const parent = container.parent;
			visible = !!parent && this.isBranchRenderableToRoot(parent, root);
		}

		this.visibilityCache.set(container, visible);
		return visible;
	}

	private gatherTarget(
		handle: SliderBodyHandle, target: SliderVisualTarget, metrics: FrameMetrics,
		root: Container, pendingAllocations: AtlasPackRequest<PackablePayload>[]
	) {
		if (!target.visible || !target.enabled || !target.path || target.path.length <= 0) return;

		const parent = target.sprite.parent;
		if (!parent) return;

		if (parent !== this) {
			if (parent === this.lastCheckedParent) {
				if (!this.lastCheckedParentVisible) return;
			} else {
				this.lastCheckedParent = parent;
				this.lastCheckedParentVisible = this.isBranchRenderableToRoot(parent, root);
				if (!this.lastCheckedParentVisible) return;
			}
		}

		const localBounds = computePathRenderBounds(target.path, target.radius);
		if (!isUsableRect(localBounds)) return;

		const worldX = handle.x + localBounds.x;
		const worldY = handle.y + localBounds.y;
		const worldRight = worldX + localBounds.width;
		const worldBottom = worldY + localBounds.height;

		if (
			!Number.isFinite(worldX) || !Number.isFinite(worldY) ||
			!Number.isFinite(worldRight) || !Number.isFinite(worldBottom)
		) return;

		const viewport = metrics.viewport;
		const viewportRight = viewport.x + viewport.width;
		const viewportBottom = viewport.y + viewport.height;

		const clippedX = worldX > viewport.x ? worldX : viewport.x;
		const clippedY = worldY > viewport.y ? worldY : viewport.y;
		const clippedRight = worldRight < viewportRight ? worldRight : viewportRight;
		const clippedBottom = worldBottom < viewportBottom ? worldBottom : viewportBottom;

		const clippedWidth = clippedRight - clippedX;
		const clippedHeight = clippedBottom - clippedY;

		if (!isUsableDimension(clippedWidth) || !isUsableDimension(clippedHeight)) return;

		const renderX = clippedX - handle.x;
		const renderY = clippedY - handle.y;
		const physicalWidth = toPhysicalPixels(clippedWidth, metrics.resolution);
		const physicalHeight = toPhysicalPixels(clippedHeight, metrics.resolution);

		if (!isUsableDimension(physicalWidth) || !isUsableDimension(physicalHeight)) return;

		const renderScaleX = physicalWidth / clippedWidth;
		const renderScaleY = physicalHeight / clippedHeight;

		if (!Number.isFinite(renderScaleX) || !Number.isFinite(renderScaleY)) return;

		pendingAllocations.push({
			width: physicalWidth,
			height: physicalHeight,
			data: {
				handle, target,
				renderRect: new Rectangle(renderX, renderY, clippedWidth, clippedHeight),
				renderScaleX, renderScaleY, physicalWidth, physicalHeight
			}
		});
	}

	private hideAllSprites() {
		if (this.previouslyRenderedTargets.length === 0) return;

		for (let i = 0; i < this.previouslyRenderedTargets.length; i++) {
			const target = this.previouslyRenderedTargets[i];
			if (target.sprite.renderable) target.sprite.renderable = false;
		}

		this.previouslyRenderedTargets.length = 0;
	}

	private reduceProgressViewIntoBatch(
		path: SliderProgressView, batch: SliderInstanceBatch, renderRect: Rectangle,
		slot: AtlasSlot, radius: number, style: SliderVisualTarget['style'], rotation: number
	) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		const calcPath = path.calcPath;
		const interiorBase = path.interiorBase;
		const interiorLength = path.interiorLength;
		const scratch = this.pointScratch;

		transformD8(rotation, renderRect.x, renderRect.y, scratch);
		const originX = scratch.x;
		const originY = scratch.y;

		const sScaleX = slot.scaleX;
		const sScaleY = slot.scaleY;
		const sX = slot.x;
		const sY = slot.y;
		const sWidth = slot.width;
		const sHeight = slot.height;

		let ax = path.startX;
		let ay = path.startY;

		if (pointsCount === 1) {
			if (segmentCapsuleIntersectsRect(ax, ay, ax, ay, radius, renderRect)) {
				transformD8(rotation, ax, ay, scratch);
				batch.pushSegment(
					scratch.x, scratch.y, scratch.x, scratch.y, originX, originY,
					sScaleX, sScaleY, sX, sY, sWidth, sHeight, radius, style
				);
			}
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

			if (segmentCapsuleIntersectsRect(ax, ay, bx, by, radius, renderRect)) {
				transformD8(rotation, ax, ay, scratch);
				const rAx = scratch.x;
				const rAy = scratch.y;

				transformD8(rotation, bx, by, scratch);
				batch.pushSegment(
					rAx, rAy, scratch.x, scratch.y, originX, originY,
					sScaleX, sScaleY, sX, sY, sWidth, sHeight, radius, style
				);
			}

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

		// Final segment inline
		if (segmentCapsuleIntersectsRect(ax, ay, bx, by, radius, renderRect)) {
			transformD8(rotation, ax, ay, scratch);
			const rAx = scratch.x;
			const rAy = scratch.y;

			transformD8(rotation, bx, by, scratch);
			batch.pushSegment(
				rAx, rAy, scratch.x, scratch.y, originX, originY,
				sScaleX, sScaleY, sX, sY, sWidth, sHeight, radius, style
			);
		}
	}

	private getOrCreatePage(index: number, width: number, height: number): SliderAtlasPage {
		let page = this.pages[index];
		if (page && page.width >= width && page.height >= height) return page;

		if (page) this.retirePage(page);

		page = new SliderAtlasPage(width, height, `slider-atlas-${index}-${width}x${height}`);
		this.pages[index] = page;
		return page;
	}

	private retirePage(page: SliderAtlasPage) {
		this.retiredPages.push({ page, retireFrame: this.frameId });
	}

	private collectRetiredPages() {
		let write = 0;

		for (let i = 0; i < this.retiredPages.length; i++) {
			const retired = this.retiredPages[i];

			if (this.frameId - retired.retireFrame >= PAGE_RETIRE_FRAMES) {
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

			if (this.frameId - retired.retireFrame >= TEXTURE_RETIRE_FRAMES) {
				retired.texture.destroy(false);
			} else {
				this.retiredTextures[write++] = retired;
			}
		}

		this.retiredTextures.length = write;
	}

	private computeFrameMetrics(renderer: Renderer): FrameMetrics | undefined {
		const screen = renderer.screen;

		if (
			!Number.isFinite(screen.width) || !Number.isFinite(screen.height) ||
			screen.width <= 0 || screen.height <= 0
		) return undefined;

		const worldTransform = this.getGlobalTransform(this.matrixScratch, false);
		const scaleX = Math.sqrt(worldTransform.a * worldTransform.a + worldTransform.b * worldTransform.b);
		const scaleY = Math.sqrt(worldTransform.c * worldTransform.c + worldTransform.d * worldTransform.d);
		const worldScale = scaleX > scaleY ? scaleX : scaleY;

		if (!Number.isFinite(worldScale) || worldScale <= 0) return undefined;

		this.computeViewportBoundsInto(renderer, this.viewportBounds);
		if (!isUsableRect(this.viewportBounds)) return undefined;

		const resolution = Math.min(
			MAX_EFFECTIVE_RESOLUTION,
			normalizeResolution(renderer.resolution * worldScale)
		);

		return Number.isFinite(resolution) && resolution > 0
			? { viewport: this.viewportBounds, resolution }
			: undefined;
	}

	private computeViewportBoundsInto(renderer: Renderer, out: Rectangle) {
		const screen = renderer.screen;
		const point = this.pointScratch;

		this.toLocal({ x: screen.left, y: screen.top }, undefined, point, true);
		let minX = point.x;
		let maxX = point.x;
		let minY = point.y;
		let maxY = point.y;

		this.toLocal({ x: screen.right, y: screen.top }, undefined, point, true);
		if (point.x < minX) minX = point.x;
		else if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		else if (point.y > maxY) maxY = point.y;

		this.toLocal({ x: screen.left, y: screen.bottom }, undefined, point, true);
		if (point.x < minX) minX = point.x;
		else if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		else if (point.y > maxY) maxY = point.y;

		this.toLocal({ x: screen.right, y: screen.bottom }, undefined, point, true);
		if (point.x < minX) minX = point.x;
		else if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		else if (point.y > maxY) maxY = point.y;

		out.set(minX, minY, maxX - minX, maxY - minY);
	}

	private getSceneRoot(): Container | undefined {
		let cur: Container | null = this;
		while (cur.parent) cur = cur.parent;
		return cur;
	}
}

function isUsableRect(rect: Rectangle): boolean {
	return Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
		isUsableDimension(rect.width) && isUsableDimension(rect.height);
}

function isUsableDimension(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= MAX_TARGET_DIMENSION;
}