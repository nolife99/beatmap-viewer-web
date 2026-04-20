import {
	AlphaFilter,
	Application,
	Buffer,
	BufferUsage,
	type ColorSource,
	type Container,
	Geometry,
	GlProgram,
	GpuProgram,
	Mesh,
	Rectangle,
	Shader,
	UniformGroup,
	UPDATE_PRIORITY
} from 'pixi.js';
import pool from '@stdlib/array-pool';
import type RendererConfig from '../../../../Config/RendererConfig.ts';
import { inject } from '../../../../Context.ts';
import { darken, lighten } from '../../../../utils.ts';
import type { SliderProgressResult } from './CalculateSliderProgress.ts';
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

function createBodyGeometry() {
	return new Geometry({
		attributes: {
			aQuad: {
				buffer: quadPositions,
				format: 'float32x2'
			},
			aSegment: {
				buffer: new Buffer({ data: new Float32Array([]), usage: BufferUsage.VERTEX, shrinkToFit: false }),
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

export default class SliderBodyRenderer {
	public readonly uniforms = createUniformGroup(0.7);
	public readonly selectionUniforms = createUniformGroup(0.0);

	public readonly body: Mesh<Geometry, Shader>;
	public readonly selectionBody: Mesh<Geometry, Shader>;

	public readonly alphaFilter = new AlphaFilter();

	constructor() {
		const blendMode = inject<RendererConfig>('config/renderer')?.renderer === 'webgl' ? 'none' : 'max';
		this.body = new Mesh({
			geometry: createBodyGeometry(),
			shader: createShader(this.uniforms),
			filters: [this.alphaFilter],
			blendMode
		});
		this.selectionBody = new Mesh({
			geometry: createBodyGeometry(),
			shader: createShader(this.selectionUniforms),
			filters: [new AlphaFilter({ alpha: 1 })],
			blendMode
		});

		this.body.state.depthTest = true;
		this.selectionBody.state.depthTest = true;
	}

	private static assertAttachedToAppStage(
		node: Container,
		reason?: string
	) {
		const app = inject<Application>('ui/app');
		const prefix = `Can't update staging buffer safely because node ${node.uid} is not in the scene graph: `;

		if (!app?.stage) {
			throw new Error(prefix + `Application.stage is unavailable. ${reason ?? ''}`);
		}

		let cur: Container | null = node;
		let foundStage = false;

		while (cur) {
			if (cur === app.stage) {
				foundStage = true;
				break;
			}

			if (!cur.visible) {
				throw new Error(
					prefix + `ancestor ${cur.uid} is invisible. ${reason ?? ''}`
				);
			}

			if (!cur.renderable) {
				throw new Error(
					prefix + `ancestor ${cur.uid} is non-renderable. ${reason ?? ''}`
				);
			}

			cur = cur.parent;
		}

		if (!foundStage) {
			throw new Error(
				prefix + `node is detached from Application.stage. ${reason ?? ''}`
			);
		}

		return app;
	}

	setPosition(x: number, y: number) {
		this.body.x = x;
		this.body.y = y;
		this.selectionBody.x = x;
		this.selectionBody.y = y;
	}

	setUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.applyUniformPatch(this.uniforms, patch);
		if (includeSelection) this.applyUniformPatch(this.selectionUniforms, patch);
	}

	setBodyUniforms(patch: SliderUniformPatch) {
		this.applyUniformPatch(this.uniforms, patch);
	}

	setSelectionUniforms(patch: SliderUniformPatch) {
		this.applyUniformPatch(this.selectionUniforms, patch);
	}

	updateMainGeometry(path: SliderProgressResult, radius: number) {
		const bounds = this.populateInstanceBuffer(
			path,
			this.body.geometry,
			SliderBodyRenderer.assertAttachedToAppStage(this.body, 'updateMainGeometry')
		);

		this.uniforms.uniforms.uRadius = radius;
		this.body.filterArea = this.computePaddedBounds(bounds, radius);
	}

	updateSelectionGeometry(path: SliderProgressResult, radius: number) {
		const bounds = this.populateInstanceBuffer(
			path,
			this.selectionBody.geometry,
			SliderBodyRenderer.assertAttachedToAppStage(this.selectionBody, 'updateSelectionGeometry')
		);
		this.selectionUniforms.uniforms.uRadius = radius;
		this.selectionBody.filterArea = this.computePaddedBounds(bounds, radius);
	}

	destroy() {
		this.body.geometry.attributes.aSegment.buffer.destroy();
		this.selectionBody.geometry.attributes.aSegment.buffer.destroy();

		this.body.geometry.destroy();
		this.selectionBody.geometry.destroy();

		this.body.shader?.destroy();
		this.selectionBody.shader?.destroy();

		this.body.destroy(true);
		this.selectionBody.destroy(true);
	}

	private populateInstanceBuffer(
		path: SliderProgressResult,
		targetGeometry: Geometry,
		app: Application
	): Rectangle {
		const { points, length: pointsCount } = path;

		const segmentsCount = Math.max(1, pointsCount - 1);
		const requiredFloats = segmentsCount * 4;

		const rawStaging = pool.malloc(requiredFloats, 'float32');
		if (!rawStaging) {
			throw new Error(
				`Renting staging buffer (size ${requiredFloats * Float32Array.BYTES_PER_ELEMENT})`
			);
		}

		const staging = new Float32Array(rawStaging.buffer, 0, requiredFloats);

		let minX = points[0].x;
		let minY = points[0].y;
		let maxX = points[0].x;
		let maxY = points[0].y;

		for (let i = 0; i < segmentsCount; i++) {
			const A = points[i];
			const B = (i + 1 < pointsCount) ? points[i + 1] : A;

			const offset = i * 4;
			staging[offset + 0] = A.x;
			staging[offset + 1] = A.y;
			staging[offset + 2] = B.x;
			staging[offset + 3] = B.y;

			if (B.x < minX) minX = B.x;
			if (B.y < minY) minY = B.y;
			if (B.x > maxX) maxX = B.x;
			if (B.y > maxY) maxY = B.y;
		}

		targetGeometry.attributes.aSegment.buffer.setDataWithSize(staging, requiredFloats, false);
		targetGeometry.instanceCount = segmentsCount;

		app.ticker.addOnce(
			() => pool.free(staging),
			undefined,
			UPDATE_PRIORITY.LOW
		);

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
		extraPixels = 0
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