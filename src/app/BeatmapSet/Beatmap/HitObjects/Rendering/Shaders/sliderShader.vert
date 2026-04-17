in vec2 aQuad;
in vec4 aSegment; // instance data A.x, A.y, B.x, B.y

out vec3 vData;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

uniform float uRadius;

void main() {
    vec2 A = aSegment.xy;
    vec2 B = aSegment.zw;

    // Segment direction and normal
    vec2 dir = B - A;
    float len = length(dir);
    vec2 ndir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
    vec2 norm = vec2(-ndir.y, ndir.x);

    // aQuad.x is 0 at A; 1 at B
    // If at A, extend backwards; at B, forwards
    float u_offset = (aQuad.x == 0.0) ? -1.0 : 1.0;

    // Expand the bounding box corner
    vec2 localPos = mix(A, B, aQuad.x) + (ndir * u_offset * uRadius) + (norm * aQuad.y * uRadius);

    // SDF coords for frag
    float len_norm = len / uRadius;
    float u = mix(0.0, len_norm, aQuad.x) + u_offset;
    float v = aQuad.y;
    vData = vec3(u, v, len_norm);

    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec3 transformed = mvp * vec3(localPos, 1.0);

    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}