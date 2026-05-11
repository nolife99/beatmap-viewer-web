in vec2 aQuad;
in vec4 aAtlas;
in vec3 aParams;
in vec4 aBorderColor;
in vec4 aInnerColor;
in vec4 aOuterColor;

uniform vec4 params;

out vec2 vCoverageUv;
out vec3 vStyleParams;
out vec3 vBorderColor;
out vec3 vInnerColor;
out vec3 vOuterColor;

void main() {
	vec2 atlasOriginPx = aAtlas.xy * params.xy;
	vec2 atlasSizePx = aAtlas.zw * params.xy;
	vec2 atlasPx = atlasOriginPx + aQuad * atlasSizePx;
	vec2 clip = atlasPx * vec2(2.0 / params.x, params.z / params.y) + vec2(-1.0, params.w);

	gl_Position = vec4(clip, 0.0, 1.0);
	vCoverageUv = atlasPx / params.xy;
	vStyleParams = aParams;
	vBorderColor = aBorderColor.rgb;
	vInnerColor = aInnerColor.rgb;
	vOuterColor = aOuterColor.rgb;
}
