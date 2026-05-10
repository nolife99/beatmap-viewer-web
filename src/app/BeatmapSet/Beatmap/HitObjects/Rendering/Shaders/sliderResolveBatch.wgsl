struct CustomUniforms {
	params : vec4<f32>,
}

struct VertexOutput {
	@builtin(position) position : vec4<f32>,
	@location(0) coverageUv : vec2<f32>,
	@location(1) @interpolate(flat) styleParams : vec4<f32>,
	@location(2) @interpolate(flat) borderColor : vec3<f32>,
	@location(3) @interpolate(flat) innerColor : vec3<f32>,
	@location(4) @interpolate(flat) outerColor : vec3<f32>,
}

@group(2) @binding(0) var<uniform> customUniforms : CustomUniforms;
@group(2) @binding(1) var uCoverageTexture : texture_2d<f32>;
@group(2) @binding(2) var uCoverageSampler : sampler;

@vertex
fn vsMain(
	@location(0) aQuad : vec2<f32>,
	@location(1) aAtlas : vec4<f32>,
	@location(2) aParams : vec4<f32>,
	@location(3) aBorderColor : vec4<f32>,
	@location(4) aInnerColor : vec4<f32>,
	@location(5) aOuterColor : vec4<f32>,
) -> VertexOutput {
	let p = customUniforms.params;
	let atlasOriginPx = aAtlas.xy * p.xy;
	let atlasSizePx = aAtlas.zw * p.xy;
	let atlasPx = atlasOriginPx + aQuad * atlasSizePx;
	let clip = atlasPx * vec2<f32>(2.0 / p.x, p.z / p.y) + vec2<f32>(-1.0, p.w);

	var out : VertexOutput;
	out.position = vec4<f32>(clip, 0.0, 1.0);
	out.coverageUv = atlasPx / p.xy;
	out.styleParams = aParams;
	out.borderColor = aBorderColor.rgb;
	out.innerColor = aInnerColor.rgb;
	out.outerColor = aOuterColor.rgb;
	return out;
}

fn decodeCoverage(sampleValue : vec4<f32>) -> f32 {
	return clamp(dot(clamp(sampleValue, vec4<f32>(0.0), vec4<f32>(1.0)), vec4<f32>(255.0)) * (1.0 / 1020.0), 0.0, 1.0);
}

@fragment
fn fsMain(input : VertexOutput) -> @location(0) vec4<f32> {
	let field = decodeCoverage(textureSample(uCoverageTexture, uCoverageSampler, input.coverageUv));
	let edgeAA = max(max(fwidth(field), input.styleParams.z), 1.0 / 765.0);
	let alphaFade = smoothstep(0.0, edgeAA, field);

	let dist = clamp(1.0 - field, 0.0, 1.0);
	let borderWidth = input.styleParams.x;
	let bodyAlpha = input.styleParams.y;
	let borderAA = max(fwidth(dist), edgeAA);
	let innerWidth = 1.0 - borderWidth;
	let borderFactor = smoothstep(innerWidth - borderAA, innerWidth, dist);
	let innerBody = mix(input.innerColor, input.outerColor, dist);
	let color = mix(innerBody, input.borderColor, borderFactor);
	let alpha = mix(bodyAlpha, 1.0, borderFactor) * alphaFade;
	return vec4<f32>(color * alpha, alpha);
}
