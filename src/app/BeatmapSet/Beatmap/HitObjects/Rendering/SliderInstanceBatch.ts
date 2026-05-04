import pool from '@stdlib/array-pool';
import {
	Buffer,
	BufferUsage,
	Geometry,
	Mesh,
	Shader,
	UniformGroup
} from 'pixi.js';
import RendererConfig from '../../../../Config/RendererConfig.ts';
import { inject } from '../../../../Context.ts';
import { ATLAS_GL, ATLAS_GPU, quadPositions } from './SliderAtlasPrograms.ts';
import type { SliderInstanceStyle } from './SliderAtlasTypes.ts';

function createShader(uniforms: UniformGroup) {
	return new Shader({
		glProgram: ATLAS_GL,
		gpuProgram: ATLAS_GPU,
		resources: {
			customUniforms: uniforms
		}
	});
}

function createFloatInstanceBuffer() {
	return new Buffer({
		data: new Float32Array(4),
		usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
		shrinkToFit: false
	});
}

function createUint16InstanceBuffer() {
	return new Buffer({
		data: new Uint16Array(4),
		usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
		shrinkToFit: false
	});
}

function createUint8InstanceBuffer() {
	return new Buffer({
		data: new Uint8Array(4),
		usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
		shrinkToFit: false
	});
}

function createAtlasBatchGeometry() {
	const segmentBuffer = createFloatInstanceBuffer();
	const renderBuffer = createFloatInstanceBuffer();
	const atlasBuffer = createUint16InstanceBuffer();
	const paramsBuffer = createFloatInstanceBuffer();
	const borderColorBuffer = createUint8InstanceBuffer();
	const innerColorBuffer = createUint8InstanceBuffer();
	const outerColorBuffer = createUint8InstanceBuffer();

	return new Geometry({
		attributes: {
			aQuad: {
				buffer: quadPositions,
				format: 'float32x2'
			},
			aSegment: {
				buffer: segmentBuffer,
				format: 'float32x4',
				instance: true
			},
			aRender: {
				buffer: renderBuffer,
				format: 'float32x4',
				instance: true
			},
			aAtlas: {
				buffer: atlasBuffer,
				format: 'unorm16x4',
				instance: true
			},
			aParams: {
				buffer: paramsBuffer,
				format: 'float32x4',
				instance: true
			},
			aBorderColor: {
				buffer: borderColorBuffer,
				format: 'unorm8x4',
				instance: true
			},
			aInnerColor: {
				buffer: innerColorBuffer,
				format: 'unorm8x4',
				instance: true
			},
			aOuterColor: {
				buffer: outerColorBuffer,
				format: 'unorm8x4',
				instance: true
			}
		}
	});
}

export default class SliderInstanceBatch {
	readonly geometry = createAtlasBatchGeometry();
	readonly uniforms: UniformGroup;
	readonly mesh: Mesh<Geometry, Shader>;

	private readonly segmentBuffer = this.geometry.attributes.aSegment.buffer;
	private readonly renderBuffer = this.geometry.attributes.aRender.buffer;
	private readonly atlasBuffer = this.geometry.attributes.aAtlas.buffer;
	private readonly paramsBuffer = this.geometry.attributes.aParams.buffer;
	private readonly borderColorBuffer = this.geometry.attributes.aBorderColor.buffer;
	private readonly innerColorBuffer = this.geometry.attributes.aInnerColor.buffer;
	private readonly outerColorBuffer = this.geometry.attributes.aOuterColor.buffer;

	private segmentData?: Float32Array;
	private renderData?: Float32Array;
	private atlasData?: Uint16Array;
	private paramsData?: Float32Array;
	private borderColorData?: Uint8Array;
	private innerColorData?: Uint8Array;
	private outerColorData?: Uint8Array;

	private capacity = 0;

	private readonly atlasWidth: number;
	private readonly atlasHeight: number;

	count = 0;

	constructor(atlasWidth: number, atlasHeight: number) {
		this.atlasWidth = atlasWidth;
		this.atlasHeight = atlasHeight;

		const rendererType = inject<RendererConfig>('config/renderer')?.renderer;
		const isWebGPU = rendererType === 'webgpu';

		// The atlas shader manually maps atlas pixel coordinates to clip space.
		// WebGL and WebGPU render targets need opposite Y mappings to sample the
		// same Texture.frame orientation.
		const clipYScale = isWebGPU ? -2 : 2;
		const clipYBias = isWebGPU ? 1 : -1;

		this.uniforms = new UniformGroup({
			params: {
				// x = atlas width, y = atlas height,
				// z = clip-space Y scale, w = clip-space Y bias.
				value: [atlasWidth, atlasHeight, clipYScale, clipYBias],
				type: 'vec4<f32>'
			}
		});

		const blendMode = isWebGPU ? 'max' : 'none';

		this.mesh = new Mesh({
			geometry: this.geometry,
			shader: createShader(this.uniforms),
			blendMode
		});

		this.mesh.state.depthTest = true;
		(this.mesh.state as { depthMask?: boolean }).depthMask = true;
		this.mesh.visible = false;
	}

	beginFrame() {
		this.count = 0;
		this.mesh.visible = false;
	}

	pushSegment(
		ax: number,
		ay: number,
		bx: number,
		by: number,
		renderX: number,
		renderY: number,
		renderScaleX: number,
		renderScaleY: number,
		atlasX: number,
		atlasY: number,
		atlasW: number,
		atlasH: number,
		radius: number,
		style: SliderInstanceStyle
	) {
		this.ensureCapacity(this.count + 1);

		const o = this.count * 4;

		const segmentData = this.segmentData!;
		const renderData = this.renderData!;
		const atlasData = this.atlasData!;
		const paramsData = this.paramsData!;
		const borderColorData = this.borderColorData!;
		const innerColorData = this.innerColorData!;
		const outerColorData = this.outerColorData!;

		segmentData[o] = ax;
		segmentData[o + 1] = ay;
		segmentData[o + 2] = bx;
		segmentData[o + 3] = by;

		renderData[o] = renderX;
		renderData[o + 1] = renderY;
		renderData[o + 2] = renderScaleX;
		renderData[o + 3] = renderScaleY;

		atlasData[o] = toUnorm16(atlasX / this.atlasWidth);
		atlasData[o + 1] = toUnorm16(atlasY / this.atlasHeight);
		atlasData[o + 2] = toUnorm16(atlasW / this.atlasWidth);
		atlasData[o + 3] = toUnorm16(atlasH / this.atlasHeight);

		paramsData[o] = radius;
		paramsData[o + 1] = style.borderWidth;
		paramsData[o + 2] = style.bodyAlpha;
		paramsData[o + 3] = 0;

		borderColorData[o] = toUnorm8(style.borderR);
		borderColorData[o + 1] = toUnorm8(style.borderG);
		borderColorData[o + 2] = toUnorm8(style.borderB);
		borderColorData[o + 3] = toUnorm8(style.borderA);

		innerColorData[o] = toUnorm8(style.innerR);
		innerColorData[o + 1] = toUnorm8(style.innerG);
		innerColorData[o + 2] = toUnorm8(style.innerB);
		innerColorData[o + 3] = toUnorm8(style.innerA);

		outerColorData[o] = toUnorm8(style.outerR);
		outerColorData[o + 1] = toUnorm8(style.outerG);
		outerColorData[o + 2] = toUnorm8(style.outerB);
		outerColorData[o + 3] = toUnorm8(style.outerA);

		this.count++;
	}

	upload() {
		this.geometry.instanceCount = this.count;
		this.mesh.visible = this.count > 0;

		if (this.count <= 0) return;

		const elements = this.count * 4;
		this.segmentBuffer.setDataWithSize(this.segmentData!, elements, true);
		this.renderBuffer.setDataWithSize(this.renderData!, elements, true);
		this.atlasBuffer.setDataWithSize(this.atlasData!, elements, true);
		this.paramsBuffer.setDataWithSize(this.paramsData!, elements, true);
		this.borderColorBuffer.setDataWithSize(this.borderColorData!, elements, true);
		this.innerColorBuffer.setDataWithSize(this.innerColorData!, elements, true);
		this.outerColorBuffer.setDataWithSize(this.outerColorData!, elements, true);
	}

	/**
	 * Release CPU staging arrays after the atlas render has consumed them.
	 * Pixi/GPU buffers stay alive; only the transient upload arrays return to
	 * the shared power-of-two array pool.
	 */
	releaseStaging() {
		freePooled(this.segmentData);
		freePooled(this.renderData);
		freePooled(this.atlasData);
		freePooled(this.paramsData);
		freePooled(this.borderColorData);
		freePooled(this.innerColorData);
		freePooled(this.outerColorData);

		this.segmentData = undefined;
		this.renderData = undefined;
		this.atlasData = undefined;
		this.paramsData = undefined;
		this.borderColorData = undefined;
		this.innerColorData = undefined;
		this.outerColorData = undefined;
		this.capacity = 0;
	}

	destroy() {
		this.releaseStaging();

		this.segmentBuffer.destroy();
		this.renderBuffer.destroy();
		this.atlasBuffer.destroy();
		this.paramsBuffer.destroy();
		this.borderColorBuffer.destroy();
		this.innerColorBuffer.destroy();
		this.outerColorBuffer.destroy();

		this.geometry.destroy();
		this.mesh.shader?.destroy();
		this.mesh.destroy(true);
	}

	private ensureCapacity(requiredInstances: number) {
		if (requiredInstances <= this.capacity) return;

		let nextCapacity = this.capacity || 16;
		while (nextCapacity < requiredInstances) nextCapacity <<= 1;

		const usedElements = this.count * 4;
		const requiredElements = nextCapacity * 4;

		this.segmentData = rentCopyFreeFloat32(this.segmentData, usedElements, requiredElements);
		this.renderData = rentCopyFreeFloat32(this.renderData, usedElements, requiredElements);
		this.atlasData = rentCopyFreeUint16(this.atlasData, usedElements, requiredElements);
		this.paramsData = rentCopyFreeFloat32(this.paramsData, usedElements, requiredElements);
		this.borderColorData = rentCopyFreeUint8(this.borderColorData, usedElements, requiredElements);
		this.innerColorData = rentCopyFreeUint8(this.innerColorData, usedElements, requiredElements);
		this.outerColorData = rentCopyFreeUint8(this.outerColorData, usedElements, requiredElements);

		this.capacity = nextCapacity;
	}
}

function rentFloat32(elements: number): Float32Array {
	const value = pool(elements, 'float32') as Float32Array | undefined;
	if (!value) throw new Error(`Failed to rent Float32Array(${elements}).`);
	return value;
}

function rentUint16(elements: number): Uint16Array {
	const value = pool(elements, 'uint16') as Uint16Array | undefined;
	if (!value) throw new Error(`Failed to rent Uint16Array(${elements}).`);
	return value;
}

function rentUint8(elements: number): Uint8Array {
	const value = pool(elements, 'uint8') as Uint8Array | undefined;
	if (!value) throw new Error(`Failed to rent Uint8Array(${elements}).`);
	return value;
}

function rentCopyFreeFloat32(
	old: Float32Array | undefined,
	usedElements: number,
	requiredElements: number
): Float32Array {
	const next = rentFloat32(requiredElements);
	if (old) {
		next.set(old.subarray(0, usedElements));
		freePooled(old);
	}
	return next;
}

function rentCopyFreeUint16(
	old: Uint16Array | undefined,
	usedElements: number,
	requiredElements: number
): Uint16Array {
	const next = rentUint16(requiredElements);
	if (old) {
		next.set(old.subarray(0, usedElements));
		freePooled(old);
	}
	return next;
}

function rentCopyFreeUint8(
	old: Uint8Array | undefined,
	usedElements: number,
	requiredElements: number
): Uint8Array {
	const next = rentUint8(requiredElements);
	if (old) {
		next.set(old.subarray(0, usedElements));
		freePooled(old);
	}
	return next;
}

function freePooled(value: Float32Array | Uint16Array | Uint8Array | undefined) {
	if (!value) return;
	pool.free(value);
}

function toUnorm16(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(65535, Math.round(value * 65535)));
}

function toUnorm8(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(255, Math.round(value * 255)));
}
