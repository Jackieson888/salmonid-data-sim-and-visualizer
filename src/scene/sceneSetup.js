// sceneSetup.js
// Renderer, camera, and resize handling for the 3D river scene.
//
// The camera is FIXED — a single world-anchored vantage inside the water
// column, angled up-and-across so the school's flow sweeps through the
// frame left-to-right with the surface overhead and the caustic-lit
// riverbed below. It is deliberately not user-controllable: this scene only
// holds together as an underwater shot from a viewpoint that stays in the
// water and stays pointed roughly along the run. OrbitControls used to own
// the camera here, which let the viewer drift above the surface or below
// the riverbed, where the whole depth-based color model (the path-length
// murk in the sky shader below, fishMesh.js's depth fog) reads as broken.
// Everything about the framing is now a constant in this file.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FOG_COLOR, fogDensity } from "./fog.js";
import { seasonForDay } from "./season.js";
import { glslFloat } from "./glsl.js";

// Sun disc/glow tuning for the sky shader below. The tight exponent is the
// disc itself, the loose one the halo bleeding off it; both are fed by the
// season's sunIntensity so a low winter sun reads dimmer than a high summer
// one. Strengths are set so the disc core clears UnrealBloomPass's 0.94
// threshold (see composer below) and actually blooms, while the halo stays
// under it and just tints the sky.
const SUN_DISC_EXPONENT = 350;
const SUN_DISC_STRENGTH = 1.2;
const SUN_HALO_EXPONENT = 6;
const SUN_HALO_STRENGTH = 0.12;

// Scales down the fog density used for the sky sphere's own murk path (see
// its fragment shader). At the true density the water is turbid enough that
// Snell's window collapses to a pinhole straight overhead and the seasonal
// sky never shows at all — which is honest, and unwatchable. This widens the
// window until the sky reads across the top of frame. Purely an artistic
// control; it is the one place in this file that isn't trying to be
// physical.
const SKY_FOG_SCALE = 0.45;

// Below this much upward tilt, a view ray is treated as never reaching the
// surface at all (pure murk). Also keeps the 1/dir.y path-length division
// below away from zero.
const MIN_UPWARD_COMPONENT = 0.001;

const FOV = 90;
const NEAR = 1;

// Sky sphere scale, as a fraction of camera.far — kept comfortably inside
// the far plane so it never gets clipped as bounds/camera.far change on resize.
const SKY_RADIUS_FRAC = 0.9;

// The camera framing, expressed as fractions of the world bounds.
// worldX = fish.x (downstream), worldZ = fish.y (across-river), worldY is
// up (0 = water surface, negative = underwater toward the riverbed).
// Values were picked by eye using the D-key debug readout (see main.js) at
// a 1498x1308 viewport, then expressed as fractions of bounds so the same
// framing holds proportionally at other window sizes.
//
// Unlike when OrbitControls owned the camera, resize() now re-applies these
// every time: with no user drag state to preserve, the framing should stay
// proportionally identical at every window size rather than being frozen at
// whatever the startup dimensions happened to be.
//
// Two constraints these have to keep satisfying:
//
// EYE_FRAC.y must stay comfortably negative (underwater) and above the
// riverbed at -RIVER_DEPTH_FRAC (see terrain.js) — the sky shader's murk
// path length is measured from the surface down to the camera, so an eye
// above y=0 inverts it.
//
// EYE_FRAC.x must stay BELOW 1.0. Fish are flagged for removal once they
// cross exitX = bounds.width + 40 (see boids.js) and then spend
// REMOVE_FADE_FRAMES fading out while still swimming downstream. The eye
// used to sit at 1.0501, i.e. *downstream* of that line, so fish began
// dissolving before they ever reached the camera and the removal played out
// in full view in the foreground. Keeping the eye upstream of exitX puts
// the entire fade behind the camera: fish sweep past and vanish unseen.
// Anything under 1.0 holds at every window size, since exitX is
// bounds.width plus a constant while this is a fraction of bounds.width.
//
// These were dollied in from {1.0501, -0.2362, 0.9289} along the eye->target
// axis (all three scaled by the same 0.84 about TARGET_FRAC) rather than
// just pulling x back, so the viewing angle is identical and only the
// distance changed.
const EYE_FRAC = { x: 0.876, y: -0.2072, z: 0.7924 };
const TARGET_FRAC = { x: -0.0381, y: -0.055, z: 0.0757 };

export function createSceneSetup(canvas, bounds) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // ACES filmic tone mapping — every material in this scene is a hand-
  // written ShaderMaterial (no MeshStandardMaterial/etc.), and
  // renderer.toneMapping only has an effect on materials whose shader
  // includes the <tonemapping_fragment>/<colorspace_fragment> chunks, which
  // ShaderMaterial never does automatically. Rather than hand-add that chunk
  // to every custom fragment shader in the scene, OutputPass below applies
  // it once, globally, as the last step of the composer chain (see
  // composer below). Every color in this scene was hand-picked against a
  // plain clamp-and-gamma-correct pipeline (no tone mapping at all) — ACES's
  // curve lifts shadows/midtones noticeably relative to that, which read as
  // a wash of the whole moody/dark look this scene relies on rather than
  // just fixing flat contrast. Exposure well under 1.0 compensates; still
  // tuned by eye, not derived.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;

  // No scene.fog here, deliberately. THREE only applies it inside materials
  // that pull in its fog shader chunks, and every material in this scene is a
  // hand-written ShaderMaterial — which defaults to fog: false and would need
  // those chunks added by hand anyway. A THREE.FogExp2 used to sit here and
  // affected nothing; all the fog you can actually see comes from FOG_GLSL's
  // applyFog(), called explicitly by terrain.js/water.js/fishMesh.js (see
  // fog.js).
  const scene = new THREE.Scene();

  // Every one of these is overwritten by the first setSeason() call — the
  // starting values only exist so the material compiles with something in
  // it. See season.js for where the real palette comes from.
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
    uFogDensity: { value: fogDensity(bounds) },
  };

  // Background is a sky sphere rather than a flat scene.background color, so
  // it can gradient by world Y (0 = water surface, matching depthRange/
  // terrain elsewhere). It's re-centered on the camera every frame (see
  // updateCamera) but never rotated, so its local-space position doubles as
  // world-space view direction with no extra transform needed.
  //
  // The camera lives in the water column (see EYE_FRAC above), so this
  // sphere is not really "sky" — it's what an underwater viewer sees at
  // infinite distance in each direction, which is almost entirely murk. The
  // seasonal sky only survives in the cone steep enough to exit the surface
  // before the water swallows it (Snell's window). See the path-length fog
  // in the fragment shader: that is what stops the background from being a
  // crisp sky pasted behind geometry that has itself already faded to fog,
  // which is what made the far surface/terrain junction read as a hard,
  // wrongly-colored band across the frame.
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
        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uWaterColor;
        uniform vec3 uDepthsColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uSunIntensity;
        uniform float uHorizonStrength;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vPosition;

        void main() {
          vec3 dir = normalize(vPosition);

          // The warm red/orange/pink the sky takes on where sunlight travels
          // the longest path through atmosphere and the short wavelengths
          // have scattered out. uHorizonStrength scales it by how low the
          // season's sun sits (see season.js) — strongest in winter/autumn,
          // still faintly present at the summer solstice.
          vec3 horizonTone = mix(uSkyColor, uHorizonColor, uHorizonStrength);

          // Above the waterline: horizonTone climbing to the season's full
          // sky color at the zenith. Refraction at the surface squeezes the
          // entire 180-degree sky into a ~97-degree cone for an underwater
          // viewer, so the true horizon — and the warm band with it — lands
          // well up from dir.y = 0 rather than at it. Without that
          // compression the warm tones would sit exactly where the murk
          // below is total and would never be visible at all.
          float up = clamp(dir.y, 0.0, 1.0);
          vec3 above = mix(horizonTone, uSkyColor, smoothstep(0.15, 0.8, up));

          // Sun disc + halo, faded out through the waterline so it doesn't
          // also appear mirrored below the horizon.
          float sunDot = max(dot(dir, uSunDirection), 0.0);
          float sun = pow(sunDot, ${glslFloat(SUN_DISC_EXPONENT)}) * ${glslFloat(SUN_DISC_STRENGTH)}
            + pow(sunDot, ${glslFloat(SUN_HALO_EXPONENT)}) * ${glslFloat(SUN_HALO_STRENGTH)};
          above += uSunColor * sun * uSunIntensity
            * smoothstep(0.0, 0.06, dir.y);

          // Below the waterline there is no sky to see at all, only the
          // water column falling away — so this half is the body color
          // sinking into the depths, and the murk below will bury nearly
          // all of it anyway.
          float down = clamp(-dir.y, 0.0, 1.0);
          vec3 below = mix(uWaterColor, uDepthsColor, smoothstep(0.0, 0.45, down));

          vec3 color = mix(below, above, smoothstep(-0.02, 0.02, dir.y));

          // How much water this ray has to cross before it escapes. Only
          // rays angled up out of the surface (y = 0) ever escape at all,
          // over a path of cameraDepth/dir.y — steeply up is a short path
          // and near-level is an enormous one. Everything level or downward
          // never exits, so it is pure murk.
          //
          // This is the whole point of the sphere being fogged: geometry in
          // front of it already fades to uFogColor with distance, and the
          // background sits at effectively infinite distance, so it has to
          // fade at least as far or it shows through as a bright hole
          // wherever the two meet.
          float cameraDepth = max(-cameraPosition.y, 0.0);
          float murk = 1.0;
          if (dir.y > ${glslFloat(MIN_UPWARD_COMPONENT)}) {
            float pathLength = cameraDepth / dir.y;
            float d = uFogDensity * ${glslFloat(SKY_FOG_SCALE)} * pathLength;
            murk = 1.0 - exp(-d * d);
          }

          gl_FragColor = vec4(mix(color, uFogColor, clamp(murk, 0.0, 1.0)), 1.0);
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

  // No THREE lights are added to this scene, deliberately. Every material
  // here is a hand-written ShaderMaterial and none of them declares
  // `lights: true` or includes THREE's lighting chunks, so scene lights are
  // never read by anything — a DirectionalLight/AmbientLight/HemisphereLight
  // trio used to sit here and contributed nothing to a single pixel. The
  // season's sun color/direction/intensity reach the shaders that want them
  // as uniforms instead (see the sky material above, terrain.js's sunDir,
  // causticsGenerator.js).

  // Where the fixed camera looks. Kept around (rather than being a local in
  // applyFraming) because the debug readout in main.js reports
  // distance-to-target, and because resize() has to re-aim the camera after
  // moving it.
  const cameraTarget = new THREE.Vector3();

  // Places the camera at EYE_FRAC looking at TARGET_FRAC, both scaled to
  // the given bounds. Called from resize(), which runs once at startup too.
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

  // Post-processing chain: render the scene normally (RenderPass) into an
  // offscreen linear buffer, extract+blur its bright regions and add them
  // back (UnrealBloomPass — makes the caustics/specular highlights actually
  // glow instead of just being bright pixels), then apply the tone-mapping
  // curve set above and convert to the display color space as the final
  // step (OutputPass — see its own docs: "should be included at the end of
  // each pass chain"). Bloom's threshold/strength/radius are tuned by eye
  // against this scene's caustics highlights, not physically derived.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(bounds.width, bounds.height),
    0.4, // strength
    0.4, // radius
    0.94, // threshold — just above the fog/base-color range so those don't bloom, below the caustics/specular highlights so those do
  );
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Resizes the renderer/camera to the new viewport and re-applies the fixed
  // framing at the new bounds. Re-framing here is safe now that the camera
  // is static: there is no user drag/zoom state left for it to stomp on, and
  // since the framing is defined as fractions of bounds, not re-applying it
  // would leave the shot subtly mis-composed after any window change.
  function resize(b) {
    renderer.setSize(b.width, b.height);
    camera.aspect = b.width / b.height;
    camera.far = Math.max(b.width, b.height) * 5;
    applyFraming(b);
    camera.updateProjectionMatrix();
    sky.scale.setScalar(camera.far * SKY_RADIUS_FRAC);
    // The sky's murk path length is in world units, so its density has to
    // track bounds the same way every other surface's fog does (see fog.js).
    skyUniforms.uFogDensity.value = fogDensity(b);
    // Resizes the composer's own buffers AND calls setSize() on every pass,
    // which is what re-allocates UnrealBloomPass's mip chain. (Assigning
    // bloomPass.resolution here as well used to look like the line doing
    // that, but the pass only reads `resolution` in its constructor.)
    composer.setSize(b.width, b.height);
  }

  resize(bounds);

  // Replaces a direct renderer.render(scene, camera) call — see composer
  // above for why the bloom/tone-mapping chain needs to run instead.
  function render() {
    composer.render();
  }

  // The camera itself never moves outside of resize() now, but the sky
  // sphere is centered on the camera rather than the origin so its
  // local-space position can double as a world-space view direction (see
  // the material above), which still has to be maintained each frame.
  function updateCamera() {
    sky.position.copy(camera.position);
  }

  // Blends the sky sphere toward the given day-of-year's seasonal look (see
  // season.js) — the visible stand-in for a year passing as the timeline
  // advances. Every uniform value is mutated in place rather than
  // reassigned, since the sky material already holds a reference to these
  // exact Color/Vector3 objects.
  //
  // The sky's own uFogColor needs no update here: it points at the shared
  // FOG_COLOR instance that setFogSeason() mutates in place (see fog.js).
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    skyUniforms.uSkyColor.value.copy(season.skyColor);
    skyUniforms.uHorizonColor.value.copy(season.horizonColor);
    skyUniforms.uWaterColor.value.copy(season.waterColor);
    skyUniforms.uDepthsColor.value.copy(season.depthsColor);
    skyUniforms.uSunColor.value.copy(season.sunColor);
    skyUniforms.uSunDirection.value.copy(season.sunDirection);
    skyUniforms.uSunIntensity.value = season.sunIntensity;
    skyUniforms.uHorizonStrength.value = season.horizonStrength;
  }

  return {
    renderer,
    scene,
    camera,
    cameraTarget,
    resize,
    updateCamera,
    setSeason,
    render,
  };
}
