#version 300 es

in vec3 vCapsule;
in vec2 vAtlasLocalPx;

flat in vec2 vAtlasSizePx;
flat in vec2 vParams;
flat in vec3 vBorderColor;
flat in vec3 vInnerColor;
flat in vec3 vOuterColor;

out vec4 finalColor;

void main() {
    float u = vCapsule.x;
    float v = vCapsule.y;
    float len = vCapsule.z;

    float du = u - clamp(u, 0.0, len);
    float distSq = du * du + v * v;

    bool inRect =
    all(greaterThanEqual(vAtlasLocalPx, vec2(0.0))) &&
    all(lessThan(vAtlasLocalPx, vAtlasSizePx));

    if (!(inRect && distSq <= 1.0)) {
        discard;
    }

    float dist = sqrt(distSq);

    float borderWidth = vParams.x;
    float bodyAlpha = vParams.y;

    float blurRate = fwidth(dist);
    float innerWidth = 1.0 - borderWidth;

    float borderFactor = smoothstep(innerWidth - blurRate, innerWidth, dist);
    float alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);

    vec3 innerBody = mix(vInnerColor, vOuterColor, dist);
    vec3 color = mix(innerBody, vBorderColor, borderFactor);

    float alpha = mix(bodyAlpha, 1.0, borderFactor) * alphaFade;

    finalColor = vec4(color * alpha, alpha);
    gl_FragDepth = dist;
}