#version 300 es
precision mediump float;
in vec2 aPosition;
in vec3 aColor;

out vec3 vColor;

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;

void main() {
    mat3 mvp = projectionMatrix * translationMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vColor = aColor;
}