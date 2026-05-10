struct CustomUniforms {
	params : vec4<f32>,
	// params.x = atlasWidth in physical pixels
	// params.y = atlasHeight in physical pixels
	// params.z = clipYScale
	// params.w = clipYBias
}

struct VertexOutput {
	@builtin(position) position : vec4<f32>,

	@location(0) capsule : vec3<f32>,
	@location(1) atlasLocalPx : vec2<f32>,

	@location(2) @interpolate(flat) atlasSizePx : vec2<f32>,
	@location(3) @interpolate(flat) params : vec2<f32>, // x = borderWidth, y = bodyAlpha
	@location(4) @interpolate(flat) borderColor : vec3<f32>,
	@location(5) @interpolate(flat) innerColor : vec3<f32>,
	@location(6) @interpolate(flat) outerColor : vec3<f32>,
}

struct FragmentOutput {
	@location(0) color : vec4<f32>,
	@builtin(frag_depth) depth : f32,
}

@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;

@vertex
fn vsMain(
	@location(0) aQuad : vec2<f32>,
	@location(1) aSegment : vec4<f32>,
	@location(2) aRender : vec4<f32>,
	@location(3) aAtlas : vec4<f32>,
	@location(4) aParams : vec2<f32>,
	@location(5) aBorderColor : vec4<f32>,
	@location(6) aInnerColor : vec4<f32>,
	@location(7) aOuterColor : vec4<f32>,
) -> VertexOutput {
	let p = customUniforms.params;

	let a = aSegment.xy;
	let dir = aSegment.zw - a;

	let lenSq = dot(dir, dir);
	let invLen = inverseSqrt(lenSq);
	let len = lenSq * invLen;
	let ndir = dir * invLen;

	let radius = max(aParams.x, 0.0001);
	let invRadius = 1.0 / radius;

	let uOffset = aQuad.x * 2.0 - 1.0;

	let offset = vec2<f32>(
		ndir.x * uOffset - ndir.y * aQuad.y,
		ndir.y * uOffset + ndir.x * aQuad.y
	) * radius;

	let localPos = a + dir * aQuad.x + offset;

	let lenNorm = len * invRadius;
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
	out.params = vec2<f32>(aParams.y, aInnerColor.a);
	out.borderColor = aBorderColor.rgb;
	out.innerColor = aInnerColor.rgb;
	out.outerColor = aOuterColor.rgb;
	return out;
}

@fragment
fn fsMain(input : VertexOutput) -> FragmentOutput {
	let u = input.capsule.x;
	let v = input.capsule.y;
	let len = input.capsule.z;

	let du = u - clamp(u, 0.0, len);
	let distSq = du * du + v * v;

	let inRect =
		all(input.atlasLocalPx >= vec2<f32>(0.0)) &&
		all(input.atlasLocalPx < input.atlasSizePx);

	if (!(inRect && distSq <= 1.0)) {
		discard;
	}

	let dist = sqrt(distSq);

	let borderWidth = input.params.x;
	let bodyAlpha = input.params.y;

	let blurRate = fwidth(dist);
	let innerWidth = 1.0 - borderWidth;

	let borderFactor = smoothstep(innerWidth - blurRate, innerWidth, dist);
	let alphaFade = 1.0 - smoothstep(1.0 - blurRate, 1.0, dist);

	let innerBody = mix(input.innerColor, input.outerColor, dist);
	let color = mix(innerBody, input.borderColor, borderFactor);

	let alpha = mix(bodyAlpha, 1.0, borderFactor) * alphaFade;

	var out : FragmentOutput;
	out.color = vec4<f32>(color * alpha, alpha);
	out.depth = dist;
	return out;
}