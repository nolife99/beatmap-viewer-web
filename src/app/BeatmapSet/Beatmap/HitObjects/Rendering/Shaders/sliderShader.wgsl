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
    borderColor: vec4<f32>,
    innerColor: vec4<f32>,
    outerColor: vec4<f32>,
    borderWidth: f32,
    bodyAlpha: f32,
}

struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) dist : f32,
}

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;
@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;

@vertex
fn vsMain(
    @location(0) aPosition: vec4<f32>,
) -> VertexOutput {
    var mvp: mat3x3<f32> = globalUniforms.projectionMatrix * globalUniforms.worldTransformMatrix * localUniforms.uTransformMatrix;

    let transformed = mvp * vec3<f32>(aPosition.xy, 1.0);
    return VertexOutput(vec4<f32>(transformed.xy, aPosition.z, 1.0), aPosition.z);
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let position = input.dist;
    let blurRate = 0.02;
    let innerWidth = 1.0 - customUniforms.borderWidth;

    let t = (position - innerWidth) / blurRate;
    let factor = clamp(t, 0.0, 1.0);

    let innerBody = mix(customUniforms.innerColor, customUniforms.outerColor, position);
    let color = mix(innerBody, customUniforms.borderColor, factor);

    let innerAlpha = mix(customUniforms.bodyAlpha, 1.0, factor);
    let outerFade = clamp((1.0 - position) / blurRate, 0.0, 1.0);
    let isOuter = step(1.0 - blurRate, position);
    let alpha = mix(innerAlpha, outerFade, isOuter);

    return vec4<f32>(color.rgb * alpha, alpha);
}