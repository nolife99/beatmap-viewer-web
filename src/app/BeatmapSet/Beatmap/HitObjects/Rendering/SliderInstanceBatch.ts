import pool from '@stdlib/array-pool';
import {
	Buffer,
	BufferUsage,
	type Color,
	Geometry,
	Mesh,
	type Renderer,
	RendererType,
	Shader,
	UniformGroup
} from 'pixi.js';
import { ATLAS_GL, ATLAS_GPU, quadPositions } from './SliderAtlasPrograms.ts';
import type { SliderInstanceStyle } from './SliderAtlasTypes.ts';

const MIN_CAPACITY = 60;
const GROWTH_FACTOR = 0.5 * (1 + Math.sqrt(5));
const GROWTH_HEADROOM = 1.15;
const SHRINK_USAGE_RATIO = 0.35;
const SHRINK_AFTER_RELEASES = 90;
const EMPTY_RELEASES_BEFORE_FREE = 180;

//  0: aSegment     float32x4  ax, ay, bx, by
// 16: aRender      float32x4  renderX, renderY, renderScaleX, renderScaleY
// 32: aAtlas       unorm16x4  atlasX, atlasY, atlasW, atlasH normalized to atlas size
// 40: aParams      float32x2  radius, borderWidth
// 48: aBorderColor unorm8x4   border rgb, unused alpha
// 52: aInnerColor  unorm8x4   inner rgb, bodyAlpha in alpha
// 56: aOuterColor  unorm8x4   outer rgb, unused alpha
const INSTANCE_STRIDE_BYTES = 60;
const INSTANCE_STRIDE_U32 = INSTANCE_STRIDE_BYTES >>> 2;
const INSTANCE_STRIDE_U16 = INSTANCE_STRIDE_BYTES >>> 1;

const OFFSET_SEGMENT = 0;
const OFFSET_RENDER = 16;
const OFFSET_ATLAS = 32;
const OFFSET_PARAMS = 40;
const OFFSET_BORDER_COLOR = 48;
const OFFSET_INNER_COLOR = 52;
const OFFSET_OUTER_COLOR = 56;

const SEGMENT_F32 = OFFSET_SEGMENT >>> 2;
const RENDER_F32 = OFFSET_RENDER >>> 2;
const ATLAS_U16 = OFFSET_ATLAS >>> 1;
const PARAMS_F32 = OFFSET_PARAMS >>> 2;
const BORDER_COLOR_U32 = OFFSET_BORDER_COLOR >>> 2;
const INNER_COLOR_U32 = OFFSET_INNER_COLOR >>> 2;
const OUTER_COLOR_U32 = OFFSET_OUTER_COLOR >>> 2;

function createShader(uniforms: UniformGroup) {
	return new Shader({
		glProgram: ATLAS_GL,
		gpuProgram: ATLAS_GPU,
		resources: {
			customUniforms: uniforms
		}
	});
}

function createInstanceBuffer() {
	return new Buffer({
		data: new Uint8Array(INSTANCE_STRIDE_BYTES),
		usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
		shrinkToFit: false
	});
}

function createAtlasBatchGeometry() {
	const instanceBuffer = createInstanceBuffer();

	return new Geometry({
		attributes: {
			aQuad: {
				buffer: quadPositions,
				format: 'float32x2'
			},
			aSegment: {
				buffer: instanceBuffer,
				format: 'float32x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_SEGMENT,
				instance: true
			},
			aRender: {
				buffer: instanceBuffer,
				format: 'float32x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_RENDER,
				instance: true
			},
			aAtlas: {
				buffer: instanceBuffer,
				format: 'unorm16x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_ATLAS,
				instance: true
			},
			aParams: {
				buffer: instanceBuffer,
				format: 'float32x2',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_PARAMS,
				instance: true
			},
			aBorderColor: {
				buffer: instanceBuffer,
				format: 'unorm8x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_BORDER_COLOR,
				instance: true
			},
			aInnerColor: {
				buffer: instanceBuffer,
				format: 'unorm8x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_INNER_COLOR,
				instance: true
			},
			aOuterColor: {
				buffer: instanceBuffer,
				format: 'unorm8x4',
				stride: INSTANCE_STRIDE_BYTES,
				offset: OFFSET_OUTER_COLOR,
				instance: true
			}
		}
	});
}

export default class SliderInstanceBatch {
	readonly geometry = createAtlasBatchGeometry();
	readonly uniforms: UniformGroup;
	readonly mesh: Mesh<Geometry, Shader>;
	count = 0;
	private readonly instanceBuffer = this.geometry.attributes.aSegment.buffer;
	private instanceData32?: Uint32Array;
	private instanceData16?: Uint16Array;
	private instanceDataF32?: Float32Array;
	private instanceDataBytes?: Uint8Array;
	private capacity = 0;
	private recentPeak = 0;
	private lowUsageReleaseCount = 0;
	private emptyReleaseCount = 0;
	private readonly invAtlasWidth: number;
	private readonly invAtlasHeight: number;
	private readonly uniformParams: Float32Array;

	constructor(atlasWidth: number, atlasHeight: number) {
		this.invAtlasWidth = 1 / atlasWidth;
		this.invAtlasHeight = 1 / atlasHeight;

		this.uniformParams = new Float32Array([atlasWidth, atlasHeight, 2, -1]);
		this.uniforms = new UniformGroup({
			params: {
				value: this.uniformParams,
				type: 'vec4<f32>'
			}
		});

		this.mesh = new Mesh({
			geometry: this.geometry,
			shader: createShader(this.uniforms)
		});

		this.mesh.state.depthTest = true;
		this.mesh.renderable = false;
	}

	beginFrame() {
		this.count = 0;
		this.mesh.renderable = false;
	}

	applyRenderState(renderer: Renderer) {
		const isWebGPU = renderer.type === RendererType.WEBGPU;

		this.mesh.groupBlendMode = isWebGPU ? 'max' : 'none';
		this.uniformParams[2] = isWebGPU ? -2 : 2;
		this.uniformParams[3] = isWebGPU ? 1 : -1;

		this.uniforms.update();
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

		const i = this.count;
		const base32 = i * INSTANCE_STRIDE_U32;
		const base16 = i * INSTANCE_STRIDE_U16;

		const f32 = this.instanceDataF32!;
		const u16 = this.instanceData16!;
		const u32 = this.instanceData32!;

		f32[base32 + SEGMENT_F32] = ax;
		f32[base32 + SEGMENT_F32 + 1] = ay;
		f32[base32 + SEGMENT_F32 + 2] = bx;
		f32[base32 + SEGMENT_F32 + 3] = by;

		f32[base32 + RENDER_F32] = renderX;
		f32[base32 + RENDER_F32 + 1] = renderY;
		f32[base32 + RENDER_F32 + 2] = renderScaleX;
		f32[base32 + RENDER_F32 + 3] = renderScaleY;

		u16[base16 + ATLAS_U16] = packUnorm16(atlasX * this.invAtlasWidth);
		u16[base16 + ATLAS_U16 + 1] = packUnorm16(atlasY * this.invAtlasHeight);
		u16[base16 + ATLAS_U16 + 2] = packUnorm16(atlasW * this.invAtlasWidth);
		u16[base16 + ATLAS_U16 + 3] = packUnorm16(atlasH * this.invAtlasHeight);

		f32[base32 + PARAMS_F32] = radius;
		f32[base32 + PARAMS_F32 + 1] = style.borderWidth;

		const bodyAlphaByte = packUnorm8(style.bodyAlpha);

		u32[base32 + BORDER_COLOR_U32] = packRgbAlphaByte(style.borderColor, 255);
		u32[base32 + INNER_COLOR_U32] = packRgbAlphaByte(style.innerColor, bodyAlphaByte);
		u32[base32 + OUTER_COLOR_U32] = packRgbAlphaByte(style.outerColor, 255);

		this.count++;
	}

	upload() {
		this.geometry.instanceCount = this.count;
		this.mesh.renderable = this.count > 0;

		if (this.count <= 0) return;

		this.recentPeak = Math.max(this.recentPeak, this.count);

		this.instanceBuffer.setDataWithSize(
			this.instanceDataBytes!,
			this.count * INSTANCE_STRIDE_BYTES,
			false
		);
	}

	releaseStaging() {
		if (this.capacity <= 0) return;

		if (this.count <= 0) {
			this.emptyReleaseCount++;

			if (this.emptyReleaseCount >= EMPTY_RELEASES_BEFORE_FREE) {
				this.freeStaging();
			}

			return;
		}

		this.emptyReleaseCount = 0;

		const usageRatio = this.count / this.capacity;

		if (usageRatio >= SHRINK_USAGE_RATIO) {
			this.lowUsageReleaseCount = 0;
			this.recentPeak = Math.max(this.recentPeak, this.count);
			return;
		}

		this.lowUsageReleaseCount++;

		if (this.lowUsageReleaseCount < SHRINK_AFTER_RELEASES) return;

		const targetCapacity = this.computeRetainedCapacity(this.recentPeak || this.count);

		if (targetCapacity < this.capacity) {
			this.resizeStaging(targetCapacity);
		}

		this.lowUsageReleaseCount = 0;
		this.recentPeak = this.count;
	}

	destroy() {
		this.freeStaging();

		this.instanceBuffer.destroy();

		this.geometry.destroy();
		this.mesh.shader?.destroy();
		this.mesh.destroy(true);
	}

	private ensureCapacity(requiredInstances: number) {
		if (requiredInstances <= this.capacity) return;

		const nextCapacity = this.computeGrowthCapacity(requiredInstances);

		this.instanceData32 = rentCopyFreeInstanceBuffer(
			this.instanceData32,
			this.count,
			nextCapacity
		);
		this.createViews(nextCapacity);

		this.capacity = nextCapacity;
	}

	private computeGrowthCapacity(requiredInstances: number) {
		let nextCapacity = this.capacity || MIN_CAPACITY;
		const requiredWithHeadroom = Math.ceil(requiredInstances * GROWTH_HEADROOM);

		while (nextCapacity < requiredWithHeadroom) {
			nextCapacity = Math.ceil(nextCapacity * GROWTH_FACTOR);
		}

		return nextCapacity;
	}

	private computeRetainedCapacity(referenceInstances: number) {
		const target = Math.max(
			MIN_CAPACITY,
			Math.ceil(referenceInstances * GROWTH_HEADROOM)
		);

		let capacity = MIN_CAPACITY;

		while (capacity < target) {
			capacity = Math.ceil(capacity * GROWTH_FACTOR);
		}

		return capacity;
	}

	private resizeStaging(nextCapacity: number) {
		if (nextCapacity <= 0) {
			this.freeStaging();
			return;
		}

		if (nextCapacity === this.capacity) return;

		freePooled(this.instanceData32);

		this.instanceData32 = rentInstanceBuffer(nextCapacity);
		this.createViews(nextCapacity);

		this.capacity = nextCapacity;
	}

	private createViews(capacity: number) {
		const data32 = this.instanceData32!;
		const byteLength = capacity * INSTANCE_STRIDE_BYTES;

		this.instanceDataBytes = new Uint8Array(data32.buffer, data32.byteOffset, byteLength);
		this.instanceData16 = new Uint16Array(data32.buffer, data32.byteOffset, byteLength >>> 1);
		this.instanceDataF32 = new Float32Array(data32.buffer, data32.byteOffset, byteLength >>> 2);
	}

	private freeStaging() {
		freePooled(this.instanceData32);

		this.instanceData32 = undefined;
		this.instanceData16 = undefined;
		this.instanceDataF32 = undefined;
		this.instanceDataBytes = undefined;

		this.capacity = 0;
		this.recentPeak = 0;
		this.lowUsageReleaseCount = 0;
		this.emptyReleaseCount = 0;
	}
}

function rentInstanceBuffer(instances: number): Uint32Array {
	const words = instances * INSTANCE_STRIDE_U32;
	const value = pool(words, 'uint32') as Uint32Array | undefined;
	if (!value) throw new Error(`Failed to rent Uint32Array(${words}).`);
	return value;
}

function rentCopyFreeInstanceBuffer(
	old: Uint32Array | undefined,
	usedInstances: number,
	requiredInstances: number
): Uint32Array {
	const next = rentInstanceBuffer(requiredInstances);

	if (old) {
		next.set(old.subarray(0, usedInstances * INSTANCE_STRIDE_U32));
		freePooled(old);
	}

	return next;
}

function freePooled(value: Uint32Array | undefined) {
	if (!value) return;
	pool.free(value);
}

function packUnorm16(value: number): number {
	return (clamp01(value) * 65535 + 0.5) | 0;
}

function packUnorm8(value: number): number {
	return (clamp01(value) * 255 + 0.5) | 0;
}

function clamp01(value: number): number {
	return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function packRgbAlphaByte(color: Color, alphaByte: number): number {
	const rgb = color.toNumber();

	return (((alphaByte & 0xFF) << 24) |
		((rgb & 0xFF) << 16) |
		(((rgb >> 8) & 0xFF) << 8) |
		((rgb >> 16) & 0xFF)
	);
}
