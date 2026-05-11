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
import SliderAtlasManager from './SliderAtlasManager.ts';
import SliderSegmentReducer from './SliderSegmentReducer.ts';
import SliderTargetGatherer from './SliderTargetGatherer.ts';
import type {
	AtlasSlot,
	FrameMetrics,
	PackablePayload,
	SliderBodyHandle,
	SliderInstanceStyle,
	SliderUniformPatch,
	SliderVisualTarget
} from './SliderAtlasTypes.ts';
import { packAtlasTargets } from './SliderAtlasPacking.ts';
import {
	DEFAULT_ATLAS_SIZE,
	DEFAULT_BODY_STYLE,
	DEFAULT_GUTTER,
	DEFAULT_SELECTION_STYLE,
	isUsableRect,
	normalizeResolution,
	patchStyle,
	transformD8
} from './SliderAtlasUtils.ts';

export type BeatmapSliderLayerOptions = {
	app?: unknown;
	coordinateSpace?: Container;
	atlasWidth?: number;
	atlasHeight?: number;
	gutter?: number;
	atlasBucketSize?: number;
	minAtlasSize?: number;
	maxResolution?: number;
};

type RetiredTexture = { value: Texture; retireFrame: number };

const TEXTURE_RETIRE_FRAMES = 2;
const DEFAULT_ATLAS_BUCKET_SIZE = 128;
const DEFAULT_MIN_ATLAS_SIZE = 128;
const DEFAULT_MAX_EFFECTIVE_RESOLUTION = 4;

export default class BeatmapSliderLayer extends RenderContainer {
	readonly handles: SliderBodyHandle[] = [];

	private readonly atlasWidth: number;
	private readonly atlasHeight: number;
	private readonly gutter: number;
	private readonly maxResolution: number;
	private readonly atlasManager: SliderAtlasManager;
	private readonly targetGatherer = new SliderTargetGatherer();
	private readonly segmentReducer = new SliderSegmentReducer();
	private readonly matrixScratch = new Matrix();
	private readonly pointScratch = new Point();
	private readonly viewportBounds = new Rectangle();
	private readonly retiredTextures: RetiredTexture[] = [];
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
		this.maxResolution = positiveNumber(options.maxResolution, DEFAULT_MAX_EFFECTIVE_RESOLUTION);
		this.atlasManager = new SliderAtlasManager(
			positiveInt(options.atlasBucketSize, DEFAULT_ATLAS_BUCKET_SIZE),
			positiveInt(options.minAtlasSize, DEFAULT_MIN_ATLAS_SIZE)
		);
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

	setPosition(handle: SliderBodyHandle, x: number, y: number) { handle.x = x; handle.y = y; }
	setBodyVisible(handle: SliderBodyHandle, visible: boolean) { this.setTargetVisible(handle.body, visible); }
	setSelectionVisible(handle: SliderBodyHandle, visible: boolean) { this.setTargetVisible(handle.selection, visible); }
	setBodyStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) { this.setTargetStyle(handle.body, patch); }
	setSelectionStyle(handle: SliderBodyHandle, patch: SliderUniformPatch) { this.setTargetStyle(handle.selection, patch); }
	setBodyGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) { this.setTargetGeometry(handle.body, path, radius); }
	setSelectionGeometrySource(handle: SliderBodyHandle, path: SliderProgressView, radius: number) { this.setTargetGeometry(handle.selection, path, radius); }

	override destroy(options?: DestroyOptions) {
		if (this.disposed) return;
		this.disposed = true;
		this.registeredRenderer?.runners.prerender.remove(this);
		this.registeredRenderer = null;

		for (const handle of this.handles) if (handle.alive) this.releaseHandle(handle);
		for (const retired of this.retiredTextures) retired.value.destroy(false);

		this.atlasManager.destroy();
		this.handles.length = this.retiredTextures.length = 0;
		this.previouslyRenderedTargets.length = this.currentlyRenderedTargets.length = 0;
		super.destroy(options);
	}

	private runPrepare(renderer: Renderer) {
		if (this.disposed || this.preparing || this.lastPreparedFrameId >= this.frameId) return;

		this.preparing = true;
		this.lastPreparedFrameId = this.frameId;

		try {
			this.collectRetiredTextures();
			this.atlasManager.collectRetired(this.frameId);
			this.prepareFrame(renderer);
		} finally {
			this.preparing = false;
		}
	}

	private runAtlasRender(renderer: Renderer) {
		if (this.disposed || this.lastAtlasRenderedFrameId >= this.frameId) return;
		this.lastAtlasRenderedFrameId = this.frameId;

		try {
			this.atlasManager.render(renderer);
		} finally {
			this.atlasManager.releaseStaging();
		}
	}

	private prepareFrame(renderer: Renderer) {
		this.atlasManager.beginFrame();

		const metrics = this.computeFrameMetrics(renderer);
		const root = this.getSceneRoot();

		if (!metrics || !root || !this.targetGatherer.isRenderableToRoot(this, root)) {
			this.hideAllSprites();
			return;
		}

		this.currentlyRenderedTargets.length = 0;
		const pending = this.targetGatherer.collect(this.handles, metrics, root);

		if (pending.length > 0) {
			if (!this.placeTargets(pending)) return;
		} else {
			this.atlasManager.trim(0, this.frameId);
		}

		for (const target of this.previouslyRenderedTargets) {
			if (target.placedFrame !== this.frameId && target.sprite.renderable) target.sprite.renderable = false;
		}

		const old = this.previouslyRenderedTargets;
		this.previouslyRenderedTargets = this.currentlyRenderedTargets;
		this.currentlyRenderedTargets = old;
		this.atlasManager.upload();
	}

	private placeTargets(pendingAllocations: ReturnType<SliderTargetGatherer['collect']>): boolean {
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
			this.atlasManager.trim(0, this.frameId);
			return false;
		}

		if (packed.length === 0) {
			this.hideAllSprites();
			this.atlasManager.trim(0, this.frameId);
			return false;
		}

		this.atlasManager.trim(packed.length, this.frameId);

		for (let binIndex = 0; binIndex < packed.length; binIndex++) {
			const bin = packed[binIndex];
			const page = this.atlasManager.getOrCreate(binIndex, bin.width, bin.height, this.frameId);

			for (const rect of bin.rects) {
				const payload = rect.data as PackablePayload;
				const rotation = rect.rot ? groupD8.MAIN_DIAGONAL : groupD8.E;
				const slot = this.createSlot(page, rect.x, rect.y, rotation, payload);

				this.segmentReducer.reduce(payload.target.path!, page.batch, payload.renderRect, slot, payload.target.radius, rotation);
				page.resolveBatch.pushSlot(slot, payload.target.style, payload.target.radius);
				page.markUsed();
				this.updateSprite(payload.handle, payload.target, slot, payload.renderRect, rotation);
				payload.target.placedFrame = this.frameId;
				this.currentlyRenderedTargets.push(payload.target);
			}
		}

		return true;
	}

	private createSlot(page: AtlasSlot['page'], x: number, y: number, rotation: number, payload: PackablePayload): AtlasSlot {
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

	private updateSprite(handle: SliderBodyHandle, target: SliderVisualTarget, slot: AtlasSlot, renderRect: Rectangle, rotation: number) {
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

	private hideAllSprites() {
		for (const target of this.previouslyRenderedTargets) if (target.sprite.renderable) target.sprite.renderable = false;
		this.previouslyRenderedTargets.length = 0;
	}

	private retireTexture(value: Texture) { this.retiredTextures.push({ value, retireFrame: this.frameId }); }

	private collectRetiredTextures() {
		let write = 0;
		for (let i = 0; i < this.retiredTextures.length; i++) {
			const item = this.retiredTextures[i];
			if (this.frameId - item.retireFrame >= TEXTURE_RETIRE_FRAMES) item.value.destroy(false);
			else this.retiredTextures[write++] = item;
		}
		this.retiredTextures.length = write;
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

		const resolution = Math.min(this.maxResolution, normalizeResolution(renderer.resolution * worldScale));
		return Number.isFinite(resolution) && resolution > 0
			? { viewport, viewportRight: viewport.x + viewport.width, viewportBottom: viewport.y + viewport.height, resolution }
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

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value! > 0 ? Math.ceil(value!) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value! > 0 ? value! : fallback;
}
