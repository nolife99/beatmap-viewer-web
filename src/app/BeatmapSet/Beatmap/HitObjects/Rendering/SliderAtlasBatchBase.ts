import pool from '@stdlib/array-pool';
import { Buffer, BufferUsage, Geometry, Mesh, type Color, type Renderer, RendererType, Shader, UniformGroup } from 'pixi.js';

const GROWTH = 0.5 * (1 + Math.sqrt(5));
const HEADROOM = 1.05;
const SHRINK_RATIO = 0.5;
const SHRINK_AFTER = 20;
const EMPTY_FREE_AFTER = 30;

export type InstanceGeometry = { geometry: Geometry; buffer: Buffer };
export type InstanceAttribute = { format: string; offset: number };

export function createUniforms(width: number, height: number) {
	const params = new Float32Array([width, height, 2, -1]);
	return { params, uniforms: new UniformGroup({ params: { value: params, type: 'vec4<f32>' } }) };
}

export function createInstanceGeometry(
	quad: Buffer,
	stride: number,
	attributes: Record<string, InstanceAttribute>
): InstanceGeometry {
	const buffer = new Buffer({ data: new Uint8Array(stride), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, shrinkToFit: false });
	const geometryAttributes: Record<string, unknown> = { aQuad: { buffer: quad, format: 'float32x2' } };

	for (const name in attributes) {
		const attribute = attributes[name];
		geometryAttributes[name] = { buffer, stride, instance: true, ...attribute };
	}

	return { geometry: new Geometry({ attributes: geometryAttributes as any }), buffer };
}

export default class SliderAtlasBatchBase {
	readonly geometry: Geometry;
	readonly mesh: Mesh<Geometry, Shader>;
	count = 0;

	protected readonly dataScaleX: number;
	protected readonly dataScaleY: number;
	protected data32?: Uint32Array;
	protected data16?: Uint16Array;
	protected dataF32?: Float32Array;
	protected dataBytes?: Uint8Array;

	private capacity = 0;
	private recentPeak = 0;
	private lowUsageFrames = 0;
	private emptyFrames = 0;

	constructor(
		width: number,
		height: number,
		private readonly strideBytes: number,
		private readonly strideU32: number,
		private readonly minCapacity: number,
		private readonly instanceBuffer: Buffer,
		geometry: Geometry,
		shader: Shader
	) {
		this.dataScaleX = 1 / width;
		this.dataScaleY = 1 / height;
		this.geometry = geometry;
		this.mesh = new Mesh({ geometry, shader });
		this.mesh.renderable = false;
	}

	beginFrame() { this.count = 0; this.mesh.renderable = false; }

	applyBaseRenderState(renderer: Renderer, params: Float32Array, uniforms: UniformGroup, blendMode: string) {
		const isWebGPU = renderer.type === RendererType.WEBGPU;
		this.mesh.state.depthTest = false;
		this.mesh.state.depthMask = false;
		this.mesh.groupBlendMode = blendMode;
		params[2] = isWebGPU ? -2 : 2;
		params[3] = isWebGPU ? 1 : -1;
		uniforms.update();
	}

	upload() {
		this.geometry.instanceCount = this.count;
		this.mesh.renderable = this.count > 0;
		if (this.count <= 0) return;
		this.recentPeak = Math.max(this.recentPeak, this.count);
		this.instanceBuffer.setDataWithSize(this.dataBytes!, this.count * this.strideBytes, false);
	}

	releaseStaging() {
		if (this.capacity <= 0) return;
		if (this.count <= 0) {
			if (++this.emptyFrames >= EMPTY_FREE_AFTER) this.freeStaging();
			return;
		}

		this.emptyFrames = 0;
		if (this.count / this.capacity >= SHRINK_RATIO) {
			this.lowUsageFrames = 0;
			this.recentPeak = Math.max(this.recentPeak, this.count);
			return;
		}

		if (++this.lowUsageFrames < SHRINK_AFTER) return;
		const next = this.retainedCapacity(this.recentPeak || this.count);
		if (next < this.capacity) this.resizeStaging(next);
		this.lowUsageFrames = 0;
		this.recentPeak = this.count;
	}

	destroy() {
		this.freeStaging();
		this.instanceBuffer.destroy();
		this.geometry.destroy();
		this.mesh.shader?.destroy();
		this.mesh.destroy(true);
	}

	protected ensureCapacity(required: number) {
		if (required <= this.capacity) return;
		let next = this.capacity || this.minCapacity;
		const target = Math.ceil(required * HEADROOM);
		while (next < target) next = Math.ceil(next * GROWTH);

		const old = this.data32;
		this.data32 = this.rent(next);
		if (old) {
			this.data32.set(old.subarray(0, this.count * this.strideU32));
			pool.free(old);
		}
		this.createViews(next);
		this.capacity = next;
	}

	private retainedCapacity(reference: number) {
		let capacity = this.minCapacity;
		const target = Math.max(this.minCapacity, Math.ceil(reference * HEADROOM));
		while (capacity < target) capacity = Math.ceil(capacity * GROWTH);
		return capacity;
	}

	private resizeStaging(capacity: number) {
		if (capacity === this.capacity) return;
		freePooled(this.data32);
		this.data32 = this.rent(capacity);
		this.createViews(capacity);
		this.capacity = capacity;
	}

	private rent(instances: number): Uint32Array {
		const words = instances * this.strideU32;
		const value = pool(words, 'uint32') as Uint32Array | undefined;
		if (!value) throw new Error(`Failed to rent Uint32Array(${words}).`);
		return value;
	}

	private createViews(capacity: number) {
		const byteLength = capacity * this.strideBytes;
		const data32 = this.data32!;
		this.dataBytes = new Uint8Array(data32.buffer, data32.byteOffset, byteLength);
		this.data16 = new Uint16Array(data32.buffer, data32.byteOffset, byteLength >>> 1);
		this.dataF32 = new Float32Array(data32.buffer, data32.byteOffset, byteLength >>> 2);
	}

	private freeStaging() {
		freePooled(this.data32);
		this.data32 = this.data16 = this.dataF32 = this.dataBytes = undefined;
		this.capacity = this.recentPeak = this.lowUsageFrames = this.emptyFrames = 0;
	}
}

export function freePooled(value?: Uint32Array) { if (value) pool.free(value); }
export function packUnorm16(value: number) { return (clamp01(value) * 65535 + 0.5) | 0; }
export function clamp01(value: number) { return value <= 0 ? 0 : value >= 1 ? 1 : value; }
export function packRgbAlphaByte(color: Color, alphaByte = 255) {
	const rgb = color.toNumber();
	return (((alphaByte & 0xFF) << 24) | ((rgb & 0xFF) << 16) | (((rgb >> 8) & 0xFF) << 8) | ((rgb >> 16) & 0xFF));
}
