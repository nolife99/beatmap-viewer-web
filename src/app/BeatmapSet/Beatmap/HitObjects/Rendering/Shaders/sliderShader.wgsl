struct GlobalUniforms {
    projectionMatrix : mat3x3<f32>,
    worldTransformMatrix : mat3x3<f32>,
    worldColorAlpha : vec4<f32>,
    uResolution : vec2<f32>,
}

struct LocalUniforms {
    uTransformMatrix : mat3x3<f32>,
    uColor : vec4<f32>,
    uRound : f32,
}

struct CustomUniforms {
    borderColor : vec4<f32>,
    innerColor : vec4<f32>,
    outerColor : vec4<f32>,
    borderWidth : f32,
    bodyAlpha : f32,
    scale : f32,
    uRadius : f32,
}

struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) data : vec3<f32>,
}

struct FragmentOutput {
    @location(0) color : vec4<f32>,
    @builtin(frag_depth) depth : f32,
}

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;
@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;

@vertex
fn vsMain(
    @location(0) aQuad: vec2<f32>,
    @location(1) aSegment: vec4<f32>,
) -> VertexOutput {
    let A = aSegment.xy;
    let B = aSegment.zw;

    let dir = B - A;
    let len = length(dir);

    let ndir = select(vec2<f32>(1.0, 0.0), dir / len, len > 0.0);
    let norm = vec2<f32>(-ndir.y, ndir.x);

    let uOffset = select(1.0, -1.0, aQuad.x == 0.0);

    let radius = customUniforms.uRadius;

    let localPos =
        mix(A, B, aQuad.x) +
        ndir * uOffset * radius +
        norm * aQuad.y * radius;

    let lenNorm = len / radius;
    let u = mix(0.0, lenNorm, aQuad.x) + uOffset;
    let v = aQuad.y;

    let mvp =
        globalUniforms.projectionMatrix *
        globalUniforms.worldTransformMatrix *
        localUniforms.uTransformMatrix;

    let transformed = mvp * vec3<f32>(localPos, 1.0);

    var out: VertexOutput;
    out.position = vec4<f32>(transformed.xy, 0.0, 1.0);
    out.data = vec3<f32>(u, v, lenNorm);
    return out;
}

@fragment
fn fsMain(input: VertexOutput) -> FragmentOutput {
    let u = input.data.x;
    let v = input.data.y;
    let len = input.data.z;

    let dx = clamp(u, 0.0, len);
    let dist = length(vec2<f32>(u - dx, v));

    if (dist > 1.0) {
        discard;
    }

    let blurRate = fwidth(dist) * 1.5;
    let innerWidth = 1.0 - customUniforms.borderWidth;

    let factor = smoothstep(innerWidth - blurRate, innerWidth, dist);

    let innerBody = mix(customUniforms.innerColor, customUniforms.outerColor, dist);
    let color = mix(innerBody, customUniforms.borderColor, factor);

    let alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);
    let alpha = mix(customUniforms.bodyAlpha, 1.0, factor) * alphaFade;

    var out: FragmentOutput;
    out.color = vec4<f32>(color.rgb * alpha, alpha);
    out.depth = dist;
    return out;
}