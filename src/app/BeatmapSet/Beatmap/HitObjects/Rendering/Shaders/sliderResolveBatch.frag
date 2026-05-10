#version 300 es

in vec2 vCoverageUv;
in vec4 vStyleParams;
in vec3 vBorderColor;
in vec3 vInnerColor;
in vec3 vOuterColor;

uniform sampler2D uCoverageTexture;

out vec4 finalColor;

float decodeCoverage(vec4 sampleValue) {
    return clamp(dot(clamp(sampleValue, 0.0, 1.0), vec4(255.0)) * (1.0 / 1020.0), 0.0, 1.0);
}

void main() {
    float field = decodeCoverage(texture(uCoverageTexture, vCoverageUv));
    float edgeAA = max(max(fwidth(field), vStyleParams.z), 1.0 / 765.0);
    float alphaFade = smoothstep(0.0, edgeAA, field);

    float dist = clamp(1.0 - field, 0.0, 1.0);
    float borderWidth = vStyleParams.x;
    float bodyAlpha = vStyleParams.y;
    float borderAA = max(fwidth(dist), edgeAA);
    float innerWidth = 1.0 - borderWidth;
    float borderFactor = smoothstep(innerWidth - borderAA, innerWidth, dist);
    vec3 innerBody = mix(vInnerColor, vOuterColor, dist);
    vec3 color = mix(innerBody, vBorderColor, borderFactor);
    float alpha = mix(bodyAlpha, 1.0, borderFactor) * alphaFade;

    finalColor = vec4(color * alpha, alpha);
}
