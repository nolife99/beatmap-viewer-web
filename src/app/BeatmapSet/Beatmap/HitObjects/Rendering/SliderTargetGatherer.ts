import { Container, Rectangle } from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import type { AtlasPackRequest } from './SliderAtlasPacking.ts';
import type { FrameMetrics, PackablePayload, SliderBodyHandle, SliderVisualTarget } from './SliderAtlasTypes.ts';
import { isUsableDimension, isUsableRect, toPhysicalPixels } from './SliderAtlasUtils.ts';

export default class SliderTargetGatherer {
	readonly pendingAllocations: AtlasPackRequest<PackablePayload>[] = [];
	private readonly sliderBounds = new Rectangle();
	private readonly visibleAncestorCache = new Map<Container, boolean>();
	private readonly visibleAncestorStack: Container[] = [];

	collect(handles: SliderBodyHandle[], metrics: FrameMetrics, root: Container): AtlasPackRequest<PackablePayload>[] {
		this.visibleAncestorCache.clear();
		this.visibleAncestorStack.length = this.pendingAllocations.length = 0;

		for (const handle of handles) if (handle.alive) this.gatherHandle(handle, metrics, root);
		return this.pendingAllocations;
	}

	isRenderableToRoot(container: Container, root: Container): boolean {
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
		return !!parent.parent && this.isAncestorRenderableToRoot(parent.parent, root);
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

	private gatherHandle(handle: SliderBodyHandle, metrics: FrameMetrics, root: Container) {
		const body = handle.body;
		const selection = handle.selection;
		const bodyPath = body.visible && body.enabled ? body.path : null;
		const selectionPath = selection.visible && selection.enabled ? selection.path : null;
		const bodyParent = bodyPath && bodyPath.length > 0 && body.sprite.parent;
		const selectionParent = selectionPath && selectionPath.length > 0 && selection.sprite.parent;

		if (bodyParent) {
			const bodyRenderable = this.isSpriteParentRenderable(bodyParent, root);
			if (bodyRenderable) this.gatherTarget(handle, body, bodyPath, metrics);

			if (selectionParent === bodyParent) {
				if (bodyRenderable) this.gatherTarget(handle, selection, selectionPath!, metrics);
				return;
			}
		}

		if (selectionParent && this.isSpriteParentRenderable(selectionParent, root)) {
			this.gatherTarget(handle, selection, selectionPath, metrics);
		}
	}

	private gatherTarget(handle: SliderBodyHandle, target: SliderVisualTarget, path: SliderProgressView, metrics: FrameMetrics) {
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

		this.pendingAllocations.push({
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
}
