#version 300 es

in vec3 vData;
out vec4 finalColor;

uniform vec4 borderColor;
uniform vec4 innerColor;
uniform vec4 outerColor;
uniform float borderWidth;
uniform float bodyAlpha;

void main() {
    float u = vData.x;
    float v = vData.y;
    float len = vData.z;

    // Calculate exact shortest distance to the line segment inside the bounded quad
    float dx = clamp(u, 0.0, len);
    float dist = length(vec2(u - dx, v));

    // Discard pixels outside the radius
    if (dist > 1.0) {
        discard;
    }

    // Properly union overlaps
    gl_FragDepth = dist;

    float blurRate = fwidth(dist);
    float innerWidth = 1.0 - borderWidth;

    float factor = smoothstep(innerWidth - blurRate, innerWidth, dist);

    vec4 innerBody = mix(innerColor, outerColor, dist);
    vec4 color = mix(innerBody, borderColor, factor);

    float alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);
    float alpha = mix(bodyAlpha, 1.0, factor) * alphaFade;

    finalColor = vec4(color.rgb * alpha, alpha);
}