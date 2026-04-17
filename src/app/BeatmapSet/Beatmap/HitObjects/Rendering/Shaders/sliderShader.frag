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

    // Write to the depth buffer for correct overlap unioning
    gl_FragDepth = dist;

    float position = dist;
    float blurRate = 0.02;
    float innerWidth = 1.0 - borderWidth;

    float t = (position - innerWidth) / blurRate;
    float factor = clamp(t, 0.0, 1.0);

    vec4 innerBody = mix(innerColor, outerColor, position);
    vec4 color = mix(innerBody, borderColor, factor);

    float innerAlpha = mix(bodyAlpha, 1.0, factor);
    float outerFade = clamp((1.0 - position) / blurRate, 0.0, 1.0);
    float isOuter = step(1.0 - blurRate, position);
    float alpha = mix(innerAlpha, outerFade, isOuter);

    finalColor = vec4(color.rgb * alpha, alpha);
}