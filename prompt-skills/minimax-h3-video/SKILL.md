---
name: minimax-h3-video
description: Write MiniMax H3 / H3 Max video prompts in MiniMax's own field format — T2VA, I2VA, FL2VA, L2VA and Ref2VA. Use when the user mentions MiniMax H3, H3 Max, Hailuo H3, integrated_multimodal_description, overall_soundscape, non_diegetic_music, subject_definitions, retention_analysis, reference-to-video, keyframe or first/last frame video, multi-shot timelines, speaker IDs, or asks for a prompt to paste into an H3 node.
---

# MiniMax H3 Prompt Writer

H3 does not take a sentence. It takes a **labelled field block** that describes a
whole audiovisual timeline — picture, action, camera, speech and sound together.
Source: MiniMax's own `h3-prompt-writing` skill (`MiniMax-AI/MiniMax-H3`),
`references/base-en.txt` and `references/ref-en.txt`.

**Your output is always that block and nothing else.** It is a single unit meant
to be pasted straight into the node's prompt field, so it carries no preamble, no
commentary, no markdown fences and no explanation. Reproduce the field names,
section order and punctuation exactly as written below — they are parsed, not
read. If you have something to say to the user, say it in your reply, never
inside the block.

## 1. Pick the mode from the pins that are wired

| Mode | Use when | Typical fal endpoint |
|---|---|---|
| **T2VA** | text only | `minimax/h3-max/text-to-video`, `…-turbo/text-to-video` |
| **I2VA** | a first frame | `minimax/h3-max/image-to-video` (`image_url`) |
| **FL2VA** | first **and** last frame | `…/image-to-video` (`image_url` + `end_image_url`) |
| **L2VA** | a last frame only | `…/image-to-video` (`end_image_url` alone) |
| **Ref2VA** | subject / motion / voice references | `minimax/h3-max/reference-to-video` |

`multi-angle/image-to-video` and `camera-controls` are I2VA bodies whose camera
move comes from the `camera_trajectory` parameter, not from the prompt. Describe
the subject and the action there and keep camera language minimal, or the two
will fight.

## 2. Reference labels — read this before writing a Ref2VA prompt

MiniMax's native format labels an image `<Picture 1>`. fal's `reference-to-video`
endpoint documents its own arrays differently: `reference_image_urls` says
"referenced in the prompt as **Image 1, Image 2**", and likewise **Video 1** and
**Audio 1**.

**Targeting a fal endpoint, use fal's names — `Image 1`, `Video 1`, `Audio 1` —
for anything that arrives through those arrays.** That is the naming fal states
its wrapper binds. Keep MiniMax's `<Subject N>` machinery for the subject
definitions themselves, since fal documents no equivalent. Say in your reply which
naming you used, so a mismatch is easy to spot and correct.

Order matters: `Image 1` is the first URL in `reference_image_urls`, and so on.
Never reference a label that has no corresponding wired input.

## 3. Base modes — T2VA / I2VA / FL2VA / L2VA

### Line one is the alignment instruction

T2VA has none — start directly at `integrated_multimodal_description`. The
others open with exactly one of these, then **one blank line**:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```
```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```
```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

(I2VA, FL2VA, L2VA in that order.) `N` is the real final shot index and `S.SS`
is the video duration to exactly two decimals.

### Then the three core fields, in this order

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

- **integrated_multimodal_description** — the body. Visuals, actions, shots,
  speakers, dialogue, and diegetic sound along the timeline.
- **overall_soundscape** — 1–4 sentences, one paragraph: ambience, physical
  action sound, non-verbal human sound. Not dialogue, singing or diegetic music —
  those live in the body. `N/A` only for deliberate total silence.
- **non_diegetic_music** — 1–3 sentences on score the characters cannot hear.
  Instrumentation, tempo, rhythm, dynamics. No mood words, no explaining what the
  music is "for". Music the characters *can* hear is diegetic and belongs in the
  body. `N/A` when there is none.

### Keyframe shapes

- **I2VA** — first-frame anchor → action onset → continuous development → result.
- **FL2VA** — first-frame state → intermediate change → narrowing difference →
  last-frame state. Prefer a single shot so the model can interpolate; the last
  frame must land at the end of the final shot.
- **L2VA** — plausible earlier state → transition path → convergence → landing on
  the image.

## 4. Syntax that is parsed, not prose

**Shots.** No timestamp on the first shot. Later shots open with a strictly
increasing cut time inside the duration:

```text
[Shot 2] At 00:03.500, the camera cuts to...
```

Cut verbs: `the camera cuts to`, `the shot cuts to`, `the shot transitions to`,
`the shot changes to`, `the shot switches to`. A cut must introduce new
information — new subject, space, state, viewpoint or time. If only the distance
or angle changes, move the camera instead of cutting.

**Camera motion** = type + amplitude + speed, written as an action inside the
sentence, never stacked as labels at the end. Omit amplitude/speed when medium
and normal.

| | |
|---|---|
| Type | `Zoom In/Out`, `Push In`, `Pull Out`, `Pan Left/Right`, `Truck Left/Right`, `Tilt Up/Down`, `Pedestal Up/Down`, `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly/Strongly`, `POV`, `Roll Clockwise/Counterclockwise` |
| Amplitude | `with small amplitude`, `with large amplitude` |
| Speed | `at slow speed`, `at fast speed` |

```text
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
```

**Style** goes at the start of `[Shot 1]`: `Cinematic`, `live-action`,
`2D-animated`, `3D CG`, `claymation`, `watercolor`, `vintage film`. For keyframe
modes derive it from the reference image.

**Speakers and dialogue.** Stable IDs `(S1)`, `(S2)`; `(S1,S2)` when they speak
together. An ID persists across shots; characters who never vocalise get none. On
first appearance establish identity — type, age, gender, on/off-screen, pitch,
timbre, rate, accent. Identity, action and delivery sit **outside** `<d>`; inside
`<d>` put only the language tag and the exact words, verbatim, untranslated.

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
```

Voiceover uses the exact phrase `says in an off-screen voiceover`, and must be
followed by a statement that the character's lips stay closed. Use
`<scenetrans>` at both sides of a line that crosses a cut, and `<cutoff>` when
speech is truncated by the end of the video.

**On-screen text** goes in double quotes, original language, verbatim:
`A red neon sign reading "营业中" glows above the doorway.`

## 5. Ref2VA — six sections, this order

```text
subject_definitions:
<Subject 1> is ...

summary:
[task type] ...

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - ...

detailed_description:
[Shot 1] ...

overall_soundscape:
...

non_diegetic_music:
...
```

**subject_definitions** — one line per tracked item, saying what the label
denotes, its role, and the features to follow. `<Subject N>` is reusable visible
content (person, animal, object, scene, clothing, prop, style, action, pose). One
subject may draw on several assets; one asset may yield several subjects. An
image used *only* to define a character or style gets no standalone entry — cite
it inside that subject's line.

**summary** — one paragraph opening with a bracketed task type, combined with
` + ` when several apply: `keyframe completion`, `reference generation`,
`video editing`, `video continuation`, `audio reuse`, `audio reference`. A
reference video that supplies only camera movement or rhythm is
`reference generation`, not `video editing`. Introduce no new labels here.

**retention_analysis** — one line per label. Fixed markers, spelled exactly:

| Visible content | Audio |
|---|---|
| `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference` | `fully_copy`, `partially_copy`, `reference`, `weak_reference` |

Stay inside the role already given in `subject_definitions`. New actions or
background in the target video are not losses of fidelity.

**detailed_description** — the body, in playback order, using the same shot and
dialogue syntax as the base modes. Make it explicit: composition, appearance and
position, environment and light, actions and state changes, camera, sound, and
the exact moment each reference takes effect. Do not let it collapse into a plot
summary or a list of reference relationships.

## 6. Duration and language

Match the described timeline to the requested length — H3 takes **4–15 seconds**,
and the fal endpoints default to 5. Every cut time must fall inside it. Write the
sections in English; keep dialogue, lyrics and visible on-screen text in their
original language. Prefer concrete visual and audible detail over words like
"cinematic" or "beautiful" used as adjectives of quality.

## 7. Worked example — I2VA

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass while the quiet, breathy young woman (S1) says: <d>[English] I get off at the next station.</d> She folds the letter along its existing crease.

overall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.

non_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.
```

## 8. Worked example — Ref2VA on fal (fal's reference naming)

Two reference images and one reference audio wired to `reference-to-video`:

```text
subject_definitions:
<Subject 1> is the young blonde woman in Image 1, with long blonde hair and a light-pink button-down shirt with rolled-up sleeves.
<Subject 2> is the coffee-shop interior in Image 2, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, and a wooden coffee table.
Audio 1 is the voice-timbre reference for <Subject 1> (S1), containing a spoken English vocal layer.

summary:
[reference generation + audio reference] The target video shows <Subject 1> sitting in <Subject 2> and reacting to something off-frame, using Audio 1 as the voice-timbre reference for her single line.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her identity, long blonde hair, and light-pink shirt are retained.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the exposed brick wall, orange tufted sofa, patterned pillows, and wooden coffee table are retained.
Audio 1: reference - its vocal timbre guides the delivery of <Subject 1> without copying the original signal.

detailed_description:
The target video uses a realistic multi-camera sitcom style with warm indoor lighting.
[Shot 1] A medium shot establishes <Subject 2>, the coffee shop with its exposed brick wall and orange tufted sofa. <Subject 1> (S1), the young woman with long blonde hair and a light-pink button-down shirt, sits on the sofa holding a chocolate-chip cookie and turns toward a sound off-frame left. The camera holds a static shot as her shoulders tense. [Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 1> (S1), who, using the clear youthful timbre referenced from Audio 1, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> She closes her lips and guards the cookie.

overall_soundscape:
Soft indoor coffee-shop room tone continues throughout, with a chair creak and the faint rustle of a paper napkin.

non_diegetic_music:
N/A
```

## 9. Workflow

1. **Read the wiring.** Which pins are connected decides the mode — do not ask
   for an image the graph already supplies, or invent one it does not.
2. **Fix the duration** before writing, since every cut time depends on it.
3. **Write the block**, then reread it against §4: shot numbering, cut times
   inside the duration, camera phrased as an action, `<d>` holding only the
   words, every label resolved.
4. **Report separately** — mode chosen, duration assumed, reference naming used,
   and any assumption you had to make. That goes in your reply, not in the block.

Ask at most three questions, and only where the answer changes the prompt. If the
brief is already actionable, write it and state your assumptions in one line.
