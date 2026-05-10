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
out vec2 vAtlasLocalPx;

flat out vec2 vAtlasSizePx;
flat out vec2 vParams; // x = borderWidth, y = bodyAlpha
flat out vec3 vBorderColor;
flat out vec3 vInnerColor;
flat out vec3 vOuterColor;

void main() {
    vec2 a = aSegment.xy;
    vec2 dir = aSegment.zw - a;

    float lenSq = dot(dir, dir);
    float invLen = inversesqrt(lenSq);
    float len = lenSq * invLen;
    vec2 ndir = dir * invLen;

    float radius = max(aParams.x, 0.0001);
    float invRadius = 1.0 / radius;

    float uOffset = aQuad.x * 2.0 - 1.0;

    vec2 offset = vec2(
    ndir.x * uOffset - ndir.y * aQuad.y,
    ndir.y * uOffset + ndir.x * aQuad.y
    ) * radius;

    vec2 localPos = a + dir * aQuad.x + offset;

    float lenNorm = len * invRadius;
    float u = aQuad.x * lenNorm + uOffset;

    vec2 atlasOriginPx = aAtlas.xy * params.xy;
    vec2 atlasSizePx = aAtlas.zw * params.xy;

    vec2 atlasLocalPx = (localPos - aRender.xy) * aRender.zw;
    vec2 atlasPx = atlasLocalPx + atlasOriginPx;

    vec2 clip = atlasPx * vec2(2.0 / params.x, params.z / params.y) + vec2(-1.0, params.w);

    gl_Position = vec4(clip, 0.0, 1.0);

    vCapsule = vec3(u, aQuad.y, lenNorm);
    vAtlasLocalPx = atlasLocalPx;
    vAtlasSizePx = atlasSizePx;
    vParams = vec2(aParams.y, aInnerColor.a);
    vBorderColor = aBorderColor.rgb;
    vInnerColor = aInnerColor.rgb;
    vOuterColor = aOuterColor.rgb;
}