in float dist;
out vec4 finalColor;

uniform vec4 borderColor;
uniform vec4 innerColor;
uniform vec4 outerColor;
uniform float borderWidth;
uniform float bodyAlpha;

void main() {
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