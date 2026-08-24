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
import { FOG_COLOR, FOG_GLSL, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { glslFloat } from "./glsl.js";
import { QUALITY } from "../quality.js";

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
//
// It does have a lower bound, though, and 0.45 was under it. The water
// surface plane (water.js) is finite, so rays angled only slightly up pass
// over its far edge and hit this sphere directly, while steeper rays go
// through the plane — which is fully fog-saturated at that distance. Widen
// the window too far and the sky under the plane's edge angle stays visibly
// warmer and lighter than the fogged plane just above it, and the edge shows
// up as a horizontal seam straight across the frame. Most obvious in autumn,
// where the horizon band is at its most golden and least like the water.
// 0.62 murks that shallow-angle band to match without closing the window
// overhead, where the seasonal sky still needs to read.
const SKY_FOG_SCALE = 0.62;

// Below this much upward tilt, a view ray is treated as never reaching the
// surface at all (pure murk). Also keeps the 1/dir.y path-length division
// below away from zero.
const MIN_UPWARD_COMPONENT = 0.001;

// ---------------------------------------------------------------------
// Vignette + grain (see VIGNETTE_SHADER below)
// ---------------------------------------------------------------------
// Deliberately asymmetric. A symmetric vignette would close down the top of
// frame, which is where Snell's window sits (see water.js) — the brightest
// and most legible thing in the shot, and the last thing that should be
// dimmed. So the effect is nearly absent up there and does its work along
// the bottom, where the frame has to meet the dark UI panel; without it the
// render ends on a visible tonal step against the panel's top edge.
//
// These are fractions of LINEAR light, applied before the tone-mapping
// curve and the sRGB encode (see the pass's position in the chain below),
// and that encode roughly halves them on the way to the screen: 0.16 here
// is about an 8% difference to the eye, not 16%. Tuning them as if they
// were display-space percentages is how this ended up invisible the first
// time.
const VIGNETTE_TOP = 0.25;
const VIGNETTE_BOTTOM = 1.1;

// Broad darkening across the whole bottom edge, on top of the radial falloff
// above — the corners alone don't sell the transition into the panel, since
// the panel spans the full width of the frame.
//
// The fade has to reach well up the frame rather than hugging the very
// bottom: the panel covers the bottom ~19% of the canvas, so anything
// tucked below that is spent behind it and never seen.
const VIGNETTE_BOTTOM_EDGE = 0.35;
const VIGNETTE_BOTTOM_FADE = 0.5;

// Where the radial falloff starts and where it reaches full strength, as a
// distance in uv space from the center of frame (the corners are at 0.707).
// Wide enough that the sides get some of it — with a later start the whole
// effect collapses into four corners, two of which the panel hides.
const VIGNETTE_START = 0.2;
const VIGNETTE_END = 0.78;

// Fine per-pixel grain, applied as a proportional wobble rather than an
// additive one so it stays even across the frame instead of swamping the
// darks. It reads as film, but it is also load-bearing: this scene is now
// mostly very smooth, very dark gradients (the depth ramp in fog.js, the
// murk behind it), which is exactly what bands visibly once it is quantized
// to 8 bits on the way out. A little noise before that dithers the banding
// away.
const GRAIN_AMOUNT = 0.03;

const FOV = 90;
const NEAR = 1;

// The vignette/grain used to be its own full-screen ShaderPass sitting
// between the bloom and OutputPass. It is now folded INTO OutputPass instead
// (see VignetteOutputPass below), which removes one full-screen read+write
// from every frame at every tier while changing nothing about the result:
// the effect still lands in linear space with the tone-mapping curve applied
// on top of it, because that is exactly where in OutputPass's shader it is
// spliced. A lens effect belongs before the sensor response, not after it.
//
// This is the GLSL that gets spliced in. It reads `texel`, which the line it
// replaces has just sampled, and leaves the result back in `texel` for the
// tone-mapping ladder below it to consume.
const VIGNETTE_GLSL = /* glsl */ `
  {
    // vUv.y is 0 at the bottom of the frame, so this ramps the radial
    // falloff from its full strength along the bottom to almost nothing
    // at the top.
    float radial = smoothstep(
      ${glslFloat(VIGNETTE_START)},
      ${glslFloat(VIGNETTE_END)},
      length(vUv - 0.5)
    );
    float strength = mix(uBottomStrength, uTopStrength, vUv.y);
    float bottom = uBottomEdge
      * (1.0 - smoothstep(0.0, ${glslFloat(VIGNETTE_BOTTOM_FADE)}, vUv.y));

    texel.rgb *= 1.0 - clamp(radial * strength + bottom, 0.0, 1.0);

    // The same one-liner terrain.js hashes silt with. Proportional, and
    // centered on 1.0 so it darkens as often as it brightens and the overall
    // exposure doesn't move.
    float grain = fract(
      sin(dot(gl_FragCoord.xy + uFrame, vec2(127.1, 311.7))) * 43758.5453123
    );
    texel.rgb *= 1.0 + (grain - 0.5) * uGrain;
  }
`;

// OutputPass with the vignette/grain spliced in ahead of its tone-mapping
// ladder.
//
// Subclassed rather than reimplemented so that OutputPass keeps owning the
// fiddly part: it rebuilds the shader's defines from renderer.toneMapping and
// renderer.outputColorSpace on every render, and getting that ladder wrong
// silently produces a differently-graded image rather than an error. All this
// does is replace the one line that samples the input texture with the same
// sample plus the vignette.
//
// The splice is asserted at construction. If a future three.js reformats that
// line, this throws at boot with a clear message instead of quietly dropping
// the vignette and leaving someone to notice the corners got brighter.
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

    // `this.uniforms` is the same object OutputPass handed to its material, so
    // adding to it here reaches the material too. Done before the first
    // render, i.e. before the shader is ever compiled.
    Object.assign(this.uniforms, {
      uTopStrength: { value: VIGNETTE_TOP },
      uBottomStrength: { value: VIGNETTE_BOTTOM },
      uBottomEdge: { value: VIGNETTE_BOTTOM_EDGE },
      uGrain: { value: GRAIN_AMOUNT },
      // Bumped every frame (see render below) purely to decorrelate the grain
      // between frames — a fixed pattern reads as dirt on the lens rather
      // than as grain, and dithers nothing once the eye averages it out.
      uFrame: { value: 0 },
    });

    this.material.fragmentShader = source.replace(
      SAMPLE_LINE,
      `vec4 texel = texture2D( tDiffuse, vUv );
       ${VIGNETTE_GLSL}
       gl_FragColor = texel;`,
    );

    // RawShaderMaterial (which OutputPass uses) declares every uniform by
    // hand, so the new ones need declaring too.
    this.material.fragmentShader = this.material.fragmentShader.replace(
      "uniform sampler2D tDiffuse;",
      `uniform sampler2D tDiffuse;
       uniform float uTopStrength;
       uniform float uBottomStrength;
       uniform float uBottomEdge;
       uniform float uGrain;
       uniform float uFrame;`,
    );
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // Wrapped rather than left to climb: this page runs unattended for as
    // long as it is open, and the hash it feeds is a sin() of a dot product,
    // which stops returning anything decorrelated once the input gets large
    // enough to eat the float's mantissa. The grain would quietly freeze
    // into a fixed pattern after a long enough session. A period this long
    // is not visible as a repeat.
    this.uniforms.uFrame.value = (this.uniforms.uFrame.value + 1) % 1024;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}

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
// The shot is BROADSIDE to the run, not down it. The camera sits just inside
// the near bank (EYE_FRAC.z is about 1.0, i.e. the far edge of the channel's
// width) and looks across and slightly upstream, so the flow crosses the frame
// left to right with only a modest component swimming toward the lens.
//
// That framing is the one that answers the question the piece is actually
// about — how many fish are moving through this stretch of river. Aimed down
// the run, the school arrives head-on: fish overlap along the view axis, near
// ones hide far ones, and a busy day and a quiet one look much the same.
// Broadside, the same fish spread across the frame and the count reads
// directly. Measured against the flow direction (+x), the split is:
//
//        screen-right   toward lens
//   down-the-run   0.44        0.89     <- what this used to be
//   broadside      0.89        0.45     <- what it is now
//
// The residual 0.45 toward the lens is deliberate rather than a pure side-on
// view: it keeps fish growing as they cross, which reads as depth, and it
// keeps the bodies at a three-quarter angle instead of showing every fish as a
// flat silhouette.
//
// Constraints these have to keep satisfying:
//
// EYE_FRAC.y must stay comfortably negative (underwater) and above the
// riverbed at -RIVER_DEPTH_FRAC (see terrain.js) — the sky shader's murk
// path length is measured from the surface down to the camera, so an eye
// above y=0 inverts it.
//
// EYE_FRAC.x must stay BELOW 1.0. Fish are flagged for removal once they
// cross exitX = bounds.width + 40 (see boids.js) and then spend
// REMOVE_FADE_FRAMES fading out while still swimming downstream, and that
// dissolve should not play out in shot. Broadside this is less delicate than
// it was head-on — the exit line is off the right-hand edge, and anything on
// the far side of the channel that could still catch it is beyond the fish
// distance cull (see fishMesh.js) and already faded — but keeping the eye
// upstream of exitX is what makes it true at every window size.
const EYE_FRAC = { x: 0.648, y: -0.2, z: 0.853 };
const TARGET_FRAC = { x: 0.4, y: -0.075, z: 0.22 };

export function createSceneSetup(canvas, bounds) {
  // `antialias` is deliberately OFF, and it is not a quality compromise.
  //
  // MSAA applies to the default framebuffer only. Everything in this scene is
  // drawn through EffectComposer, whose internal render targets are created
  // without a `samples` key (i.e. samples: 0) — so the scene is never
  // multisampled no matter what this flag says. The only thing that ever
  // reaches the default framebuffer is the final OutputPass fullscreen quad,
  // which has no geometry edges to antialias. Leaving it on allocated and
  // resolved a multisampled backbuffer every frame to smooth the edges of a
  // rectangle that exactly covers the screen.
  //
  // `depth`/`stencil` off for the same reason: the composer's targets carry
  // their own depth buffer, and nothing depth-tests against the default
  // framebuffer. `powerPreference` asks a dual-GPU laptop for the discrete
  // part rather than the integrated one.
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
    uFogDepthRate: { value: fogDepthRate(bounds) },
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
  // Deliberately NOT scaled by tier, having been tried that way and reverted.
  // This is one draw of ~500 triangles with no per-vertex work, i.e. nothing
  // measurable on any device — but the sphere is drawn from the inside and
  // fills the entire frame, so coarsening it does not read as a slightly
  // coarser background: the fragment shader's gradient is evaluated from the
  // interpolated position, and at 16x8 the interpolation error across those
  // very large triangles turns the whole backdrop into visible angular gores.
  // A knob that costs the frame nothing and the image everything.
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

          // Which shade of murk, not just how much of it: the fog darkens
          // with depth (see fog.js), and the background has to carry that
          // ramp or it undoes it. Everything level-or-downward here is
          // fully saturated murk, so a flat uFogColor paints the entire
          // lower half of frame one constant tone — a hard ceiling on how
          // deep the scene can look, however dark the geometry in front of
          // it gets.
          //
          // A background ray has no surface to take a depth from, so it
          // takes one from where the murk closes over it: roughly one fog
          // length (1 / uFogDensity) along its own direction. Rays angled
          // down sample deep, dark water and level ones sample the camera's
          // own depth, which is the vertical gradient the eye reads.
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
  // Bloom is the most expensive thing in the chain by a wide margin:
  // UnrealBloomPass allocates a bright-pass target plus five horizontal and
  // five vertical blur targets, and runs separable kernels of 6/10/14/18/22
  // taps across them — roughly thirteen additional full-screen passes. Hence
  // the three-way tier switch rather than an on/off:
  //
  //   full — the resolution the scene was authored against.
  //   half — every internal target is quarter-area. Bloom is a low-frequency
  //          effect by construction (its whole job is a wide blur), so the
  //          result is very close to `full` at a quarter of the fill cost.
  //   off  — the pass is not constructed at all. The highlights stop glowing
  //          and read as merely bright, which is a real loss, but it is the
  //          right thing to give up first on a device that cannot hold frame
  //          rate.
  // Built as a function rather than inline because a tier change has to
  // rebuild it: whether the bloom pass exists at all, and the resolution its
  // mip chain is allocated at, are both fixed at construction.
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
          0.94, // threshold — just above the fog/base-color range so those don't bloom, below the caustics/specular highlights so those do
        ),
      );
    }

    // Last, and carrying the vignette with it — so the vignette dims the
    // bloom's glow along with everything else rather than leaving bright
    // halos floating in the darkened corners.
    next.addPass(new VignetteOutputPass());
    return next;
  }

  let composer = buildComposer(bounds);

  // Resizes the renderer/camera to the new viewport and re-applies the fixed
  // framing at the new bounds. Re-framing here is safe now that the camera
  // is static: there is no user drag/zoom state left for it to stomp on, and
  // since the framing is defined as fractions of bounds, not re-applying it
  // would leave the shot subtly mis-composed after any window change.
  function resize(b) {
    // Re-read devicePixelRatio here, not just at startup: dragging the window
    // to a monitor with a different DPI fires resize but leaves a pixel ratio
    // set for the old screen, which renders soft (or needlessly large).
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio),
    );
    renderer.setSize(b.width, b.height);
    camera.aspect = b.width / b.height;
    camera.far = Math.max(b.width, b.height) * 5;
    applyFraming(b);
    camera.updateProjectionMatrix();
    sky.scale.setScalar(camera.far * SKY_RADIUS_FRAC);
    // The sky's murk path length is in world units, so its density has to
    // track bounds the same way every other surface's fog does (see fog.js).
    skyUniforms.uFogDensity.value = fogDensity(b);
    // Same for the depth ramp: it is keyed to the depth of the water column,
    // which is a fraction of bounds.height (see fog.js).
    skyUniforms.uFogDepthRate.value = fogDepthRate(b);
    // EffectComposer caches the renderer's pixel ratio in its CONSTRUCTOR and
    // multiplies setSize() by that cached value — so without this line its
    // targets stay at whatever DPI the page booted at, and the comment above
    // about tracking a monitor change would be true of the renderer but not
    // of the buffers actually being drawn into. It also matters on a tier
    // change, which is precisely a deliberate pixel-ratio change.
    composer.setPixelRatio(renderer.getPixelRatio());
    // Resizes the composer's own buffers AND calls setSize() on every pass,
    // which is what re-allocates UnrealBloomPass's mip chain. (Assigning
    // bloomPass.resolution here as well used to look like the line doing
    // that, but the pass only reads `resolution` in its constructor.)
    composer.setSize(b.width, b.height);
  }

  resize(bounds);

  // Replaces a direct renderer.render(scene, camera) call — see composer
  // above for why the bloom/tone-mapping chain needs to run instead.
  // renderer.info normally resets itself on every renderer.render() call, and
  // a composer chain makes several of those per frame — so by the time anything
  // could read it, it holds only the final fullscreen quad (1 draw, 1 triangle)
  // rather than the frame. Taking manual control and resetting once here makes
  // it accumulate across every pass, which is what the debug panel wants.
  renderer.info.autoReset = false;

  // The grain's per-frame counter lives in VignetteOutputPass.render() now,
  // so this is just the composer call.
  function render() {
    renderer.info.reset();
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
    skyUniforms.uSunIntensity.value = season.sunIntensity;
    skyUniforms.uHorizonStrength.value = season.horizonStrength;
    // uSunDirection is deliberately absent: the sun moves within the day as
    // well as across the year, so it is pushed every frame by
    // setSunDirection() instead. Setting it here too would snap the disc back
    // to the season's noon position on every day boundary.
  }

  // The season's sun, swept along its daily arc (see sweptSunDirection in
  // season.js). Called every frame from main.js's loop, with the same vector
  // that drives the caustics — so the disc in the sky and the light net on
  // the bed are always the same sun.
  function setSunDirection(direction) {
    skyUniforms.uSunDirection.value.copy(direction);
  }

  // Re-applies everything in this file that is fixed at construction time from
  // QUALITY, after the governor has stepped the tier down (see quality.js).
  // main.js pairs this with a full world rebuild — between them, every
  // tier-dependent resource in the scene is replaced.
  //
  // The composer is disposed and rebuilt rather than adjusted because the
  // things that change — whether UnrealBloomPass is in the chain at all, and
  // the resolution its eleven internal targets are allocated at — are only
  // read in constructors.
  function applyQuality(b) {
    composer.dispose();
    composer = buildComposer(b);

    // Picks up the new pixel ratio, re-sizes the fresh composer, and re-scales
    // the sky to the current far plane.
    resize(b);
  }

  return {
    renderer,
    scene,
    camera,
    cameraTarget,
    resize,
    updateCamera,
    setSeason,
    setSunDirection,
    applyQuality,
    render,
  };
}
