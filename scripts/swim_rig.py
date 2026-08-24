# swim_rig.py
# Regenerates the "Swimming" clip on steelhead-final.glb's 16-bone spine, as a
# phase-lagged travelling wave of per-bone yaw. Run inside Blender, then export
# the GLB to public/.
#
# The renderer bakes this clip into a Vertex Animation Texture at load
# (fishMesh.js -> bakeVertexAnimationTexture), sampling [firstKey, duration] as
# exactly one cycle. That relies on two things this script must keep true:
#   - the closing key (n_keys = FRAMES_PER_CYCLE + 1) makes frame 1 and frame
#     31 identical, so the loop closes; the baker samples the half-open range
#     and never emits the duplicate.
#   - the whole clip is one cycle. Don't author two beats here.
#
# ---- CONFIG ----
ARMATURE_NAME    = "Armature"
ROOT_BONE        = "Bone"     # head-end bone; the chain is walked from here
AXIS             = 0          # pose-bone local X. Verified against the export:
                              # every spine bone's animated quaternion is an
                              # X-axis rotation. (An earlier comment here said
                              # local Z -- that was wrong.)
FRAMES_PER_CYCLE = 30         # matches VAT_FRAME_COUNT in fishMesh.js
MAX_ANGLE_HEAD   = 0.5        # PER-BONE degrees at the head
MAX_ANGLE_TAIL   = 11.0       # PER-BONE degrees at the tail -- these COMPOUND
FALLOFF          = 2.0        # 2.4 chinook, 2.0 steelhead, 1.5 shad
PHASE_SPAN       = 340        # degrees of lag head -> tail; 360/PHASE_SPAN is
                              # the body wavelength in body lengths. 340 -> 1.06 L,
                              # inside the 0.9-1.2 L measured for subcarangiform
                              # swimmers (trout/salmon undulate the back half,
                              # not the whole body like an eel).
HEAD_RECOIL      = 0.5        # degrees, antiphase to the tail
CLIP_NAME        = "Swimming"
#
# These constants were tuned against a forward-kinematics sim of this rig
# (16 x 0.2928 segments, 4.758-unit body) to land on measured steelhead
# kinematics at steady cruise:
#
#            tail beat   body foreshortening   snout yaw
#   target     0.20 L          2-4%             0.03-0.05 L
#   this rig   0.200 L         2.2%             0.052 L
#
# 0.20 L peak-to-peak is Bainbridge (1958) -- tail-beat amplitude is close to
# constant across swimming speed for most fish, so this does not need to scale
# with the boid's velocity. fishMesh.js varies only the RATE per fish (see
# STRIDE_LENGTH) plus a narrow +/-15% amplitude jitter (boids.js swimAmplitude),
# and aAmplitude 1.0 is defined to reproduce this clip exactly -- so whatever
# is authored here is what shows up on screen.

import bpy
import math

print("Blender", bpy.app.version_string)
arm = bpy.data.objects[ARMATURE_NAME]

# --- derive the spine chain head -> tail, so order can't disagree with the rig.
#
# This list MUST start empty. It previously held a hardcoded copy of the same
# 16 bone names and the walk below appended to it, giving a 32-entry chain: every
# bone was keyed twice per frame, and since the second keyframe_insert at a given
# frame overwrites the first, the walked copy won -- at t = (16+i)/31 instead of
# i/15. That squeezed every bone into the top half of the falloff curve (the head
# bone got 2.25 deg instead of 0.5) and, because `is_head` was only True for
# index 0 in the hardcoded half, silently discarded HEAD_RECOIL entirely.
#
# The visible result was a fish pivoting about its nose rather than undulating:
# 0.86 L of tail sweep against the 0.20 L a real steelhead uses, with the body
# telescoping 15.6% shorter at peak bend.
chain = []
b = arm.pose.bones[ROOT_BONE]
while b:
    chain.append(b.name)
    kids = list(b.children)
    if len(kids) > 1:
        print("branch at", b.name, "- stopping spine walk here")
    b = kids[0] if len(kids) == 1 else None
print("chain (head -> tail):", chain)

# --- clear any previous run so we don't pile up Swimming.001, .002, ...
arm.animation_data_create()
arm.animation_data.action = None
old = bpy.data.actions.get(CLIP_NAME)
if old:
    bpy.data.actions.remove(old)

# --- zero the chain so no stale pose bakes in
for name in chain:
    pb = arm.pose.bones[name]
    pb.rotation_mode = 'XYZ'
    pb.rotation_euler = (0.0, 0.0, 0.0)

# --- precompute per-bone amplitude and phase
n = len(chain)
plan = []
for i, name in enumerate(chain):
    t     = i / (n - 1) if n > 1 else 0.0
    amp   = math.radians(MAX_ANGLE_HEAD +
                         (MAX_ANGLE_TAIL - MAX_ANGLE_HEAD) * t ** FALLOFF)
    phase = -math.radians(PHASE_SPAN * t)   # NEGATIVE: wave runs head -> tail
    plan.append((arm.pose.bones[name], amp, phase, i == 0))

# --- new keys default to LINEAR (version-stable; no .interpolation poking)
prefs = bpy.context.preferences.edit
prev_interp = prefs.keyframe_new_interpolation_type
prefs.keyframe_new_interpolation_type = 'LINEAR'

n_keys = FRAMES_PER_CYCLE + 1        # closing key -> seamless loop
w      = 2 * math.pi / FRAMES_PER_CYCLE
recoil = math.radians(HEAD_RECOIL)
span   = math.radians(PHASE_SPAN)

try:
    for f in range(n_keys):
        frame = f + 1
        for pb, amp, phase, is_head in plan:
            a = amp * math.sin(w * f + phase)
            if is_head:
                a += recoil * math.sin(w * f - span + math.pi)
            pb.rotation_euler[AXIS] = a
            pb.keyframe_insert(data_path="rotation_euler", index=AXIS, frame=frame)
finally:
    prefs.keyframe_new_interpolation_type = prev_interp

arm.animation_data.action.name = CLIP_NAME
bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end   = FRAMES_PER_CYCLE + 1

print(f"'{CLIP_NAME}': {n_keys} keys, {FRAMES_PER_CYCLE}-frame cycle, {n} bones")
if n != 16:
    print(f"  WARNING: expected 16 spine bones, walked {n} -- check the chain above")
