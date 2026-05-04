struct CustomUniforms {
    params : vec4<f32>,
    // params.x = atlasWidth in physical pixels
    // params.y = atlasHeight in physical pixels
    // params.z = clipYScale
    // params.w = clipYBias
}

struct VertexOutput {
    @builtin(position) position : vec4<f32>,

    @location(0) capsule : vec3<f32>,
    @location(1) atlasPx : vec2<f32>,
    @location(2) atlasRect : vec4<f32>,
    @location(3) params : vec4<f32>,
    @location(4) borderColor : vec4<f32>,
    @location(5) innerColor : vec4<f32>,
    @location(6) outerColor : vec4<f32>,
}

struct FragmentOutput {
    @location(0) color : vec4<f32>,
    @builtin(frag_depth) depth : f32,
}

// Pixi v8 custom Shader resources are bound at group(2) for this mesh path.
// Using group(1) can work on neither or bind zeros on WebGPU while WebGL still works.
@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;

@vertex
fn vsMain(
    @location(0) aQuad : vec2<f32>,
    @location(1) aSegment : vec4<f32>,
    @location(2) aRender : vec4<f32>,
    @location(3) aAtlas : vec4<f32>,
    @location(4) aParams : vec4<f32>,
    @location(5) aBorderColor : vec4<f32>,
    @location(6) aInnerColor : vec4<f32>,
    @location(7) aOuterColor : vec4<f32>,
) -> VertexOutput {
    let A = aSegment.xy;
    let B = aSegment.zw;

    let dir = B - A;
    let len = length(dir);

    let radius = max(aParams.x, 0.0001);

    var ndir = vec2<f32>(1.0, 0.0);
    if (len > 0.000001) {
        ndir = dir / len;
    }

    let norm = vec2<f32>(-ndir.y, ndir.x);
    let uOffset = select(1.0, -1.0, aQuad.x == 0.0);

    let localPos =
        mix(A, B, aQuad.x) +
        ndir * uOffset * radius +
        norm * aQuad.y * radius;

    let lenNorm = len / radius;
    let u = mix(0.0, lenNorm, aQuad.x) + uOffset;
    let v = aQuad.y;

    let atlasRectPx = vec4<f32>(
        aAtlas.x * customUniforms.params.x,
        aAtlas.y * customUniforms.params.y,
        aAtlas.z * customUniforms.params.x,
        aAtlas.w * customUniforms.params.y
    );

    let atlasPx = vec2<f32>(
        (localPos.x - aRender.x) * aRender.z + atlasRectPx.x,
        (localPos.y - aRender.y) * aRender.w + atlasRectPx.y
    );

    let clip = vec2<f32>(
        (atlasPx.x / customUniforms.params.x) * 2.0 - 1.0,
        (atlasPx.y / customUniforms.params.y) * customUniforms.params.z + customUniforms.params.w
    );

    var out : VertexOutput;
    out.position = vec4<f32>(clip, 0.0, 1.0);
    out.capsule = vec3<f32>(u, v, lenNorm);
    out.atlasPx = atlasPx;
    out.atlasRect = atlasRectPx;
    out.params = aParams;
    out.borderColor = vec4<f32>(aBorderColor.rgb, 1.0);
    out.innerColor = vec4<f32>(aInnerColor.rgb, 1.0);
    out.outerColor = vec4<f32>(aOuterColor.rgb, 1.0);
    return out;
}

@fragment
fn fsMain(input : VertexOutput) -> FragmentOutput {
    if (
        input.atlasPx.x < input.atlasRect.x ||
        input.atlasPx.y < input.atlasRect.y ||
        input.atlasPx.x >= input.atlasRect.x + input.atlasRect.z ||
        input.atlasPx.y >= input.atlasRect.y + input.atlasRect.w
    ) {
        discard;
    }

    let u = input.capsule.x;
    let v = input.capsule.y;
    let len = input.capsule.z;

    let dx = clamp(u, 0.0, len);
    let dist = length(vec2<f32>(u - dx, v));

    if (dist > 1.0) {
        discard;
    }

    let borderWidth = input.params.y;
    let bodyAlpha = input.params.z;

    let blurRate = fwidth(dist);
    let innerWidth = 1.0 - borderWidth;
    let factor = smoothstep(innerWidth - blurRate, innerWidth, dist);

    let innerBody = mix(input.innerColor, input.outerColor, dist);
    let color = mix(innerBody, input.borderColor, factor);

    let alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);
    let alpha = mix(bodyAlpha, 1.0, factor) * alphaFade;

    var out : FragmentOutput;
    out.color = vec4<f32>(color.rgb * alpha, alpha);
    out.depth = dist;
    return out;
}
