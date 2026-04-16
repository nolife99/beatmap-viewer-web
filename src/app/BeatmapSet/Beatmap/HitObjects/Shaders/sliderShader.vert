in vec3 aPosition;
out float dist;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

    dist = aPosition.z;
    vec3 transformed = mvp * vec3(aPosition.xy, 1.0);
    gl_Position = vec4(transformed.xy, aPosition.z, 1.0);
}