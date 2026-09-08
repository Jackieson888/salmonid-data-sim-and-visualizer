// Renderer, fixed camera, sky sphere, bloom/tone-mapping composer.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FOG_COLOR, FOG_GLSL, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { glslFloat } from "./glsl.js";
import { QUALITY } from "../quality.js";

// Sun disc + halo tuning for the sky shader below.
const SUN_DISC_EXPONENT = 350;
const SUN_DISC_STRENGTH = 1.2;
const SUN_HALO_EXPONENT = 6;
const SUN_HALO_STRENGTH = 0.12;

// Widens Snell's window for the sky sphere's own murk path so the seasonal sky actually reads; purely artistic.
const SKY_FOG_SCALE = 0.62;

// Below this much upward tilt, treat a view ray as never reaching the surface.
const MIN_UPWARD_COMPONENT = 0.001;

// Vignette + grain, deliberately asymmetric top vs. bottom.
const VIGNETTE_TOP = 0.25;
const VIGNETTE_BOTTOM = 1.1;

// Broad darkening across the bottom edge, on top of the radial falloff above.
const VIGNETTE_BOTTOM_EDGE = 0.35;
const VIGNETTE_BOTTOM_FADE = 0.5;

// Radial falloff start/full-strength distance in uv space (corners are at 0.707).
const VIGNETTE_START = 0.2;
const VIGNETTE_END = 0.78;

// Proportional grain — dithers banding in this scene's smooth dark gradients.
const GRAIN_AMOUNT = 0.03;

const FOV = 90;
const NEAR = 1;

// Portrait-only correction: grows vertical FOV below aspect 1 so horizontal FOV holds near its landscape value, capped against fisheye.
const PORTRAIT_FOV_CAP = 105;

function verticalFovForAspect(aspect) {
  if (aspect >= 1) return FOV;
  const halfFovRad = (FOV * Math.PI) / 360;
  const correctedDeg =
    (2 * Math.atan(Math.tan(halfFovRad) / aspect) * 180) / Math.PI;
  return Math.min(correctedDeg, PORTRAIT_FOV_CAP);
}

// Spliced into OutputPass's shader rather than run as its own pass; reads/writes `texel`, sampled by the line it replaces.
const VIGNETTE_GLSL = /* glsl */ `
  {
    // uAspect stretches the x term so uv distance corresponds to comparable physical distance on a portrait screen.
    vec2 centered = vUv - 0.5;
    centered.x *= uAspect;
    float radial = smoothstep(
      ${glslFloat(VIGNETTE_START)},
      ${glslFloat(VIGNETTE_END)},
      length(centered)
    );
    float strength = mix(uBottomStrength, uTopStrength, vUv.y);
    float bottom = uBottomEdge
      * (1.0 - smoothstep(0.0, ${glslFloat(VIGNETTE_BOTTOM_FADE)}, vUv.y));

    texel.rgb *= 1.0 - clamp(radial * strength + bottom, 0.0, 1.0);

    // Proportional grain, centered on 1.0, dithering banding in dark gradients.
    float grain = fract(
      sin(dot(gl_FragCoord.xy + uFrame, vec2(127.1, 311.7))) * 43758.5453123
    );
    texel.rgb *= 1.0 + (grain - 0.5) * uGrain;
  }
`;

// OutputPass with the vignette/grain spliced ahead of its tone-mapping ladder; subclassed so it keeps owning tone-mapping defines.
class VignetteOutputPass extends OutputPass {
  constructor() {
    super();

    const SAMPLE_LINE = /gl_FragColor\s*=\s*texture2D\(\s*tDiffuse,\s*vUv\s*\);/;
    const source = this.material.fragmentShader;
    if (!SAMPLE_LINE.test(source)) {
      throw new Error(
        "VignetteOutputPass: could not find OutputShader's tDiffuse sample " +
          "line to splice the vignette into. three.js's OutputShader has " +
          "changed shape — re-check sceneSetup.js against it.",
      );
    }

    // Same uniforms object OutputPass's material holds — mutating it here reaches the material before the shader compiles.
    Object.assign(this.uniforms, {
      uTopStrength: { value: VIGNETTE_TOP },
      uBottomStrength: { value: VIGNETTE_BOTTOM },
      uBottomEdge: { value: VIGNETTE_BOTTOM_EDGE },
      uGrain: { value: GRAIN_AMOUNT },
      // No-op until resize() pushes camera.aspect in.
      uAspect: { value: 1 },
      // Bumped every frame to decorrelate grain between frames.
      uFrame: { value: 0 },
    });

    this.material.fragmentShader = source.replace(
      SAMPLE_LINE,
      `vec4 texel = texture2D( tDiffuse, vUv );
       ${VIGNETTE_GLSL}
       gl_FragColor = texel;`,
    );

    // RawShaderMaterial declares every uniform by hand — new ones need it too.
    this.material.fragmentShader = this.material.fragmentShader.replace(
      "uniform sampler2D tDiffuse;",
      `uniform sampler2D tDiffuse;
       uniform float uTopStrength;
       uniform float uBottomStrength;
       uniform float uBottomEdge;
       uniform float uGrain;
       uniform float uAspect;
       uniform float uFrame;`,
    );
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // Wrapped at 1024 to avoid float-precision loss in the grain hash.
    this.uniforms.uFrame.value = (this.uniforms.uFrame.value + 1) % 1024;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

// Sky sphere scale, as a fraction of camera.far.
const SKY_RADIUS_FRAC = 0.9;

// Camera framing as fractions of world bounds (worldX=downstream, worldZ=across-river, worldY=up), broadside to the run.
const EYE_FRAC = { x: 0.648, y: -0.2, z: 0.853 };
const TARGET_FRAC = { x: 0.4, y: -0.075, z: 0.22 };

// pixelBounds = physical on-screen size; worldBounds = the smaller size the scene's content is built against.
export function createSceneSetup(canvas, pixelBounds, worldBounds) {
  // antialias/depth/stencil off deliberately — everything draws through EffectComposer instead.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio),
  );

  // ACES applied once globally via OutputPass, since hand-written ShaderMaterials never pick up renderer.toneMapping directly.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;

  // No scene.fog — all visible fog comes from FOG_GLSL's applyFog(), called explicitly per-material.
  const scene = new THREE.Scene();

  // Overwritten by the first setSeason() call; starting values just let the material compile.
  const skyUniforms = {
    uSkyColor: { value: new THREE.Color("#1a56a8") },
    uHorizonColor: { value: new THREE.Color("#e8896b") },
    uWaterColor: { value: new THREE.Color("#09223f") },
    uDepthsColor: { value: new THREE.Color("#061a2e") },
    uSunColor: { value: new THREE.Color("#dce9ff") },
    uSunDirection: { value: new THREE.Vector3(0.65, 0.34, 0.35).normalize() },
    uSunIntensity: { value: 1.5 },
    uHorizonStrength: { value: 0.6 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(worldBounds) },
    uFogDepthRate: { value: fogDepthRate(worldBounds) },
  };

  // Sky sphere, not scene.background, so it can gradient by world Y and stay centered on the camera.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${FOG_GLSL}

        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uWaterColor;
        uniform vec3 uDepthsColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uSunIntensity;
        uniform float uHorizonStrength;
        varying vec3 vPosition;

        void main() {
          vec3 dir = normalize(vPosition);

          // Warm horizon tone, scaled by how low the season's sun sits.
          vec3 horizonTone = mix(uSkyColor, uHorizonColor, uHorizonStrength);

          // Refraction compresses the sky into a ~97-degree cone, so the horizon band lands well above dir.y = 0.
          float up = clamp(dir.y, 0.0, 1.0);
          vec3 above = mix(horizonTone, uSkyColor, smoothstep(0.15, 0.8, up));

          // Sun disc + halo, faded through the waterline so it doesn't also appear mirrored below the horizon.
          float sunDot = max(dot(dir, uSunDirection), 0.0);
          float sun = pow(sunDot, ${glslFloat(SUN_DISC_EXPONENT)}) * ${glslFloat(SUN_DISC_STRENGTH)}
            + pow(sunDot, ${glslFloat(SUN_HALO_EXPONENT)}) * ${glslFloat(SUN_HALO_STRENGTH)};
          above += uSunColor * sun * uSunIntensity
            * smoothstep(0.0, 0.06, dir.y);

          // Below the waterline: body color sinking into the depths.
          float down = clamp(-dir.y, 0.0, 1.0);
          vec3 below = mix(uWaterColor, uDepthsColor, smoothstep(0.0, 0.45, down));

          vec3 color = mix(below, above, smoothstep(-0.02, 0.02, dir.y));

          // Path length to the surface; level-or-down rays never escape, so it's pure murk.
          float cameraDepth = max(-cameraPosition.y, 0.0);
          float murk = 1.0;
          if (dir.y > ${glslFloat(MIN_UPWARD_COMPONENT)}) {
            float pathLength = cameraDepth / dir.y;
            float d = uFogDensity * ${glslFloat(SKY_FOG_SCALE)} * pathLength;
            murk = 1.0 - exp(-d * d);
          }

          // Depth-graded murk color, sampled one fog length along the ray since a background ray has no surface depth.
          vec3 murkPoint = cameraPosition + dir / uFogDensity;
          gl_FragColor =
            vec4(mix(color, fogColorAt(murkPoint), clamp(murk, 0.0, 1.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, 1000);

  // No THREE lights — every material is a hand-written ShaderMaterial that reads sun uniforms directly.

  // Kept around, not a local, since main.js's debug readout reads it too.
  const cameraTarget = new THREE.Vector3();

  // Places the camera at EYE_FRAC looking at TARGET_FRAC, both scaled to the given bounds.
  function applyFraming(b) {
    camera.position.set(
      b.width * EYE_FRAC.x,
      b.height * EYE_FRAC.y,
      b.height * EYE_FRAC.z,
    );
    cameraTarget.set(
      b.width * TARGET_FRAC.x,
      b.height * TARGET_FRAC.y,
      b.height * TARGET_FRAC.z,
    );
    camera.lookAt(cameraTarget);
  }

  // Kept alongside `composer` so resize() tracks whichever pass instance applyQuality() most recently rebuilt.
  let vignettePass;

  // RenderPass -> UnrealBloomPass (tiered full/half/off) -> OutputPass (tone-mapping/vignette); a function since a tier change rebuilds it.
  function buildComposer(b) {
    const next = new EffectComposer(renderer);
    next.addPass(new RenderPass(scene, camera));

    if (QUALITY.bloom !== "off") {
      const scale = QUALITY.bloom === "half" ? 0.5 : 1;
      next.addPass(
        new UnrealBloomPass(
          new THREE.Vector2(b.width * scale, b.height * scale),
          0.4, // strength
          0.4, // radius
          0.94, // threshold — above base fog, below caustics/specular highlights
        ),
      );
    }

    // Last, so the vignette dims the bloom glow too, not just the base image.
    vignettePass = new VignetteOutputPass();
    next.addPass(vignettePass);
    return next;
  }

  // Bloom's targets are sized off actual pixel resolution, not world content.
  let composer = buildComposer(pixelBounds);

  // Resizes the renderer/camera and re-applies the fixed framing.
  function resize(pixelBounds, worldBounds) {
    // Re-read devicePixelRatio: a monitor change fires resize but leaves the old screen's ratio set otherwise.
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio),
    );
    renderer.setSize(pixelBounds.width, pixelBounds.height);
    camera.aspect = pixelBounds.width / pixelBounds.height;
    camera.fov = verticalFovForAspect(camera.aspect);
    // Clamped to 1, same landscape-untouched/portrait-only shape as verticalFovForAspect, applied to the vignette instead.
    vignettePass.uniforms.uAspect.value = Math.min(camera.aspect, 1);
    camera.far = Math.max(worldBounds.width, worldBounds.height) * 5;
    applyFraming(worldBounds);
    camera.updateProjectionMatrix();
    sky.scale.setScalar(camera.far * SKY_RADIUS_FRAC);
    skyUniforms.uFogDensity.value = fogDensity(worldBounds);
    skyUniforms.uFogDepthRate.value = fogDepthRate(worldBounds);
  }

  // The expensive half of a resize (rebuilding bloom's mip chain), split out to run on a debounce.
  function resizeComposer(pixelBounds) {
    // EffectComposer caches the renderer's pixel ratio at construction, so this has to be re-pushed on every change.
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(pixelBounds.width, pixelBounds.height);
  }

  resize(pixelBounds, worldBounds);
  resizeComposer(pixelBounds);

  // Manual reset so renderer.info accumulates across the composer's several passes, as the debug panel wants.
  renderer.info.autoReset = false;

  function render() {
    renderer.info.reset();
    composer.render();
  }

  // Sky sphere is centered on the camera every frame.
  function updateCamera() {
    sky.position.copy(camera.position);
  }

  // Blends the sky sphere toward the season's look; uFogColor needs no update since it points at the shared FOG_COLOR instance.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    skyUniforms.uSkyColor.value.copy(season.skyColor);
    skyUniforms.uHorizonColor.value.copy(season.horizonColor);
    skyUniforms.uWaterColor.value.copy(season.waterColor);
    skyUniforms.uDepthsColor.value.copy(season.depthsColor);
    skyUniforms.uSunColor.value.copy(season.sunColor);
    skyUniforms.uSunIntensity.value = season.sunIntensity;
    skyUniforms.uHorizonStrength.value = season.horizonStrength;
    // uSunDirection deliberately absent — pushed every frame by setSunDirection() since the sun also moves within the day.
  }

  // Called every frame with the same vector driving the caustics, so the sky disc and the bed's light net stay the same sun.
  function setSunDirection(direction) {
    skyUniforms.uSunDirection.value.copy(direction);
  }

  // Re-applies everything fixed at construction from QUALITY after the governor steps the tier down.
  function applyQuality(pixelBounds, worldBounds) {
    composer.dispose();
    composer = buildComposer(pixelBounds);

    // Both halves — reallocation is the point on a tier change.
    resize(pixelBounds, worldBounds);
    resizeComposer(pixelBounds);
  }

  return {
    renderer,
    scene,
    camera,
    cameraTarget,
    resize,
    resizeComposer,
    updateCamera,
    setSeason,
    setSunDirection,
    applyQuality,
    render,
  };
}
