in vec3 vCapsule;
in vec2 vAtlasLocalPx;
in vec2 vAtlasSizePx;

out vec4 finalColor;

vec4 encodeCoverage(float value) {
	float scaled = clamp(value, 0.0, 1.0) * 255.0;
	return floor(scaled + vec4(0.0, 0.25, 0.5, 0.75)) / 255.0;
}

void main() {
	float u = vCapsule.x;
	float v = vCapsule.y;
	float len = vCapsule.z;
	float du = u - clamp(u, 0.0, len);
	float distSq = du * du + v * v;

	bool inRect =
		all(greaterThanEqual(vAtlasLocalPx, vec2(0.0))) &&
		all(lessThan(vAtlasLocalPx, vAtlasSizePx));

	float coverage = inRect ? max(1.0 - sqrt(distSq), 0.0) : 0.0;
	finalColor = encodeCoverage(coverage);
}
