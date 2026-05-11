import { Shader, type Renderer, UniformGroup } from 'pixi.js';
import SliderAtlasBatchBase, { createInstanceGeometry, createUniforms, packUnorm16 } from './SliderAtlasBatchBase.ts';
import { ATLAS_COVERAGE_GL, ATLAS_COVERAGE_GPU, segmentQuadPositions } from './SliderAtlasPrograms.ts';

const STRIDE = 44;
const STRIDE_U32 = STRIDE >>> 2;
const STRIDE_U16 = STRIDE >>> 1;
const SEGMENT = 0;
const RENDER = 16 >>> 2;
const ATLAS = 32 >>> 1;
const RADIUS = 40 >>> 2;

export default class SliderCoverageBatch extends SliderAtlasBatchBase {
	readonly uniforms: UniformGroup;
	private readonly params: Float32Array;

	constructor(width: number, height: number) {
		const { params, uniforms } = createUniforms(width, height);
		const { geometry, buffer } = createInstanceGeometry(segmentQuadPositions, STRIDE, {
			aSegment: { format: 'float32x4', offset: 0 },
			aRender: { format: 'float32x4', offset: 16 },
			aAtlas: { format: 'unorm16x4', offset: 32 },
			aRadius: { format: 'float32', offset: 40 }
		});

		super(width, height, STRIDE, STRIDE_U32, 60, buffer, geometry, new Shader({
			glProgram: ATLAS_COVERAGE_GL,
			gpuProgram: ATLAS_COVERAGE_GPU,
			resources: { customUniforms: uniforms }
		}));
		this.params = params;
		this.uniforms = uniforms;
	}

	applyRenderState(renderer: Renderer) { this.applyBaseRenderState(renderer, this.params, this.uniforms, 'max'); }

	pushSegment(
		ax: number, ay: number, bx: number, by: number,
		renderX: number, renderY: number, renderScaleX: number, renderScaleY: number,
		atlasX: number, atlasY: number, atlasW: number, atlasH: number, radius: number
	) {
		this.ensureCapacity(this.count + 1);
		const base32 = this.count * STRIDE_U32;
		const base16 = this.count * STRIDE_U16;
		const f32 = this.dataF32!;
		const u16 = this.data16!;

		f32[base32 + SEGMENT] = ax;
		f32[base32 + SEGMENT + 1] = ay;
		f32[base32 + SEGMENT + 2] = bx;
		f32[base32 + SEGMENT + 3] = by;
		f32[base32 + RENDER] = renderX;
		f32[base32 + RENDER + 1] = renderY;
		f32[base32 + RENDER + 2] = renderScaleX;
		f32[base32 + RENDER + 3] = renderScaleY;
		u16[base16 + ATLAS] = packUnorm16(atlasX * this.dataScaleX);
		u16[base16 + ATLAS + 1] = packUnorm16(atlasY * this.dataScaleY);
		u16[base16 + ATLAS + 2] = packUnorm16(atlasW * this.dataScaleX);
		u16[base16 + ATLAS + 3] = packUnorm16(atlasH * this.dataScaleY);
		f32[base32 + RADIUS] = radius;
		this.count++;
	}
}
