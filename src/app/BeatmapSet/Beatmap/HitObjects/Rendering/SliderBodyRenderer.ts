import {
	Application,
	Container,
	Matrix,
	Point,
	Rectangle,
	Sprite,
	Texture,
	UPDATE_PRIORITY
} from 'pixi.js';
import { inject } from '../../../../Context.ts';
import {
	SliderProgressView,
	type SliderProgressSource
} from './CalculateSliderProgress.ts';
import SliderAtlasPage from './SliderAtlasPage.ts';
import type {
	AtlasSlot,
	MutableBounds,
	SliderBounds,
	SliderEntry,
	SliderUniformPatch,
	SliderVisualTarget
} from './SliderAtlasTypes.ts';
import {
	ceilPowerOfTwo,
	cloneBounds,
	DEFAULT_ATLAS_SIZE,
	DEFAULT_BODY_STYLE,
	DEFAULT_GUTTER,
	DEFAULT_SELECTION_STYLE,
	EMPTY_BOUNDS,
	EXTRA_AA_PIXELS,
	intersectBounds,
	normalizeResolution,
	padBounds,
	patchStyle,
	REDUCE_PRECISION,
	REDUCE_PRECISION_SQ,
	segmentCapsuleIntersectsRect,
	toPhysicalPixels
} from './SliderAtlasUtils.ts';

export type BeatmapSliderLayerOptions = {
	app?: Application;
	coordinateSpace?: Container;
	atlasWidth?: number;
	atlasHeight?: number;
	gutter?: number;
	autoFlush?: boolean;
};


type FrameMetrics = {
	viewport: MutableBounds;
	resolution: number;
};

export class BeatmapSliderLayer {
	readonly entries: SliderEntry[] = [];

	private readonly freeIds: number[] = [];
	private readonly pages: SliderAtlasPage[] = [];
	private readonly app: Application;
	private readonly coordinateSpace?: Container;
	private readonly atlasWidth: number;
	private readonly atlasHeight: number;
	private readonly gutter: number;
	private readonly viewportScratch = [new Point(), new Point(), new Point(), new Point()];
	private readonly matrixScratch = new Matrix();
	private readonly viewportBounds: MutableBounds = { x: 0, y: 0, width: 0, height: 0 };
	private readonly retiredTextures: Array<{ texture: Texture; retireFrame: number }> = [];
	private readonly retiredPages: Array<{ page: SliderAtlasPage; retireFrame: number }> = [];

	private currentPageIndex = 0;
	private frameId = 0;
	private destroyed = false;
	private flushing = false;

	private readonly tickerCallback = () => this.flush();

	constructor(options: BeatmapSliderLayerOptions = {}) {
		const app = options.app ?? inject<Application>('ui/app');
		if (!app) throw new Error('BeatmapSliderLayer requires an Application.');

		this.app = app;
		this.coordinateSpace = options.coordinateSpace;
		this.atlasWidth = options.atlasWidth ?? DEFAULT_ATLAS_SIZE;
		this.atlasHeight = options.atlasHeight ?? DEFAULT_ATLAS_SIZE;
		this.gutter = options.gutter ?? DEFAULT_GUTTER;

		if (options.autoFlush) {
			this.app.ticker.add(this.tickerCallback, undefined, UPDATE_PRIORITY.LOW + 1);
		}
	}

	createSlider(maxLocalBounds: SliderBounds): number {
		const id = this.freeIds.pop() ?? this.entries.length;
		const bounds = cloneBounds(maxLocalBounds);

		const entry: SliderEntry = {
			alive: true,
			x: 0,
			y: 0,
			maxLocalBounds: bounds,
			body: this.createVisualTarget(DEFAULT_BODY_STYLE, true, true),
			selection: this.createVisualTarget(DEFAULT_SELECTION_STYLE, false, false)
		};

		entry.body.renderBounds = padBounds(bounds, entry.body.radius + EXTRA_AA_PIXELS);
		entry.selection.renderBounds = padBounds(bounds, entry.selection.radius + EXTRA_AA_PIXELS);

		this.entries[id] = entry;
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
		const entry = this.getEntry(id);
		this.setTargetVisible(entry.body, visible);
	}

	setSelectionVisible(id: number, visible: boolean) {
		const entry = this.getEntry(id);
		this.setTargetVisible(entry.selection, visible);
	}

	setVisible(id: number, visible: boolean) {
		// Compatibility helper only. Rendering no longer depends on a shared entry.visible flag.
		this.setBodyVisible(id, visible);
		this.setSelectionVisible(id, visible);
	}

	setPosition(id: number, x: number, y: number) {
		const entry = this.getEntry(id);
		entry.x = x;
		entry.y = y;
	}

	setFullBounds(id: number, bounds: SliderBounds) {
		const entry = this.getEntry(id);
		entry.maxLocalBounds = cloneBounds(bounds);
		entry.body.renderBounds = padBounds(entry.maxLocalBounds, entry.body.radius + EXTRA_AA_PIXELS);
		entry.selection.renderBounds = padBounds(entry.maxLocalBounds, entry.selection.radius + EXTRA_AA_PIXELS);
	}

	setBodyStyle(id: number, patch: SliderUniformPatch) {
		const entry = this.getEntry(id);
		entry.body.style = patchStyle(entry.body.style, patch);
	}

	setSelectionStyle(id: number, patch: SliderUniformPatch) {
		const entry = this.getEntry(id);
		entry.selection.style = patchStyle(entry.selection.style, patch);
	}

	setBodyGeometrySource(
		id: number,
		path: SliderProgressSource,
		radius: number
	) {
		const entry = this.getEntry(id);
		entry.body.path = path;
		entry.body.enabled = true;

		if (entry.body.radius !== radius) {
			entry.body.radius = radius;
			entry.body.renderBounds = padBounds(entry.maxLocalBounds, radius + EXTRA_AA_PIXELS);
		}
	}

	setSelectionGeometrySource(
		id: number,
		path: SliderProgressSource,
		radius: number
	) {
		const entry = this.getEntry(id);
		entry.selection.path = path;
		entry.selection.enabled = true;

		if (entry.selection.radius !== radius) {
			entry.selection.radius = radius;
			entry.selection.renderBounds = padBounds(entry.maxLocalBounds, radius + EXTRA_AA_PIXELS);
		}
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
			// Staging arrays are only needed through the atlas render. The persistent
			// Pixi/GPU buffers stay alive, while the CPU upload arrays return to the
			// shared power-of-two array pool for other systems to reuse.
			this.releaseStaging();
			this.flushing = false;
		}
	}

	prepareFrame() {
		this.currentPageIndex = 0;

		for (const page of this.pages) page.beginFrame();

		const metrics = this.computeFrameMetrics();
		if (!metrics) {
			this.hideAllSprites();
			return;
		}

		for (const entry of this.entries) {
			if (!entry?.alive) continue;

			this.prepareTarget(entry, entry.body, metrics.viewport, metrics.resolution, false);
			this.prepareTarget(entry, entry.selection, metrics.viewport, metrics.resolution, true);
		}

		for (const page of this.pages) page.upload();
	}

	renderAtlasPages() {
		for (const page of this.pages) page.render(this.app);
	}

	releaseStaging() {
		for (const page of this.pages) page.releaseStaging();
	}

	destroy() {
		this.destroyed = true;
		this.app.ticker.remove(this.tickerCallback);

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

		for (const retired of this.retiredTextures) {
			retired.texture.destroy(false);
		}
		this.retiredTextures.length = 0;

		for (const retired of this.retiredPages) {
			retired.page.destroy();
		}
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
			renderBounds: cloneBounds(EMPTY_BOUNDS),
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

	private prepareTarget(
		entry: SliderEntry,
		target: SliderVisualTarget,
		viewport: MutableBounds,
		resolution: number,
		selection: boolean
	) {
		if (!target.visible || !target.enabled || !target.path || target.path.length <= 0) {
			target.sprite.visible = false;
			return;
		}

		const worldRenderBounds: MutableBounds = {
			x: entry.x + target.renderBounds.x,
			y: entry.y + target.renderBounds.y,
			width: target.renderBounds.width,
			height: target.renderBounds.height
		};

		const clippedWorld = intersectBounds(worldRenderBounds, viewport);
		if (!clippedWorld) {
			target.sprite.visible = false;
			return;
		}

		const renderRect: MutableBounds = {
			x: clippedWorld.x - entry.x,
			y: clippedWorld.y - entry.y,
			width: clippedWorld.width,
			height: clippedWorld.height
		};

		const logicalWidth = Math.max(1e-6, renderRect.width);
		const logicalHeight = Math.max(1e-6, renderRect.height);
		const physicalWidth = toPhysicalPixels(logicalWidth, resolution);
		const physicalHeight = toPhysicalPixels(logicalHeight, resolution);
		const renderScaleX = physicalWidth / logicalWidth;
		const renderScaleY = physicalHeight / logicalHeight;
		const slot = this.allocateSlot(physicalWidth, physicalHeight, renderScaleX, renderScaleY);
		const batch = selection ? slot.page.selectionBatch : slot.page.bodyBatch;

		this.reduceSegmentsIntoBatch(
			target.path,
			batch,
			renderRect,
			slot,
			target.radius,
			target.style
		);

		slot.page.markUsed();
		this.updateSprite(entry, target, slot, renderRect);
	}

	private updateSprite(
		entry: SliderEntry,
		target: SliderVisualTarget,
		slot: AtlasSlot,
		renderRect: MutableBounds
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

		// Pixi sprites derive their local size from the texture's intrinsic frame/orig
		// data. Mutating only texture.frame + UVs is enough when a slot moves, but not
		// when a resize changes the slot dimensions. In that case, recreate the
		// lightweight Texture wrapper so Sprite scale is based on the new frame size.
		if (!target.texture || sourceChanged || frameSizeChanged) {
			if (target.texture) this.retireTexture(target.texture);
			target.texture = new Texture({
				source: slot.page.texture.source,
				frame: target.frame.clone()
			});
			target.sprite.texture = target.texture;
		} else {
			target.texture.frame.copyFrom(target.frame);
			(target.texture as Texture & { updateUvs?: () => void }).updateUvs?.();
		}

		target.sprite.position.set(entry.x + renderRect.x, entry.y + renderRect.y);
		target.sprite.scale.set(
			renderRect.width / slot.width,
			renderRect.height / slot.height
		);
		target.sprite.visible = true;
	}



	private retirePage(page: SliderAtlasPage) {
		// Do not destroy an old atlas page immediately when a resize forces a
		// larger replacement. Active sprite frame textures may still reference the
		// old RenderTexture.source for the current/next render batch. Destroying the
		// page immediately destroys that source and can leave Pixi's GL/WebGPU
		// texture systems trying to read a null sampler/style, e.g. addressModeU.
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
		// Do not destroy a frame Texture in the same flush that replaces it. On WebGPU,
		// Pixi may still have the old texture/style in the current render batch after a
		// resize. Retiring it for a couple of flushes avoids transient null sampler/style
		// reads such as "addressModeU" while still preventing unbounded leaks.
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

	private allocateSlot(
		physicalWidth: number,
		physicalHeight: number,
		renderScaleX: number,
		renderScaleY: number
	): AtlasSlot {
		for (;;) {
			const page = this.getOrCreatePage(
				this.currentPageIndex,
				physicalWidth + this.gutter * 2,
				physicalHeight + this.gutter * 2
			);

			const rect = page.packer.alloc(physicalWidth, physicalHeight);
			if (rect) {
				return {
					page,
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
					scaleX: renderScaleX,
					scaleY: renderScaleY
				};
			}

			this.currentPageIndex++;
		}
	}

	private getOrCreatePage(
		index: number,
		requiredWidth: number,
		requiredHeight: number
	): SliderAtlasPage {
		let page = this.pages[index];
		if (page && page.width >= requiredWidth && page.height >= requiredHeight) return page;

		if (page) this.retirePage(page);

		const width = Math.max(this.atlasWidth, ceilPowerOfTwo(requiredWidth));
		const height = Math.max(this.atlasHeight, ceilPowerOfTwo(requiredHeight));
		page = new SliderAtlasPage(width, height, this.gutter, `slider-atlas-${index}-${width}x${height}`);
		this.pages[index] = page;
		return page;
	}

	private reduceSegmentsIntoBatch(
		path: SliderProgressSource,
		batch: SliderAtlasPage['bodyBatch'],
		renderRect: MutableBounds,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style']
	) {
		if (path instanceof SliderProgressView) {
			this.reduceProgressViewIntoBatch(path, batch, renderRect, slot, radius, style);
			return;
		}

		// Fallback for custom SliderProgressSource implementations. This path should be cold
		// in normal use; SliderProgressView takes the direct-field hot path above.
		this.reduceGenericSourceIntoBatch(path, batch, renderRect, slot, radius, style);
	}

	private reduceProgressViewIntoBatch(
		path: SliderProgressView,
		batch: SliderAtlasPage['bodyBatch'],
		renderRect: MutableBounds,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style']
	) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		const calcPath = path.calcPath;
		const interiorBase = path.interiorBase;
		const interiorLength = path.interiorLength;

		let ax = path.startX;
		let ay = path.startY;

		if (pointsCount === 1) {
			this.pushClippedSegment(batch, ax, ay, ax, ay, renderRect, slot, radius, style);
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

			this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style);

			// This matches the original reducer: after emitting A->B, the next start is
			// the current vertex at index i, not necessarily B after collinear extension.
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

		this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style);
	}

	private reduceGenericSourceIntoBatch(
		path: SliderProgressSource,
		batch: SliderAtlasPage['bodyBatch'],
		renderRect: MutableBounds,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style']
	) {
		const pointsCount = path.length;
		if (pointsCount <= 0) return;

		if (pointsCount === 1) {
			const x = path.getPointX(0);
			const y = path.getPointY(0);
			this.pushClippedSegment(batch, x, y, x, y, renderRect, slot, radius, style);
			return;
		}

		let ax = path.getPointX(0);
		let ay = path.getPointY(0);
		let bx = path.getPointX(1);
		let by = path.getPointY(1);

		for (let i = 1; i < pointsCount - 1; i++) {
			const nx = path.getPointX(i + 1);
			const ny = path.getPointY(i + 1);

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

			this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style);

			ax = path.getPointX(i);
			ay = path.getPointY(i);
			bx = nx;
			by = ny;
		}

		this.pushClippedSegment(batch, ax, ay, bx, by, renderRect, slot, radius, style);
	}

	private pushClippedSegment(
		batch: SliderAtlasPage['bodyBatch'],
		ax: number,
		ay: number,
		bx: number,
		by: number,
		renderRect: MutableBounds,
		slot: AtlasSlot,
		radius: number,
		style: SliderVisualTarget['style']
	) {
		if (!segmentCapsuleIntersectsRect(ax, ay, bx, by, radius, renderRect)) return;

		batch.pushSegment(
			ax,
			ay,
			bx,
			by,
			renderRect.x,
			renderRect.y,
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

		// This layer is flushed before the primary scene render, so cached transforms may
		// still describe the previous frame after resize/layout/camera changes. Force Pixi
		// to walk the transform chain now instead of assuming the first render already did.
		const worldTransform = space.getGlobalTransform(this.matrixScratch, false);

		const scaleX = Math.hypot(worldTransform.a, worldTransform.b);
		const scaleY = Math.hypot(worldTransform.c, worldTransform.d);
		const scale = Math.max(scaleX, scaleY);

		this.computeViewportBoundsInto(space, this.viewportBounds);

		return {
			viewport: this.viewportBounds,
			resolution: normalizeResolution(this.app.renderer.resolution * scale)
		};
	}

	private computeViewportBoundsInto(space: Container, out: MutableBounds): void {
		const screen = this.app.renderer.screen;
		const points = this.viewportScratch;

		space.toLocal({ x: screen.x, y: screen.y }, undefined, points[0], false);
		space.toLocal({ x: screen.x + screen.width, y: screen.y }, undefined, points[1], false);
		space.toLocal({ x: screen.x, y: screen.y + screen.height }, undefined, points[2], false);
		space.toLocal({
			x: screen.x + screen.width,
			y: screen.y + screen.height
		}, undefined, points[3], false);

		const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
		const maxX = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
		const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
		const maxY = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);

		out.x = minX;
		out.y = minY;
		out.width = maxX - minX;
		out.height = maxY - minY;
	}
}

export default class SliderBodyRenderer {
	public readonly body: Sprite;
	public readonly selectionBody: Sprite;

	private readonly layer: BeatmapSliderLayer;
	private readonly id: number;
	private destroyed = false;

	constructor(layer: BeatmapSliderLayer, maxLocalBounds: SliderBounds) {
		this.layer = layer;
		this.id = layer.createSlider(maxLocalBounds);

		const entry = layer.getEntry(this.id);
		this.body = entry.body.sprite;
		this.selectionBody = entry.selection.sprite;
	}

	setPosition(x: number, y: number) {
		if (this.destroyed) return;
		this.layer.setPosition(this.id, x, y);
	}

	setUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.setBodyUniforms(patch);
		if (includeSelection) this.setSelectionUniforms(patch);
	}

	setBodyUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setBodyStyle(this.id, patch);
	}

	setSelectionUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setSelectionStyle(this.id, patch);
	}

	updateMainGeometry(path: SliderProgressSource, radius: number) {
		if (this.destroyed) return;
		this.layer.setBodyGeometrySource(this.id, path, radius);
	}

	updateSelectionGeometry(path: SliderProgressSource, radius: number) {
		if (this.destroyed) return;
		this.layer.setSelectionGeometrySource(this.id, path, radius);
	}

	setBodyVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setBodyVisible(this.id, visible);
	}

	setSelectionVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setSelectionVisible(this.id, visible);
	}

	setVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setVisible(this.id, visible);
	}

	setFullBounds(bounds: SliderBounds) {
		if (this.destroyed) return;
		this.layer.setFullBounds(this.id, bounds);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.layer.deleteSlider(this.id);
	}
}
