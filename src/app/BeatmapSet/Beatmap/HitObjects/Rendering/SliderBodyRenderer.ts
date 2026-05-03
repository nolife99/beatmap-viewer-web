import pool from '@stdlib/array-pool';
import {
	Application,
	Buffer,
	BufferUsage,
	type ColorSource,
	Container,
	Geometry,
	GlProgram,
	GpuProgram,
	Matrix,
	Mesh,
	Point,
	Rectangle,
	RenderTexture,
	Shader,
	Sprite,
	Texture,
	UniformGroup, UPDATE_PRIORITY
} from 'pixi.js';
import RendererConfig from '../../../../Config/RendererConfig.ts';
import { inject } from '../../../../Context.ts';
import { darken, lighten } from '../../../../utils.ts';
import {
	type SliderProgressResult,
	type SliderProgressSource
} from './CalculateSliderProgress.ts';
import fragment from './Shaders/sliderShader.frag?raw';
import vertex from './Shaders/sliderShader.vert?raw';
import gpuSrc from './Shaders/sliderShader.wgsl?raw';

const GL = new GlProgram({ vertex, fragment });

const GPU = GpuProgram.from({
	vertex: { source: gpuSrc, entryPoint: 'vsMain' },
	fragment: { source: gpuSrc, entryPoint: 'fsMain' }
});

const COLOR: ColorSource = [69 / 255, 71 / 255, 90 / 255, 0];

export type SliderUniformPatch = Partial<{
	borderColor: ColorSource;
	innerColor: ColorSource;
	outerColor: ColorSource;
	borderWidth: number;
	bodyAlpha: number;
	scale: number;
	uRadius: number;
}>;

const quadPositions = new Buffer({
	data: [
		0, 1,
		0, -1,
		1, -1,

		0, 1,
		1, -1,
		1, 1
	],
	usage: BufferUsage.VERTEX
});

const REDUCE_PRECISION = 0.01;
const REDUCE_PRECISION_SQ = REDUCE_PRECISION * REDUCE_PRECISION;

const EMPTY_TEXTURE = Texture.EMPTY;
const PHYSICAL_PIXEL_EPSILON = 1e-6;
const RECT_EPSILON = 0.001;
const SCALE_EPSILON = 0.000001;

function createBodyGeometry() {
	return new Geometry({
		attributes: {
			aQuad: {
				buffer: quadPositions,
				format: 'float32x2'
			},
			aSegment: {
				buffer: new Buffer({
					data: new Float32Array([]),
					usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
					shrinkToFit: false
				}),
				format: 'float32x4',
				instance: true
			}
		}
	});
}

function createUniformGroup(bodyAlpha: number) {
	return new UniformGroup({
		borderColor: { value: [205 / 255, 214 / 255, 244 / 255], type: 'vec4<f32>' },
		innerColor: { value: lighten(COLOR, 0.5), type: 'vec4<f32>' },
		outerColor: { value: darken(COLOR, 0.1), type: 'vec4<f32>' },
		borderWidth: { value: 0.128, type: 'f32' },
		bodyAlpha: { value: bodyAlpha, type: 'f32' },
		scale: { value: 1, type: 'f32' },
		uRadius: { value: 1, type: 'f32' }
	});
}

function createShader(uniforms: UniformGroup) {
	return new Shader({
		glProgram: GL,
		gpuProgram: GPU,
		resources: {
			customUniforms: uniforms
		}
	});
}

function normalizeResolution(value: number): number {
	return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function toPhysicalPixels(logicalPixels: number, resolution: number): number {
	return Math.max(
		1,
		Math.ceil(logicalPixels * resolution - PHYSICAL_PIXEL_EPSILON)
	);
}

function sameNumber(a: number, b: number, epsilon: number): boolean {
	return Math.abs(a - b) <= epsilon;
}

function sameRect(a: Rectangle | undefined, b: Rectangle): boolean {
	return !!a &&
		sameNumber(a.x, b.x, RECT_EPSILON) &&
		sameNumber(a.y, b.y, RECT_EPSILON) &&
		sameNumber(a.width, b.width, RECT_EPSILON) &&
		sameNumber(a.height, b.height, RECT_EPSILON);
}

type CachedTarget = {
	sprite: Sprite;
	mesh: Mesh<Geometry, Shader>;

	texture?: RenderTexture;
	viewTexture?: Texture;

	localBounds?: Rectangle;
	renderRect?: Rectangle;

	capacityWidth: number;
	capacityHeight: number;

	viewWidth: number;
	viewHeight: number;

	renderScaleX: number;
	renderScaleY: number;

	attachTarget?: Container;
	attachCallback?: () => void;

	dirty: boolean;
};

export default class SliderBodyRenderer {
	public readonly uniforms = createUniformGroup(0.7);
	public readonly selectionUniforms = createUniformGroup(0.0);

	public readonly body = new Sprite(EMPTY_TEXTURE);
	public readonly selectionBody = new Sprite(EMPTY_TEXTURE);

	private readonly bodyMesh: Mesh<Geometry, Shader>;
	private readonly selectionMesh: Mesh<Geometry, Shader>;

	private readonly renderRoot = new Container();

	private readonly mainTarget: CachedTarget;
	private readonly selectionTarget: CachedTarget;

	private readonly matrixScratch = new Matrix();
	private readonly viewportScratch = [
		new Point(),
		new Point(),
		new Point(),
		new Point()
	];

	private stagingBuffer?: Float32Array;

	private tickerRefreshQueued = false;

	private readonly tickerRefreshCallback = () => {
		if (!this.tickerRefreshQueued || this.destroyed) return;

		this.tickerRefreshQueued = false;

		const app = inject<Application>('ui/app');
		app?.ticker?.remove(this.tickerRefreshCallback);

		this.refreshCachedTextures();
	};
	private destroyed = false;

	private x = 0;
	private y = 0;

	constructor() {
		const blendMode =
			inject<RendererConfig>('config/renderer')?.renderer === 'webgl'
				? 'none'
				: 'max';

		this.bodyMesh = new Mesh({
			geometry: createBodyGeometry(),
			shader: createShader(this.uniforms),
			blendMode
		});

		this.selectionMesh = new Mesh({
			geometry: createBodyGeometry(),
			shader: createShader(this.selectionUniforms),
			blendMode
		});

		this.bodyMesh.state.depthTest = true;
		this.selectionMesh.state.depthTest = true;

		this.body.blendMode = 'normal';
		this.selectionBody.blendMode = 'normal';

		this.body.anchor.set(0, 0);
		this.selectionBody.anchor.set(0, 0);

		this.mainTarget = this.createTarget(this.body, this.bodyMesh);
		this.selectionTarget = this.createTarget(this.selectionBody, this.selectionMesh);
	}

	private createTarget(
		sprite: Sprite,
		mesh: Mesh<Geometry, Shader>
	): CachedTarget {
		return {
			sprite,
			mesh,

			capacityWidth: 0,
			capacityHeight: 0,

			viewWidth: 0,
			viewHeight: 0,

			renderScaleX: 1,
			renderScaleY: 1,

			dirty: true
		};
	}

	private static getApp(reason?: string) {
		const app = inject<Application>('ui/app');

		if (!app?.stage) {
			throw new Error(
				`Can't update slider body render texture because Application.stage is unavailable. ${
					reason ?? ''
				}`
			);
		}

		return app;
	}

	setPosition(x: number, y: number) {
		this.x = x;
		this.y = y;

		this.mainTarget.dirty = true;
		this.selectionTarget.dirty = true;

		this.refreshCachedTextures();
	}

	setUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.applyUniformPatch(this.uniforms, patch);
		this.mainTarget.dirty = true;

		if (includeSelection) {
			this.applyUniformPatch(this.selectionUniforms, patch);
			this.selectionTarget.dirty = true;
		}

		this.refreshCachedTextures();
	}

	setBodyUniforms(patch: SliderUniformPatch) {
		this.applyUniformPatch(this.uniforms, patch);
		this.mainTarget.dirty = true;
		this.refreshMainTexture();
	}

	setSelectionUniforms(patch: SliderUniformPatch) {
		this.applyUniformPatch(this.selectionUniforms, patch);
		this.selectionTarget.dirty = true;
		this.refreshSelectionTexture();
	}

	updateMainGeometry(path: SliderProgressSource, radius: number) {
		const bounds = this.populateInstanceBuffer(
			path,
			this.bodyMesh.geometry
		);

		this.uniforms.uniforms.uRadius = radius;

		this.mainTarget.localBounds = this.computePaddedBounds(bounds, radius);
		this.mainTarget.dirty = true;

		this.refreshMainTexture();
	}

	updateSelectionGeometry(
		path: SliderProgressSource | SliderProgressResult,
		radius: number
	) {
		const bounds = this.populateInstanceBuffer(
			path,
			this.selectionMesh.geometry
		);

		this.selectionUniforms.uniforms.uRadius = radius;

		this.selectionTarget.localBounds = this.computePaddedBounds(bounds, radius);
		this.selectionTarget.dirty = true;

		this.refreshSelectionTexture();
	}

	refreshCachedTextures() {
		this.refreshMainTexture();
		this.refreshSelectionTexture();
	}

	refreshMainTexture() {
		this.refreshTarget(this.mainTarget, 'main');
	}

	refreshSelectionTexture() {
		this.refreshTarget(this.selectionTarget, 'selection');
	}

	destroy() {
		this.destroyed = true;

		const app = inject<Application>('ui/app');
		if (this.tickerRefreshQueued) {
			this.tickerRefreshQueued = false;
			app?.ticker?.remove(this.tickerRefreshCallback);
		}

		this.clearAttachWait(this.mainTarget);
		this.clearAttachWait(this.selectionTarget);

		this.destroyTarget(this.mainTarget);
		this.destroyTarget(this.selectionTarget);

		this.releaseStagingBuffer();

		this.bodyMesh.geometry.attributes.aSegment.buffer.destroy();
		this.selectionMesh.geometry.attributes.aSegment.buffer.destroy();

		this.bodyMesh.geometry.destroy();
		this.selectionMesh.geometry.destroy();

		this.bodyMesh.shader?.destroy();
		this.selectionMesh.shader?.destroy();

		this.bodyMesh.destroy(true);
		this.selectionMesh.destroy(true);

		this.body.destroy(true);
		this.selectionBody.destroy(true);

		this.renderRoot.destroy({ children: false });
	}

	private refreshTarget(target: CachedTarget, label: string) {
		if (!target.localBounds || this.destroyed) return;

		const app = SliderBodyRenderer.getApp(`refreshTarget:${label}`);

		if (!this.isAttachedToStage(target.sprite, app)) {
			this.deferUntilAttached(target, app);

			target.dirty = true;

			if (!target.texture) {
				target.sprite.visible = false;
			}

			return;
		}

		this.clearAttachWait(target);

		const renderRect = this.computeVisibleRenderRect(
			target.sprite,
			target.localBounds,
			app
		);

		if (renderRect.width <= 0 || renderRect.height <= 0) {
			target.sprite.visible = false;
			target.dirty = false;
			target.renderRect = undefined;
			return;
		}

		target.sprite.visible = true;

		const logicalWidth = Math.max(1, Math.ceil(renderRect.width));
		const logicalHeight = Math.max(1, Math.ceil(renderRect.height));

		const resolution = this.getRenderResolution(target.sprite, app);

		const physicalWidth = toPhysicalPixels(logicalWidth, resolution);
		const physicalHeight = toPhysicalPixels(logicalHeight, resolution);

		const renderScaleX = physicalWidth / logicalWidth;
		const renderScaleY = physicalHeight / logicalHeight;

		const allocated = this.ensureTextureCapacity(
			target,
			physicalWidth,
			physicalHeight,
			label
		);

		const viewChanged = this.ensureViewTexture(
			target,
			physicalWidth,
			physicalHeight
		);

		const rectChanged = !sameRect(target.renderRect, renderRect);
		const scaleChanged =
			!sameNumber(target.renderScaleX, renderScaleX, SCALE_EPSILON) ||
			!sameNumber(target.renderScaleY, renderScaleY, SCALE_EPSILON);

		target.sprite.position.set(
			this.x + renderRect.x,
			this.y + renderRect.y
		);

		target.sprite.scale.set(
			logicalWidth / physicalWidth,
			logicalHeight / physicalHeight
		);

		if (
			!target.dirty &&
			!allocated &&
			!viewChanged &&
			!rectChanged &&
			!scaleChanged
		) {
			return;
		}

		target.renderRect ??= new Rectangle();
		target.renderRect.copyFrom(renderRect);

		target.renderScaleX = renderScaleX;
		target.renderScaleY = renderScaleY;

		this.renderCache(target, renderRect, renderScaleX, renderScaleY);

		this.releaseStagingBuffer();

		target.dirty = false;
	}

	private renderCache(
		target: CachedTarget,
		renderRect: Rectangle,
		renderScaleX: number,
		renderScaleY: number
	) {
		if (!target.texture) return;

		target.mesh.position.set(-renderRect.x, -renderRect.y);

		this.renderRoot.scale.set(renderScaleX, renderScaleY);

		if (target.mesh.parent !== this.renderRoot) {
			this.renderRoot.removeChildren();
			this.renderRoot.addChild(target.mesh);
		}

		SliderBodyRenderer.getApp('renderCache').renderer.render({
			container: this.renderRoot,
			target: target.texture,
			clear: true
		});
	}

	private ensureTextureCapacity(
		target: CachedTarget,
		physicalWidth: number,
		physicalHeight: number,
		label: string
	): boolean {
		if (
			target.texture &&
			target.capacityWidth >= physicalWidth &&
			target.capacityHeight >= physicalHeight
		) {
			return false;
		}

		target.viewTexture?.destroy(false);
		target.texture?.destroy(true);

		target.capacityWidth = physicalWidth;
		target.capacityHeight = physicalHeight;

		target.viewWidth = 0;
		target.viewHeight = 0;

		target.texture = RenderTexture.create({
			width: physicalWidth,
			height: physicalHeight,
			resolution: 1
		});

		target.texture.label =
			`slider-body-${label}-${physicalWidth}x${physicalHeight}px`;

		target.viewTexture = undefined;
		target.sprite.texture = target.texture;

		return true;
	}

	private ensureViewTexture(
		target: CachedTarget,
		physicalWidth: number,
		physicalHeight: number
	): boolean {
		const texture = target.texture;
		if (!texture) return false;

		if (
			target.viewTexture &&
			target.viewWidth === physicalWidth &&
			target.viewHeight === physicalHeight
		) {
			return false;
		}

		target.viewTexture?.destroy(false);

		target.viewWidth = physicalWidth;
		target.viewHeight = physicalHeight;

		target.viewTexture = new Texture({
			source: texture.source,
			frame: new Rectangle(0, 0, physicalWidth, physicalHeight)
		});

		target.viewTexture.label = `${texture.label}-view`;
		target.sprite.texture = target.viewTexture;

		return true;
	}

	private getRenderResolution(sprite: Sprite, app: Application): number {
		const parent = sprite.parent;

		if (!parent || !this.isAttachedToStage(sprite, app)) {
			return normalizeResolution(app.renderer.resolution);
		}

		const wt = parent.getGlobalTransform(this.matrixScratch);

		const scaleX = Math.hypot(wt.a, wt.b);
		const scaleY = Math.hypot(wt.c, wt.d);
		const scale = Math.max(scaleX, scaleY);

		return normalizeResolution(app.renderer.resolution * scale);
	}

	private computeVisibleRenderRect(
		sprite: Sprite,
		localBounds: Rectangle,
		app: Application
	): Rectangle {
		const parent = sprite.parent;

		if (!parent) {
			return localBounds.clone();
		}

		const screen = app.renderer.screen;
		const points = this.viewportScratch;

		parent.toLocal({ x: screen.x, y: screen.y }, undefined, points[0]);
		parent.toLocal({ x: screen.x + screen.width, y: screen.y }, undefined, points[1]);
		parent.toLocal({ x: screen.x, y: screen.y + screen.height }, undefined, points[2]);
		parent.toLocal({
			x: screen.x + screen.width,
			y: screen.y + screen.height
		}, undefined, points[3]);

		const viewMinX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
		const viewMaxX = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
		const viewMinY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
		const viewMaxY = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);

		const sliderMinX = this.x + localBounds.x;
		const sliderMinY = this.y + localBounds.y;
		const sliderMaxX = sliderMinX + localBounds.width;
		const sliderMaxY = sliderMinY + localBounds.height;

		const clippedMinX = Math.max(sliderMinX, viewMinX);
		const clippedMinY = Math.max(sliderMinY, viewMinY);
		const clippedMaxX = Math.min(sliderMaxX, viewMaxX);
		const clippedMaxY = Math.min(sliderMaxY, viewMaxY);

		if (clippedMaxX <= clippedMinX || clippedMaxY <= clippedMinY) {
			return new Rectangle(0, 0, 0, 0);
		}

		return new Rectangle(
			clippedMinX - this.x,
			clippedMinY - this.y,
			clippedMaxX - clippedMinX,
			clippedMaxY - clippedMinY
		);
	}

	private isAttachedToStage(sprite: Sprite, app: Application): boolean {
		let node: Container | null = sprite;

		while (node) {
			if (node === app.stage) return true;
			node = node.parent;
		}

		return false;
	}

	private deferUntilAttached(target: CachedTarget, app: Application) {
		if (target.attachCallback) return;

		const attachTarget = this.findDetachedRoot(target.sprite, app);

		const callback = () => {
			target.attachTarget = undefined;
			target.attachCallback = undefined;
			target.dirty = true;

			this.queueTickerRefresh();
		};

		target.attachTarget = attachTarget;
		target.attachCallback = callback;

		attachTarget.once('added', callback);
	}

	private findDetachedRoot(sprite: Sprite, app: Application): Container {
		let node: Container = sprite;

		while (node.parent && node.parent !== app.stage) {
			node = node.parent;
		}

		return node;
	}

	private clearAttachWait(target: CachedTarget) {
		if (!target.attachTarget || !target.attachCallback) return;

		target.attachTarget.off('added', target.attachCallback);
		target.attachTarget = undefined;
		target.attachCallback = undefined;
	}

	private queueTickerRefresh() {
		if (this.tickerRefreshQueued || this.destroyed) return;

		const app = inject<Application>('ui/app');
		if (!app?.ticker) return;

		this.tickerRefreshQueued = true;
		app.ticker.add(
			this.tickerRefreshCallback,
			undefined,
			UPDATE_PRIORITY.HIGH
		);
	}

	private destroyTarget(target: CachedTarget) {
		this.clearAttachWait(target);

		target.viewTexture?.destroy(false);
		target.texture?.destroy(true);

		target.viewTexture = undefined;
		target.texture = undefined;

		target.localBounds = undefined;
		target.renderRect = undefined;

		target.capacityWidth = 0;
		target.capacityHeight = 0;

		target.viewWidth = 0;
		target.viewHeight = 0;

		target.renderScaleX = 1;
		target.renderScaleY = 1;

		target.dirty = true;
	}

	private releaseStagingBuffer() {
		if (!this.stagingBuffer) return;

		pool.free(this.stagingBuffer);
		this.stagingBuffer = undefined;
	}

	private reduceSegments(
		path: SliderProgressSource | SliderProgressResult,
		out: Float32Array
	): number {
		const pointsCount = path.length;
		if (pointsCount <= 0) return 0;

		if (pointsCount === 1) {
			out[0] = this.getPointX(path, 0);
			out[1] = this.getPointY(path, 0);
			out[2] = out[0];
			out[3] = out[1];

			return 1;
		}

		let ax = this.getPointX(path, 0);
		let ay = this.getPointY(path, 0);
		let bx = this.getPointX(path, 1);
		let by = this.getPointY(path, 1);

		let written = 0;

		for (let i = 1; i < pointsCount - 1; i++) {
			const nx = this.getPointX(path, i + 1);
			const ny = this.getPointY(path, i + 1);

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

			const o = written++ * 4;
			out[o] = ax;
			out[o + 1] = ay;
			out[o + 2] = bx;
			out[o + 3] = by;

			ax = this.getPointX(path, i);
			ay = this.getPointY(path, i);
			bx = nx;
			by = ny;
		}

		const o = written++ * 4;
		out[o] = ax;
		out[o + 1] = ay;
		out[o + 2] = bx;
		out[o + 3] = by;

		return written;
	}

	private getPointX(
		path: SliderProgressSource | SliderProgressResult,
		index: number
	): number {
		return 'points' in path ? path.points[index].x : path.getPointX(index);
	}

	private getPointY(
		path: SliderProgressSource | SliderProgressResult,
		index: number
	): number {
		return 'points' in path ? path.points[index].y : path.getPointY(index);
	}

	private populateInstanceBuffer(
		path: SliderProgressSource | SliderProgressResult,
		targetGeometry: Geometry
	): Rectangle {
		const pointsCount = path.length;

		const maxSegments = Math.max(1, pointsCount - 1);
		const maxFloats = maxSegments * 4;

		const rawStaging = pool(maxFloats, 'float32');
		if (!rawStaging) {
			throw new Error(
				`Renting staging buffer (size ${
					maxFloats * Float32Array.BYTES_PER_ELEMENT
				}) failed`
			);
		}

		const staging = new Float32Array(rawStaging.buffer, 0, maxFloats);
		const segmentsCount = this.reduceSegments(path, staging);
		const requiredFloats = Math.max(4, segmentsCount * 4);

		let minX = staging[0];
		let minY = staging[1];
		let maxX = staging[0];
		let maxY = staging[1];

		for (let i = 0; i < requiredFloats; i += 2) {
			const x = staging[i];
			const y = staging[i + 1];

			if (x < minX) minX = x;
			else if (x > maxX) maxX = x;

			if (y < minY) minY = y;
			else if (y > maxY) maxY = y;
		}

		targetGeometry.instanceCount = Math.max(1, segmentsCount);

		targetGeometry.attributes.aSegment.buffer.setDataWithSize(
			staging,
			requiredFloats,
			true
		);

		this.releaseStagingBuffer();
		this.stagingBuffer = staging;

		return new Rectangle(
			minX,
			minY,
			maxX - minX,
			maxY - minY
		);
	}

	private computePaddedBounds(
		baseRect: Rectangle,
		radius: number,
		paddingScale = 1,
		extraPixels = 2
	): Rectangle {
		const pad = radius * paddingScale + extraPixels;

		return new Rectangle(
			baseRect.x - pad,
			baseRect.y - pad,
			baseRect.width + pad * 2,
			baseRect.height + pad * 2
		);
	}

	private applyUniformPatch(group: UniformGroup, patch: SliderUniformPatch) {
		const targetUniforms = group.uniforms as Record<string, unknown>;

		for (const key in patch) {
			const value = patch[key as keyof SliderUniformPatch];
			if (value !== undefined) targetUniforms[key] = value;
		}
	}
}