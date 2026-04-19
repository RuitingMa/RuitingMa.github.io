#version 300 es
// Clinamen vertex shader — full-screen quad.
// a_pos is in clip space [-1, 1]^2; v_uv carries [0, 1]^2 with origin at
// bottom-left (standard GL). The fragment shader flips y if it wants a
// top-left origin.
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
