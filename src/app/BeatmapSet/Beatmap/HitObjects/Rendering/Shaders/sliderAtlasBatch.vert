#version 300 es

in vec2 aQuad;
in vec4 aSegment;
in vec4 aRender;
in vec4 aAtlas;
in vec2 aParams;
in vec4 aBorderColor;
in vec4 aInnerColor;
in vec4 aOuterColor;

uniform vec4 params;

out vec3 vCapsule;
out vec2 vAtlasPx;
out vec4 vAtlasRect;
out vec2 vParams; // x = borderWidth, y = bodyAlpha
out vec3 vBorderColor;
out vec3 vInnerColor;
out vec3 vOuterColor;

void main() {
    vec2 A = aSegment.xy;
    vec2 B = aSegment.zw;

    vec2 dir = B - A;
    float len = length(dir);

    float radius = max(aParams.x, 0.0001);
    vec2 ndir = len > 0.000001 ? dir / len : vec2(1.0, 0.0);
    vec2 norm = vec2(-ndir.y, ndir.x);

    float uOffset = aQuad.x == 0.0 ? -1.0 : 1.0;

    vec2 localPos =
    mix(A, B, aQuad.x) +
    ndir * uOffset * radius +
    norm * aQuad.y * radius;

    float lenNorm = len / radius;
    float u = mix(0.0, lenNorm, aQuad.x) + uOffset;
    float v = aQuad.y;

    vec4 atlasRectPx = vec4(
        aAtlas.x * params.x,
        aAtlas.y * params.y,
        aAtlas.z * params.x,
        aAtlas.w * params.y
    );

    vec2 atlasPx = vec2(
        (localPos.x - aRender.x) * aRender.z + atlasRectPx.x,
        (localPos.y - aRender.y) * aRender.w + atlasRectPx.y
    );

    vec2 clip = vec2(
        (atlasPx.x / params.x) * 2.0 - 1.0,
        (atlasPx.y / params.y) * params.z + params.w
    );

    gl_Position = vec4(clip, 0.0, 1.0);
    vCapsule = vec3(u, v, lenNorm);
    vAtlasPx = atlasPx;
    vAtlasRect = atlasRectPx;
    vParams = vec2(aParams.y, aInnerColor.a);
    vBorderColor = aBorderColor.rgb;
    vInnerColor = aInnerColor.rgb;
    vOuterColor = aOuterColor.rgb;
}