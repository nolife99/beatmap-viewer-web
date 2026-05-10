import {
	Container,
	type DestroyOptions,
	groupD8,
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
import SliderCoverageScratch from './SliderCoverageScratch.ts';
import SliderCoverageBatch from './SliderCoverageBatch.ts';
import type {
	AtlasSlot,
	SliderBodyHandle,
	SliderInstanceStyle,
	SliderUniformPatch,
	SliderVisualTarget
} from './SliderAtlasTypes.ts';
import { type AtlasPackRequest, packAtlasTargets } from './SliderAtlasPacking.ts';
import {
	DEFAULT_ATLAS_SIZE,
	DEFAULT_BODY_STYLE,
	DEFAULT_GUTTER,
	DEFAULT_SELECTION_STYLE,
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
	viewportRight: number;
	viewportBottom: number;
	resolution: number;
};

type Retired<T> = { value: T; retireFrame: number };

type PackablePayload = {
	handle: SliderBodyHandle;
	target: SliderVisualTarget;
	renderRect: Rectangle;
	renderScaleX: number;
	renderScaleY: number;
	physicalWidth: number;
	physicalHeight: number;
};

export default class BeatmapSliderLayer extends RenderContainer {
	readonly handles: SliderBodyHandle[] = [];

	private readonly pages: SliderAtlasPage[] = [];
	private readonly coverageScratch = new SliderCoverageScratch();
	private readonly atlasWidth: number;
	private readonly atlasHeight: number;
	private readonly gutter: number;
	private readonly matrixScratch = new Matrix();
	private readonly pointScratch = new Point();
	private readonly viewportBounds = new Rectangle();
	private readonly sliderBounds = new Rectangle();
	private readonly pendingAllocations: AtlasPackRequest<PackablePayload>[] = [];
	private readonly visibleAncestorCache = new Map<Container, boolean>();
	private readonly visibleAncestorStack: Container[] = [];
	private readonly retiredTextures: Retired<Texture>[] = [];
	private readonly retiredPages: Retired<SliderAtlasPage>[] = [];

	private previouslyRenderedTargets: SliderVisualTarget[] = [];
	private currentlyRenderedTargets: SliderVisualTarget[] = [];
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
			this.registeredRenderer?.runners.prerender.remove(this);
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
			body: this.createVisualTarget(bodySprite, DEFAULT_BODY_STYLE),
			selection: this.createVisualTarget(selectionSprite, DEFAULT_SELECTION_STYLE)
		};

		this.handles.push(handle);
		return handle;
	}

	deleteSlider(handle: SliderBodyHandle) {
		if (!handle.alive) return;
		this.releaseHandle(handle);

		const index = this.handles.indexOf(handle);
		if (index >= 0) this.handles.splice(index, 1);
	}

	setPosition(handle: SliderBodyHandle, x: number, y: number) {
		handle.x = x;
		handle.y = y;
	}

	setBodyVisible(handle: SliderBodyHandle, visible: boolean) {
		this.setTargetVisible(handle.body, visible);
	}

	setSelectionVisible(handle: SliderBodyHandle, visible: boolean) {
		this.setTargetVisible(handle.selection, visible);
	}

	setBodyStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) {
		this.setTargetStyle(handle.body, patch);
	}

	setSelectionStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) {
		this.setTargetStyle(handle.selection, patch);
	}

	setBodyGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) {
		this.setTargetGeometry(handle.body, path, radius);
	}

	setSelectionGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) {
		this.setTargetGeometry(handle.selection, path, radius);
	}

	override destroy(options?: DestroyOptions) {
		if (this.disposed) return;
		this.disposed = true;
		this.registeredRenderer?.runners.prerender.remove(this);
		this.registeredRenderer = null;

		for (const handle of this.handles) if (handle.alive) this.releaseHandle(handle);
		for (const page of this.pages) page.destroy();
		for (const retired of this.retiredTextures) retired.value.destroy(false);
		for (const retired of this.retiredPages) retired.value.destroy();

		this.pages.length = this.handles.length = this.pendingAllocations.length = 0;
		this.retiredTextures.length = this.retiredPages.length = 0;
		this.previouslyRenderedTargets.length = this.currentlyRenderedTargets.length = 0;
		this.visibleAncestorCache.clear();
		this.coverageScratch.destroy();
		super.destroy(options);
	}

	private runPrepare(renderer: Renderer) {
		if (this.disposed || this.preparing || this.lastPreparedFrameId >= this.frameId) return;

		this.preparing = true;
		this.lastPreparedFrameId = this.frameId;

		try {
			this.collectRetired(this.retiredTextures, 2, (texture) => texture.destroy(false));
			this.collectRetired(this.retiredPages, 4, (page) => page.destroy());
			this.prepareFrame(renderer);
		} finally {
			this.preparing = false;
		}
	}

	private runAtlasRender(renderer: Renderer) {
		if (this.disposed || this.lastAtlasRenderedFrameId >= this.frameId) return;
		this.lastAtlasRenderedFrameId = this.frameId;

		try {
			for (const page of this.pages) page.render(renderer, this.coverageScratch);
		} finally {
			for (const page of this.pages) page.releaseStaging();
		}
	}

	private prepareFrame(renderer: Renderer) {
		this.visibleAncestorCache.clear();
		this.visibleAncestorStack.length = 0;
		this.pendingAllocations.length = 0;
		for (const page of this.pages) page.beginFrame();

		const metrics = this.computeFrameMetrics(renderer);
		const root = this.getSceneRoot();

		if (!metrics || !root || !this.isRenderableToRoot(this, root)) {
			this.hideAllSprites();
			return;
		}

		this.currentlyRenderedTargets.length = 0;

		for (const handle of this.handles) {
			if (handle.alive) this.gatherHandle(handle, metrics, root, this.pendingAllocations);
		}

		if (this.pendingAllocations.length > 0 && !this.placeTargets(this.pendingAllocations)) return;

		for (const target of this.previouslyRenderedTargets) {
			if (target.placedFrame !== this.frameId && target.sprite.renderable) target.sprite.renderable = false;
		}

		const old = this.previouslyRenderedTargets;
		this.previouslyRenderedTargets = this.currentlyRenderedTargets;
		this.currentlyRenderedTargets = old;

		for (const page of this.pages) page.upload();
	}

	private placeTargets(pendingAllocations: AtlasPackRequest<PackablePayload>[]): boolean {
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
			return false;
		}

		if (packed.length === 0) {
			this.hideAllSprites();
			return false;
		}

		for (let binIndex = 0; binIndex < packed.length; binIndex++) {
			const bin = packed[binIndex];
			const page = this.getOrCreatePage(binIndex, bin.width, bin.height);

			for (const rect of bin.rects) {
				const payload = rect.data as PackablePayload;
				const rotation = rect.rot ? groupD8.MAIN_DIAGONAL : groupD8.E;
				const slot = this.createSlot(page, rect.x, rect.y, rotation, payload);

				this.reduceProgressViewIntoBatch(
					payload.target.path!, page.batch, payload.renderRect,
					slot, payload.target.radius, rotation
				);
				page.resolveBatch.pushSlot(slot, payload.target.style, payload.target.radius);

				page.markUsed();
				this.updateSprite(payload.handle, payload.target, slot, payload.renderRect, rotation);
				payload.target.placedFrame = this.frameId;
				this.currentlyRenderedTargets.push(payload.target);
			}
		}

		return true;
	}

	private createSlot(page: SliderAtlasPage, x: number, y: number, rotation: number, payload: PackablePayload): AtlasSlot {
		const scratch = this.pointScratch;
		transformD8(rotation, payload.physicalWidth, payload.physicalHeight, scratch, true);
		const width = scratch.x;
		const height = scratch.y;

		transformD8(rotation, payload.renderScaleX, payload.renderScaleY, scratch, true);
		return { page, x, y, width, height, scaleX: scratch.x, scaleY: scratch.y };
	}

	private createVisualTarget(sprite: Sprite, style: SliderInstanceStyle): SliderVisualTarget {
		if (sprite.anchor.x !== 0 || sprite.anchor.y !== 0) sprite.anchor.set(0, 0);
		if (!sprite.visible) sprite.visible = true;
		if (sprite.renderable) sprite.renderable = false;

		return {
			sprite,
			texture: undefined,
			path: undefined,
			frame: new Rectangle(),
			renderRect: new Rectangle(),
			radius: 1,
			style,
			enabled: false,
			visible: false,
			placedFrame: -1
		};
	}

	private releaseHandle(handle: SliderBodyHandle) {
		handle.alive = false;
		this.releaseVisualTarget(handle.body);
		this.releaseVisualTarget(handle.selection);
	}

	private setTargetVisible(target: SliderVisualTarget, visible: boolean) {
		target.visible = visible;
		if (!visible && target.sprite.renderable) target.sprite.renderable = false;
	}

	private setTargetStyle(target: SliderVisualTarget, patch: SliderUniformPatch) {
		target.style = patchStyle(target.style, patch);
	}

	private setTargetGeometry(target: SliderVisualTarget, path: SliderProgressView, radius: number) {
		target.path = path;
		target.radius = radius;
		target.enabled = true;
	}

	private releaseVisualTarget(target: SliderVisualTarget) {
		if (target.sprite.texture !== Texture.EMPTY) target.sprite.texture = Texture.EMPTY;
		if (target.sprite.renderable) target.sprite.renderable = false;
		if (target.texture) this.retireTexture(target.texture);

		target.texture = undefined;
		target.path = undefined;
		target.enabled = false;
	}

	private updateSprite(
		handle: SliderBodyHandle,
		target: SliderVisualTarget,
		slot: AtlasSlot,
		renderRect: Rectangle,
		rotation: number
	) {
		target.frame.set(slot.x, slot.y, slot.width, slot.height);

		const existing = target.texture;
		const textureChanged = !existing ||
			existing.source !== slot.page.texture.source ||
			existing.frame.width !== slot.width ||
			existing.frame.height !== slot.height ||
			existing.rotate !== rotation;

		if (textureChanged) {
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
		const x = handle.x + renderRect.x;
		const y = handle.y + renderRect.y;
		const scaleX = renderRect.width / slot.width;
		const scaleY = renderRect.height / slot.height;

		if (sprite.position.x !== x || sprite.position.y !== y) sprite.position.set(x, y);
		if (sprite.rotation !== 0) sprite.rotation = 0;
		if (sprite.scale.x !== scaleX || sprite.scale.y !== scaleY) sprite.scale.set(scaleX, scaleY);
		if (!sprite.renderable) sprite.renderable = true;
	}

	private isRenderableToRoot(container: Container, root: Container): boolean {
		let cur: Container | null = container;

		while (cur) {
			if (!cur.visible || !cur.renderable) return false;
			if (cur === root) return true;
			cur = cur.parent;
		}

		return false;
	}

	private isSpriteParentRenderable(parent: Container, root: Container): boolean {
		if (!parent.visible || !parent.renderable) return false;
		if (parent === root) return true;

		const ancestor = parent.parent;
		return !!ancestor && this.isAncestorRenderableToRoot(ancestor, root);
	}

	private isAncestorRenderableToRoot(container: Container, root: Container): boolean {
		const cached = this.visibleAncestorCache.get(container);
		if (cached !== undefined) return cached;

		const stack = this.visibleAncestorStack;
		stack.length = 0;

		let cur: Container | null = container;
		let visible = false;

		while (cur) {
			const cached = this.visibleAncestorCache.get(cur);

			if (cached !== undefined) {
				visible = cached;
				break;
			}

			stack.push(cur);

			if (!cur.visible || !cur.renderable) break;
			if (cur === root) {
				visible = true;
				break;
			}

			cur = cur.parent;
		}

		for (let i = 0; i < stack.length; i++) this.visibleAncestorCache.set(stack[i], visible);
		return visible;
	}

	private gatherHandle(
		handle: SliderBodyHandle,
		metrics: FrameMetrics,
		root: Container,
		pendingAllocations: AtlasPackRequest<PackablePayload>[]
	) {
		const body = handle.body;
		const selection = handle.selection;
		const bodyPath = body.visible && body.enabled ? body.path : null;
		const selectionPath = selection.visible && selection.enabled ? selection.path : null;
		const bodyParent = bodyPath && bodyPath.length > 0 && body.sprite.parent;
		const selectionParent = selectionPath && selectionPath.length > 0 && selection.sprite.parent;

		if (bodyParent) {
			const bodyRenderable = this.isSpriteParentRenderable(bodyParent, root);
			if (bodyRenderable) this.gatherTarget(handle, body, bodyPath, metrics, pendingAllocations);

			if (selectionParent === bodyParent) {
				if (bodyRenderable) this.gatherTarget(handle, selection, selectionPath!, metrics, pendingAllocations);
				return;
			}
		}

		if (selectionParent && this.isSpriteParentRenderable(selectionParent, root)) {
			this.gatherTarget(handle, selection, selectionPath, metrics, pendingAllocations);
		}
	}

	private gatherTarget(
		handle: SliderBodyHandle,
		target: SliderVisualTarget,
		path: SliderProgressView,
		metrics: FrameMetrics,
		pendingAllocations: AtlasPackRequest<PackablePayload>[]
	) {
		const localBounds = this.sliderBounds;
		path.computeRenderBoundsInto(target.radius, localBounds);
		if (!isUsableRect(localBounds)) return;

		const x = handle.x + localBounds.x;
		const y = handle.y + localBounds.y;
		const right = x + localBounds.width;
		const bottom = y + localBounds.height;
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(right) || !Number.isFinite(bottom)) return;

		const viewport = metrics.viewport;
		const clippedX = x > viewport.x ? x : viewport.x;
		const clippedY = y > viewport.y ? y : viewport.y;
		const clippedRight = right < metrics.viewportRight ? right : metrics.viewportRight;
		const clippedBottom = bottom < metrics.viewportBottom ? bottom : metrics.viewportBottom;
		const clippedWidth = clippedRight - clippedX;
		const clippedHeight = clippedBottom - clippedY;
		if (!isUsableDimension(clippedWidth) || !isUsableDimension(clippedHeight)) return;

		const physicalWidth = toPhysicalPixels(clippedWidth, metrics.resolution);
		const physicalHeight = toPhysicalPixels(clippedHeight, metrics.resolution);
		if (!isUsableDimension(physicalWidth) || !isUsableDimension(physicalHeight)) return;

		const renderRect = target.renderRect;
		renderRect.set(clippedX - handle.x, clippedY - handle.y, clippedWidth, clippedHeight);

		pendingAllocations.push({
			width: physicalWidth,
			height: physicalHeight,
			data: {
				handle,
				target,
				renderRect,
				renderScaleX: physicalWidth / clippedWidth,
				renderScaleY: physicalHeight / clippedHeight,
				physicalWidth,
				physicalHeight
			}
		});
	}

	private hideAllSprites() {
		for (const target of this.previouslyRenderedTargets) if (target.sprite.renderable) target.sprite.renderable = false;
		this.previouslyRenderedTargets.length = 0;
	}

	private reduceProgressViewIntoBatch(
		path: SliderProgressView,
		batch: SliderCoverageBatch,
		renderRect: Rectangle,
		slot: AtlasSlot,
		radius: number,
		rotation: number
	) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		const scratch = this.pointScratch;
		transformD8(rotation, renderRect.x, renderRect.y, scratch);
		const originX = scratch.x;
		const originY = scratch.y;
		let ax = path.startX;
		let ay = path.startY;

		if (pointsCount === 1) {
			this.pushVisibleSegment(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, ax, ay);
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

			this.pushVisibleSegment(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, bx, by);
			ax = pathPointX(path, i);
			ay = pathPointY(path, i);
			bx = nx;
			by = ny;
		}

		this.pushVisibleSegment(batch, renderRect, slot, radius, rotation, originX, originY, ax, ay, bx, by);
	}

	private pushVisibleSegment(
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

		const scratch = this.pointScratch;
		transformD8(rotation, ax, ay, scratch);
		const rAx = scratch.x;
		const rAy = scratch.y;
		transformD8(rotation, bx, by, scratch);
		batch.pushSegment(
			rAx, rAy, scratch.x, scratch.y, originX, originY,
			slot.scaleX, slot.scaleY, slot.x, slot.y, slot.width, slot.height, radius
		);
	}

	private getOrCreatePage(index: number, width: number, height: number): SliderAtlasPage {
		let page = this.pages[index];
		if (page && page.width >= width && page.height >= height) return page;

		if (page) this.retirePage(page);
		page = new SliderAtlasPage(width, height, `slider-atlas-${index}-${width}x${height}`);
		this.pages[index] = page;
		return page;
	}

	private retirePage(value: SliderAtlasPage) {
		this.retiredPages.push({ value, retireFrame: this.frameId });
	}

	private retireTexture(value: Texture) {
		this.retiredTextures.push({ value, retireFrame: this.frameId });
	}

	private collectRetired<T>(items: Retired<T>[], frames: number, destroy: (value: T) => void) {
		let write = 0;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (this.frameId - item.retireFrame >= frames) destroy(item.value);
			else items[write++] = item;
		}

		items.length = write;
	}

	private computeFrameMetrics(renderer: Renderer): FrameMetrics | undefined {
		const screen = renderer.screen;
		if (!Number.isFinite(screen.width) || !Number.isFinite(screen.height) || screen.width <= 0 || screen.height <= 0) {
			return undefined;
		}

		const worldTransform = this.getGlobalTransform(this.matrixScratch, false);
		const scaleX = Math.sqrt(worldTransform.a * worldTransform.a + worldTransform.b * worldTransform.b);
		const scaleY = Math.sqrt(worldTransform.c * worldTransform.c + worldTransform.d * worldTransform.d);
		const worldScale = scaleX > scaleY ? scaleX : scaleY;
		if (!Number.isFinite(worldScale) || worldScale <= 0) return undefined;

		const viewport = this.viewportBounds;
		this.computeViewportBoundsInto(renderer, viewport);
		if (!isUsableRect(viewport)) return undefined;

		const resolution = Math.min(4, normalizeResolution(renderer.resolution * worldScale));
		return Number.isFinite(resolution) && resolution > 0
			? {
				viewport,
				viewportRight: viewport.x + viewport.width,
				viewportBottom: viewport.y + viewport.height,
				resolution
			}
			: undefined;
	}

	private computeViewportBoundsInto(renderer: Renderer, out: Rectangle) {
		const screen = renderer.screen;
		const point = this.pointScratch;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		for (let i = 0; i < 4; i++) {
			this.toLocal({
				x: i & 1 ? screen.right : screen.left,
				y: i & 2 ? screen.bottom : screen.top
			}, undefined, point, true);

			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}

		out.set(minX, minY, maxX - minX, maxY - minY);
	}

	private getSceneRoot(): Container | undefined {
		let cur: Container | null = this;
		while (cur.parent) cur = cur.parent;
		return cur;
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

function isUsableRect(rect: Rectangle): boolean {
	return Number.isFinite(rect.x) && Number.isFinite(rect.y) && isUsableDimension(rect.width) && isUsableDimension(rect.height);
}

function isUsableDimension(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= 32768;
}
