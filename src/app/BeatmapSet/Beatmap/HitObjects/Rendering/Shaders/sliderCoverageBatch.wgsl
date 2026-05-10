struct CustomUniforms {
	params : vec4<f32>,
}

struct VertexOutput {
	@builtin(position) position : vec4<f32>,
	@location(0) capsule : vec3<f32>,
	@location(1) atlasLocalPx : vec2<f32>,
	@location(2) @interpolate(flat) atlasSizePx : vec2<f32>,
}

@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;

@vertex
fn vsMain(
	@location(0) aQuad : vec2<f32>,
	@location(1) aSegment : vec4<f32>,
	@location(2) aRender : vec4<f32>,
	@location(3) aAtlas : vec4<f32>,
	@location(4) aParams : vec2<f32>,
) -> VertexOutput {
	let p = customUniforms.params;
	let a = aSegment.xy;
	let dir = aSegment.zw - a;
	let lenSq = dot(dir, dir);
	let invLen = inverseSqrt(lenSq);
	let len = lenSq * invLen;
	let ndir = dir * invLen;
	let radius = max(aParams.x, 0.0001);
	let uOffset = aQuad.x * 2.0 - 1.0;
	let offset = vec2<f32>(
		ndir.x * uOffset - ndir.y * aQuad.y,
		ndir.y * uOffset + ndir.x * aQuad.y
	) * radius;
	let localPos = a + dir * aQuad.x + offset;
	let lenNorm = len / radius;
	let u = aQuad.x * lenNorm + uOffset;
	let atlasOriginPx = aAtlas.xy * p.xy;
	let atlasSizePx = aAtlas.zw * p.xy;
	let atlasLocalPx = (localPos - aRender.xy) * aRender.zw;
	let atlasPx = atlasLocalPx + atlasOriginPx;
	let clip = atlasPx * vec2<f32>(2.0 / p.x, p.z / p.y) + vec2<f32>(-1.0, p.w);

	var out : VertexOutput;
	out.position = vec4<f32>(clip, 0.0, 1.0);
	out.capsule = vec3<f32>(u, aQuad.y, lenNorm);
	out.atlasLocalPx = atlasLocalPx;
	out.atlasSizePx = atlasSizePx;
	return out;
}

fn encodeCoverage(value : f32) -> vec4<f32> {
	let scaled = clamp(value, 0.0, 1.0) * 255.0;
	return floor(scaled + vec4<f32>(0.0, 0.25, 0.5, 0.75)) / 255.0;
}

@fragment
fn fsMain(input : VertexOutput) -> @location(0) vec4<f32> {
	let u = input.capsule.x;
	let v = input.capsule.y;
	let len = input.capsule.z;
	let du = u - clamp(u, 0.0, len);
	let distSq = du * du + v * v;
	let inRect =
		all(input.atlasLocalPx >= vec2<f32>(0.0)) &&
		all(input.atlasLocalPx < input.atlasSizePx);

	let coverage = select(0.0, max(1.0 - sqrt(distSq), 0.0), inRect);
	return encodeCoverage(coverage);
}
