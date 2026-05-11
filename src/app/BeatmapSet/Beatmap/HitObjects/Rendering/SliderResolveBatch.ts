import { Shader, type Renderer, RendererType, type Texture, UniformGroup } from 'pixi.js';
import SliderAtlasBatchBase, { createInstanceGeometry, createUniforms, packRgbAlphaByte, packUnorm16 } from './SliderAtlasBatchBase.ts';
import { ATLAS_RESOLVE_GL, ATLAS_RESOLVE_GPU, resolveQuadPositions } from './SliderAtlasPrograms.ts';
import type { AtlasSlot, SliderInstanceStyle } from './SliderAtlasTypes.ts';

const STRIDE = 32;
const STRIDE_U32 = STRIDE >>> 2;
const STRIDE_U16 = STRIDE >>> 1;
const ATLAS = 0;
const PARAMS = 8 >>> 2;
const BORDER = 20 >>> 2;
const INNER = 24 >>> 2;
const OUTER = 28 >>> 2;

export default class SliderResolveBatch extends SliderAtlasBatchBase {
	readonly uniforms: UniformGroup;
	private readonly params: Float32Array;

	constructor(width: number, height: number) {
		const { params, uniforms } = createUniforms(width, height);
		const { geometry, buffer } = createInstanceGeometry(resolveQuadPositions, STRIDE, {
			aAtlas: { format: 'unorm16x4', offset: 0 },
			aParams: { format: 'float32x3', offset: 8 },
			aBorderColor: { format: 'unorm8x4', offset: 20 },
			aInnerColor: { format: 'unorm8x4', offset: 24 },
			aOuterColor: { format: 'unorm8x4', offset: 28 }
		});

		super(width, height, STRIDE, STRIDE_U32, 32, buffer, geometry, new Shader({
			glProgram: ATLAS_RESOLVE_GL,
			gpuProgram: ATLAS_RESOLVE_GPU,
			resources: {
				customUniforms: uniforms
			}
		}));
		this.params = params;
		this.uniforms = uniforms;
	}

	applyRenderState(renderer: Renderer, coverageTexture: Texture) {
		this.applyBaseRenderState(renderer, this.params, this.uniforms, renderer.type === RendererType.WEBGPU ? 'normal' : 'none');
		if (!this.mesh.shader) return;

		this.mesh.shader.resources.uCoverageTexture = coverageTexture.source;
		this.mesh.shader.resources.uCoverageSampler = coverageTexture.source.style;
	}

	pushSlot(slot: AtlasSlot, style: SliderInstanceStyle, radius: number) {
		this.ensureCapacity(this.count + 1);
		const base32 = this.count * STRIDE_U32;
		const base16 = this.count * STRIDE_U16;
		const f32 = this.dataF32!;
		const u16 = this.data16!;
		const u32 = this.data32!;

		u16[base16 + ATLAS] = packUnorm16(slot.x * this.dataScaleX);
		u16[base16 + ATLAS + 1] = packUnorm16(slot.y * this.dataScaleY);
		u16[base16 + ATLAS + 2] = packUnorm16(slot.width * this.dataScaleX);
		u16[base16 + ATLAS + 3] = packUnorm16(slot.height * this.dataScaleY);
		f32[base32 + PARAMS] = style.borderWidth;
		f32[base32 + PARAMS + 1] = style.bodyAlpha;
		f32[base32 + PARAMS + 2] = Math.min(1, 1.25 / Math.max(1, radius * Math.max(Math.abs(slot.scaleX), Math.abs(slot.scaleY))));
		u32[base32 + BORDER] = packRgbAlphaByte(style.borderColor);
		u32[base32 + INNER] = packRgbAlphaByte(style.innerColor);
		u32[base32 + OUTER] = packRgbAlphaByte(style.outerColor);
		this.count++;
	}
}
