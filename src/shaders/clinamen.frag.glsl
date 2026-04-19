#version 300 es
// Clinamen — fragment shader (phase 2b, dispersion tuned).
//
// Reverted from phase 2c's wave-equation height field back to the analytic
// ripple-packet framework. The wave equation gave real interference and
// wall reflection but smeared the clean concentric-ring aesthetic. Discrete
// packets (Gaussian envelope × radial sine) produce crisp geometric rings
// with clearly-separable caustic bands — exactly the reference look.
//
// Dispersion coefficients lifted back up so the bright caustic edges carry
// visible spectral fringing (R on outer, B on inner), matching the classic
// caustic-with-chromatic-aberration aesthetic.
//
// Iteration trace:
//   - Phase 1 iter 1-3: point lights + analytic surface + ripples.
//   - Phase 2a: physical-radius lanterns, collision-driven ripples.
//   - Phase 2b: audio (modal bells).
//   - Phase 2c: wave equation (reverted — lost the visual target).
//   - Phase 2b-revised (this): back to analytic, dispersion tuned to match
//     the reference pool-caustic aesthetic.
//
// Coordinates:
//   - v_uv [0,1]^2 with bottom-left origin → flipped to top-left.
//   - World space is aspect-corrected: x ∈ [0, aspect], y ∈ [0, 1].
//   - Lanterns and ripples upload positions in [0, 1]^2 UV space.
//   - Lantern radius uploads in world units (uniform under aspect change).

precision highp float;

in vec2 v_uv;
out vec4 o_color;

uniform vec2  u_resolution;
uniform float u_time;
uniform int   u_lanternCount;
uniform int   u_rippleCount;
// Lantern: xy = position in [0,1]^2, z = intensity, w = radius (world units).
uniform vec4  u_lanterns[64];
// Ripple: xy = center in [0,1]^2, z = age in seconds, w = amplitude.
uniform vec4  u_ripples[24];
// Ripple shape: x = wavelength (world), y = outward speed (world/sec),
// z = temporal decay constant (sec), w = initial envelope width (world).
uniform vec4  u_rippleShape[24];

// Water base — near-black teal.
const vec3 WATER_SHALLOW = vec3(0.013, 0.021, 0.033);
const vec3 WATER_DEEP    = vec3(0.002, 0.003, 0.008);

// Lantern color layers.
const vec3 LANTERN_CORE  = vec3(1.00, 0.94, 0.82);
const vec3 LANTERN_SHELL = vec3(1.00, 0.76, 0.48);
const vec3 LANTERN_GLOW  = vec3(1.00, 0.56, 0.20);

// Caustic tint + wavelength absorption.
const vec3 CAUSTIC_TINT  = vec3(1.00, 0.88, 0.70);
const vec3 ABSORPTION    = vec3(6.0, 2.4, 1.3);
const float CAUSTIC_FALLOFF = 20.0;

const int   MAX_LANTERNS = 64;
const int   MAX_RIPPLES  = 24;
const float EPS = 0.0025;
const float TWO_PI = 6.28318530718;

// Ripple: Gaussian wave packet traveling outward from c.
//
// Two refinements beyond the textbook packet:
//   - coreMask: pins the height to zero at and near the center. Without it,
//     the sin factor at r=0 oscillates with age as the wave "passes
//     through" the source — physically wrong for a splash (water is
//     displaced around the impact, not at the impact point).
//   - fadeIn: ramps amplitude smoothly over ~45ms so ripples swell into
//     existence instead of popping on frame 1.
float rippleHeight(vec2 p, vec2 c, float age, float amp, vec4 shape) {
  float lambda   = shape.x;
  float v        = shape.y;
  float decay    = shape.z;
  float sigma0   = shape.w;
  float r        = length(p - c);
  float sigma    = sigma0 + age * 0.09;
  float temporal = exp(-age / decay);
  float fadeIn   = 1.0 - exp(-age / 0.045);
  float offset   = r - v * age;
  float spatial  = exp(-(offset * offset) / (sigma * sigma));
  const float CORE_R = 0.022;
  float coreMask = 1.0 - exp(-(r * r) / (CORE_R * CORE_R));
  return amp * sin(offset * TWO_PI / lambda) * temporal * fadeIn * spatial * coreMask;
}

float surfaceHeight(vec2 p, float t) {
  // Quiet omnipresent undulation.
  float h = 0.0;
  h += sin(dot(p, vec2(18.0,  0.0)) + t * 0.60) * 0.018;
  h += sin(dot(p, vec2( 0.0, 16.0)) - t * 0.55) * 0.018;
  h += sin(dot(p, vec2(14.0, 14.0)) + t * 0.78) * 0.012;
  h += sin(dot(p, vec2(23.0,-23.0)) - t * 0.72) * 0.010;

  // Event ripples.
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  for (int i = 0; i < MAX_RIPPLES; i++) {
    if (i >= u_rippleCount) break;
    vec2 c = u_ripples[i].xy * aspect;
    h += rippleHeight(p, c, u_ripples[i].z, u_ripples[i].w, u_rippleShape[i]);
  }
  return h;
}

void main() {
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 p = uv * aspect;
  float t = u_time;

  // ---- Caustics (single-sample laplacian, per-channel scale) ----
  // Previous version sampled 3 position-shifted laplacians for chromatic
  // dispersion — 19 surfaceHeight() calls per pixel, each looping through
  // all active ripples. Collapsed to one 5-tap stencil (4x cheaper at
  // 24-ripple load) and kept chromatic flavor via per-channel multiplier
  // only. The position-shift dispersion was invisible once caustic blend
  // dropped to 0.18 anyway.
  float hC = surfaceHeight(p,                       t);
  float hL = surfaceHeight(p - vec2(EPS, 0.0),      t);
  float hR = surfaceHeight(p + vec2(EPS, 0.0),      t);
  float hD = surfaceHeight(p - vec2(0.0, EPS),      t);
  float hU = surfaceHeight(p + vec2(0.0, EPS),      t);
  float lap = (hL + hR + hD + hU - 4.0 * hC) / (EPS * EPS);
  vec3 causticPattern = clamp(vec3(
    1.0 - lap * 0.0013,
    1.0 - lap * 0.0014,
    1.0 - lap * 0.0016
  ), 0.0, 2.0);

  // ---- Base water ----
  float vignette = smoothstep(0.10, 1.25, length(v_uv - 0.5));
  vec3 col = mix(WATER_SHALLOW, WATER_DEEP, vignette);

  // ---- Per-lantern: halo + own caustic zone ----
  vec3 halos = vec3(0.0);
  vec3 caustic = vec3(0.0);

  for (int i = 0; i < MAX_LANTERNS; i++) {
    if (i >= u_lanternCount) break;
    vec4 L = u_lanterns[i];
    vec2 lpWorld = vec2(L.x * aspect.x, L.y);
    float intensity = L.z;
    float radius = L.w;
    float dist = length(p - lpWorld);
    float nd = dist / radius;

    float shell = (1.0 - smoothstep(0.20, 1.10, nd)) * 0.38;
    float core  = exp(-nd * 6.0) * 0.55;
    float glow  = exp(-nd * 1.5) * 0.25;
    float near  = exp(-nd * 0.55) * 0.050;
    halos += LANTERN_CORE  * core  * intensity;
    halos += LANTERN_SHELL * shell * intensity;
    halos += LANTERN_GLOW  * (glow + near) * intensity;

    float falloff = exp(-dist * CAUSTIC_FALLOFF);
    vec3 absorption = exp(-ABSORPTION * dist);
    caustic += causticPattern * CAUSTIC_TINT * absorption * falloff * intensity;
  }

  // ---- Compose ----
  // Caustic blend pulled down from 0.42 — user direction was to cut
  // further; 0.18 leaves just a hint of under-lantern ripple shimmer
  // without the water pattern dominating.
  col += caustic * 0.18;
  col += halos * 0.82;

  col = col / (col + 0.45);
  col = pow(col, vec3(1.0 / 2.2));

  o_color = vec4(col, 1.0);
}
