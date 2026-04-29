import pool from '@stdlib/array-pool';
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
import RendererConfig from '../../../../Config/RendererConfig.ts';
import { inject } from '../../../../Context.ts';
import { darken, lighten } from '../../../../utils.ts';
import { SliderProgressResult } from './CalculateSliderProgress.ts';
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

	private reduceSegments(
		points: SliderProgressResult['points'],
		pointsCount: number,
		out: Float32Array
	): number {
		if (pointsCount <= 0) return 0;

		if (pointsCount === 1) {
			const p = points[0];

			out[0] = p.x;
			out[1] = p.y;
			out[2] = p.x;
			out[3] = p.y;

			return 1;
		}

		let ax = points[0].x;
		let ay = points[0].y;
		let bx = points[1].x;
		let by = points[1].y;

		let written = 0;

		for (let i = 1; i < pointsCount - 1; i++) {
			const nx = points[i + 1].x;
			const ny = points[i + 1].y;

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

			const p = points[i];
			ax = p.x;
			ay = p.y;
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

	private populateInstanceBuffer(
		path: SliderProgressResult,
		targetGeometry: Geometry,
		app: Application
	): Rectangle {
		const { points, length: pointsCount } = path;

		const maxSegments = Math.max(1, pointsCount - 1);
		const maxFloats = maxSegments * 4;

		const rawStaging = pool(maxFloats, 'float32');
		if (!rawStaging) {
			throw new Error(
				`Renting staging buffer (size ${maxFloats * Float32Array.BYTES_PER_ELEMENT}) failed`
			);
		}

		const staging = new Float32Array(rawStaging.buffer, 0, maxFloats);
		const segmentsCount = this.reduceSegments(points, pointsCount, staging);
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

		targetGeometry.attributes.aSegment.buffer.setDataWithSize(
			staging,
			requiredFloats,
			false
		);

		targetGeometry.instanceCount = Math.max(1, segmentsCount);

		app.ticker.addOnce(
			() => pool.free(staging),
			undefined,
			UPDATE_PRIORITY.UTILITY
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