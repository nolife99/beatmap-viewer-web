#version 300 es
precision highp float;

in vec3 vCapsule;
in vec2 vAtlasPx;
in vec4 vAtlasRect;
in vec4 vParams;
in vec4 vBorderColor;
in vec4 vInnerColor;
in vec4 vOuterColor;

out vec4 finalColor;

void main() {
    if (
        vAtlasPx.x < vAtlasRect.x ||
        vAtlasPx.y < vAtlasRect.y ||
        vAtlasPx.x >= vAtlasRect.x + vAtlasRect.z ||
        vAtlasPx.y >= vAtlasRect.y + vAtlasRect.w
    ) {
        discard;
    }

    float u = vCapsule.x;
    float v = vCapsule.y;
    float len = vCapsule.z;

    float dx = clamp(u, 0.0, len);
    float dist = length(vec2(u - dx, v));

    if (dist > 1.0) {
        discard;
    }

    float borderWidth = vParams.y;
    float bodyAlpha = vParams.z;

    float blurRate = fwidth(dist);
    float innerWidth = 1.0 - borderWidth;
    float factor = smoothstep(innerWidth - blurRate, innerWidth, dist);

    vec4 innerBody = mix(vInnerColor, vOuterColor, dist);
    vec4 color = mix(innerBody, vBorderColor, factor);

    float alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);
    float alpha = mix(bodyAlpha, 1.0, factor) * alphaFade;

    finalColor = vec4(color.rgb * alpha, alpha);
    gl_FragDepth = dist;
}
