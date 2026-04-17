import {
    AlphaFilter,
    Buffer,
    BufferUsage, type ColorSource,
    Geometry,
    GpuProgram,
    Mesh, Rectangle,
    Shader,
} from "pixi.js";
import type RendererConfig from "@/Config/RendererConfig";
import { inject } from "@/Context";
import { darken, lighten } from "@/utils.ts";
import type { SliderProgressResult } from "./CalculateSliderProgress";
import createGeometry from "./CreateSliderGeometry";
import fragment from "./Shaders/sliderShader.frag?raw";
import vertex from "./Shaders/sliderShader.vert?raw";
import gpuSrc from "./Shaders/sliderShader.wgsl?raw";

const GL = { vertex, fragment };
const GPU = GpuProgram.from({
    vertex: {
        source: gpuSrc,
        entryPoint: "vsMain",
    },
    fragment: {
        source: gpuSrc,
        entryPoint: "fsMain",
    },
});

const COLOR: ColorSource = [
    69 / 255,
    71 / 255,
    90 / 255,
    0,
];

export type SliderUniformPatch = Partial<{
    borderColor: ColorSource;
    innerColor: ColorSource;
    outerColor: ColorSource;
    borderWidth: number;
    bodyAlpha: number;
    scale: number;
}>;

function createBodyGeometry() {
    return new Geometry({
        attributes: {
            aPosition: {
                buffer: new Buffer({
                    data: new Float32Array([]),
                    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
                }),
                format: "float32x3",
                stride: 4 * 3,
            },
        },
        indexBuffer: [],
    });
}

function createShader(bodyAlpha: number) {
    return Shader.from({
        gl: GL,
        gpu: GPU,
        resources: {
            customUniforms: {
                borderColor: {
                    value: [205 / 255, 214 / 255, 244 / 255, 1.0],
                    type: "vec4<f32>",
                },
                innerColor: { value: lighten(COLOR, 0.5), type: "vec4<f32>" },
                outerColor: { value: darken(COLOR, 0.1), type: "vec4<f32>" },
                borderWidth: { value: 0.128, type: "f32" },
                bodyAlpha: { value: bodyAlpha, type: "f32" },
                scale: { value: 1, type: "f32" },
            },
        },
    });
}

export default class SliderBodyRenderer {
    public readonly geometry = createBodyGeometry();
    public readonly selectionGeometry = createBodyGeometry();

    public readonly shader = createShader(0.7);
    public readonly selectionShader = createShader(0.0);

    public readonly alphaFilter = new AlphaFilter();

    public readonly body = new Mesh({
        geometry: this.geometry,
        shader: this.shader,
        filters: [this.alphaFilter],
        blendMode:
            inject<RendererConfig>("config/renderer")?.renderer === "webgl"
                ? "none"
                : "max",
    });

    public readonly selectionBody = new Mesh({
        geometry: this.selectionGeometry,
        shader: this.selectionShader,
        filters: [new AlphaFilter({ alpha: 1 })],
        blendMode:
            inject<RendererConfig>("config/renderer")?.renderer === "webgl"
                ? "none"
                : "max",
    });

    constructor() {
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
        this.applyUniformPatch(this.shader, patch);

        if (includeSelection) {
            this.applyUniformPatch(this.selectionShader, patch);
        }
    }

    setBodyUniforms(patch: SliderUniformPatch) {
        this.applyUniformPatch(this.shader, patch);
    }

    setSelectionUniforms(patch: SliderUniformPatch) {
        this.applyUniformPatch(this.selectionShader, patch);
    }

    updateMainGeometry(path: SliderProgressResult, radius: number) {
        const { positions, indices } = createGeometry(
            path,
            radius,
            this.geometry.attributes.aPosition.buffer.data,
            this.geometry.indexBuffer.data,
        );

        this.geometry.attributes.aPosition.buffer.data = positions;
        this.geometry.indexBuffer.data = indices;

        this.body.filterArea = computeSliderFilterArea(path, radius);
    }

    updateSelectionGeometry(path: SliderProgressResult, radius: number) {
        const { positions, indices } = createGeometry(
            path,
            radius,
            this.selectionGeometry.attributes.aPosition.buffer.data,
            this.selectionGeometry.indexBuffer.data,
        );

        this.selectionGeometry.attributes.aPosition.buffer.data = positions;
        this.selectionGeometry.indexBuffer.data = indices;

        this.selectionBody.filterArea = computeSliderFilterArea(path, radius);

        const vertexBuffer = this.geometry.attributes.aPosition.buffer.data as Float32Array;
        const indexBuffer = this.geometry.indexBuffer.data as Uint32Array;

        const vertexCount = this.selectionGeometry.attributes.aPosition.buffer.data as Float32Array;
        const indexCount = this.selectionGeometry.indexBuffer.data as Uint32Array;

        if (vertexBuffer.length < vertexCount.length) {
            this.geometry.attributes.aPosition.buffer.data = new Float32Array(vertexCount);
        }

        if (indexBuffer.length !== indexCount.length) {
            this.geometry.indexBuffer.data = new Uint32Array(indexCount);
        }
    }

    ensureMainGeometryCapacity(vertexFloatCount: number, indexCount: number) {
        const vertexBuffer = this.geometry.attributes.aPosition.buffer.data as Float32Array;
        const indexBuffer = this.geometry.indexBuffer.data as Uint32Array;

        if (vertexBuffer.length !== vertexFloatCount) {
            this.geometry.attributes.aPosition.buffer.data = new Float32Array(vertexFloatCount);
        }

        if (indexBuffer.length !== indexCount) {
            this.geometry.indexBuffer.data = new Uint32Array(indexCount);
        }
    }

    private applyUniformPatch(shader: Shader, patch: SliderUniformPatch) {
        const uniforms = shader.resources.customUniforms.uniforms as Record<string, unknown>;

        for (const key in patch) {
            const value = patch[key as keyof SliderUniformPatch];
            if (value !== undefined) uniforms[key] = value;
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

function computeSliderFilterArea(
    path: SliderProgressResult,
    radius: number,
    paddingScale = 1,
    extraPixels = 0
): Rectangle {
    const { points, length } = path;

    if (length <= 0) return new Rectangle(0, 0, 0, 0);

    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;

    for (let i = 1; i < length; i++) {
        const p = points[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }

    const pad = radius * paddingScale + extraPixels;

    return new Rectangle(
        minX - pad,
        minY - pad,
        (maxX - minX) + pad * 2,
        (maxY - minY) + pad * 2
    );
}