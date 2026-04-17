import {
    AlphaFilter,
    Buffer,
    BufferUsage,
    type ColorSource,
    Geometry,
    GlProgram,
    GpuProgram,
    Mesh,
    Rectangle,
    Shader,
    UniformGroup
} from "pixi.js";
import type RendererConfig from "@/Config/RendererConfig";
import { inject } from "@/Context";
import { darken, lighten } from "@/utils.ts";
import type { SliderProgressResult } from "./CalculateSliderProgress";
import fragment from "./Shaders/sliderShader.frag?raw";
import vertex from "./Shaders/sliderShader.vert?raw";
import gpuSrc from "./Shaders/sliderShader.wgsl?raw";
import {
    acquireSegmentStagingBuffer,
    scheduleSegmentStagingRelease,
} from "./SliderSegmentStagingPool";

const GL = new GlProgram({ vertex, fragment });
const GPU = GpuProgram.from({
    vertex: { source: gpuSrc, entryPoint: "vsMain" },
    fragment: { source: gpuSrc, entryPoint: "fsMain" },
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

const quadPositions = new Float32Array([
    0,  1,
    0, -1,
    1, -1,

    0,  1,
    1, -1,
    1,  1,
]);
function createBodyGeometry() {
    return new Geometry({
        attributes: {
            aQuad: {
                buffer: new Buffer({ data: quadPositions, usage: BufferUsage.VERTEX }),
                format: "float32x2",
            },
            aSegment: {
                buffer: new Buffer({ data: new Float32Array([]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }),
                format: "float32x4",
                instance: true,
            }
        },
    });
}

function createUniformGroup(bodyAlpha: number) {
    return new UniformGroup({
        borderColor: { value: [205 / 255, 214 / 255, 244 / 255], type: "vec4<f32>" },
        innerColor: { value: lighten(COLOR, 0.5), type: "vec4<f32>" },
        outerColor: { value: darken(COLOR, 0.1), type: "vec4<f32>" },
        borderWidth: { value: 0.128, type: "f32" },
        bodyAlpha: { value: bodyAlpha, type: "f32" },
        scale: { value: 1, type: "f32" },
        uRadius: { value: 1.0, type: "f32" },
    });
}

function createShader(uniforms: UniformGroup) {
    return new Shader({
        glProgram: GL,
        gpuProgram: GPU,
        resources: {
            customUniforms: uniforms,
        },
    });
}

export default class SliderBodyRenderer {
    public readonly geometry = createBodyGeometry();
    public readonly selectionGeometry = createBodyGeometry();

    public readonly uniforms = createUniformGroup(0.7);
    public readonly selectionUniforms = createUniformGroup(0.0);

    public readonly shader: Shader;
    public readonly selectionShader: Shader;

    public readonly body: Mesh<Geometry, Shader>;
    public readonly selectionBody: Mesh<Geometry, Shader>;

    public readonly alphaFilter = new AlphaFilter();

    constructor() {
        this.shader = createShader(this.uniforms);
        this.selectionShader = createShader(this.selectionUniforms);

        const blendMode = inject<RendererConfig>("config/renderer")?.renderer === "webgl" ? "none" : "max";
        this.body = new Mesh({
            geometry: this.geometry,
            shader: this.shader,
            filters: [this.alphaFilter],
            blendMode,
        });
        this.selectionBody = new Mesh({
            geometry: this.selectionGeometry,
            shader: this.selectionShader,
            filters: [new AlphaFilter({ alpha: 1 })],
            blendMode,
        });

        this.body.state.depthTest = true;
        this.selectionBody.state.depthTest = true;
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
        const bounds = this.populateInstanceBuffer(path, this.geometry);
        this.uniforms.uniforms.uRadius = radius;
        this.body.filterArea = this.computePaddedBounds(bounds, radius);
    }

    updateSelectionGeometry(path: SliderProgressResult, radius: number) {
        const bounds = this.populateInstanceBuffer(path, this.selectionGeometry);
        this.selectionUniforms.uniforms.uRadius = radius;
        this.selectionBody.filterArea = this.computePaddedBounds(bounds, radius);
    }

    private populateInstanceBuffer(
        path: SliderProgressResult,
        targetGeometry: Geometry
    ): Rectangle {

        const { points, length: pointsCount } = path;

        if (pointsCount <= 0) {
            targetGeometry.instanceCount = 0;
            return new Rectangle(0, 0, 0, 0);
        }

        const segmentsCount = Math.max(1, pointsCount - 1);
        const requiredFloats = segmentsCount * 4;

        const staging = acquireSegmentStagingBuffer(requiredFloats);

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

        const bufferInfo = targetGeometry.attributes.aSegment.buffer;

        bufferInfo.setDataWithSize(
            staging,
            requiredFloats,
            false
        );

        targetGeometry.instanceCount = segmentsCount;
        scheduleSegmentStagingRelease();

        return new Rectangle(
            minX,
            minY,
            maxX - minX,
            maxY - minY
        );
    }

    private computePaddedBounds(baseRect: Rectangle, radius: number, paddingScale = 1, extraPixels = 0): Rectangle {
        if (baseRect.width === 0 && baseRect.height === 0) return baseRect;

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

    destroy() {
        this.geometry.destroy(true);
        this.selectionGeometry.destroy(true);
        this.shader.destroy();
        this.selectionShader.destroy();
        this.body.destroy(true);
        this.selectionBody.destroy(true);
    }
}