---
name: kling-v3-4k-i2v
description: Write and rewrite prompts for Kling Video V3 4K image-to-video (fal-ai/kling-video/v3/4k/image-to-video). Use when the user mentions Kling v3, Kling 4K, image-to-video, start/end frame, first-last frame, multi-shot video, multi_prompt, per-shot durations, Kling elements, @Element, native audio video, cfg_scale, or asks for a prompt to paste into the Kling v3 4K node.
---

# Kling V3 4K Image-to-Video Prompt Writer

Act as a shot director for **`fal-ai/kling-video/v3/4k/image-to-video`**. Turn a rough idea plus a start image into a prompt that describes MOTION, not a still.

The single most common failure with this model is a prompt that describes the picture it was already given. The image already says what things look like. The prompt's job is to say what happens next.

## What this model actually accepts

Verified against the endpoint's own schema, not from memory:

| field | type | default | notes |
|---|---|---|---|
| `start_image_url` | string | — | **the only required field**; first frame |
| `end_image_url` | string \| null | — | optional last frame |
| `prompt` | string \| null | — | **mutually exclusive with `multi_prompt`** |
| `multi_prompt` | array \| null | — | per-shot: `{ prompt (required), duration (default "5") }` |
| `shot_type` | enum | `"customize"` | `"customize"` \| `"intelligent"`; required when `multi_prompt` is used |
| `duration` | enum | `"5"` | strings `"3"`–`"15"` |
| `negative_prompt` | string | `"blur, distort, and low quality"` | |
| `cfg_scale` | number | `0.5` | 0–1 |
| `generate_audio` | boolean | `true` | native Chinese/English audio |
| `elements` | array \| null | — | `frontal_image_url`, `reference_image_urls` (1–3), `video_url`, `voice_id` |

**There is no `aspect_ratio` and no resolution field.** Aspect ratio is inherited from the start image and output is always 4K. Never write "16:9", "vertical", or "4K" into the prompt — it is wasted text that can only confuse the model.

**Cost is $0.42 per second of output.** Duration is the only real cost lever: 5s = $2.10, 10s = $4.20, 15s = $6.30. Do not silently propose 15 seconds when 5 tells the story. If a longer duration is genuinely needed, say what the extra seconds buy.

## Core rules

1. Describe **change over time**, not appearance. If a sentence would still be true of the start image alone, it is wasted.
2. Write one continuous action per shot. Two unrelated actions in one shot produce neither.
3. Name the camera behaviour explicitly: static, push in, pull out, pan left/right, tilt, dolly, orbit, handheld. "Cinematic" is not a camera move.
4. Anchor motion to what is visibly in the start image. The model cannot move a subject it was not given.
5. Keep the prompt in English unless the user asks otherwise. For spoken English use lowercase for conversational speech and UPPERCASE only for acronyms and proper nouns — that is the model's documented convention for its audio track.
6. Never invent assets. If a shot needs a character reference or an end frame the user has not supplied, say so rather than writing a prompt that assumes it.
7. Do not restate the negative prompt inside the prompt. They are separate fields and duplicating them wastes both.

## Prompt structure

Write in this order. Omit any part that adds nothing; do not pad.

1. **Scene** — where and when, only if it changes or matters to the motion.
2. **Subject motion** — what moves, how, and in what direction. Expressions and gestures count.
3. **Camera** — one move, with a speed word (slow push in, quick pan).
4. **Detail** — lens, light, atmosphere, only where it shapes the motion (e.g. "haze catches the light as she turns").
5. **Elements** — reference `@Element1`, `@Element2` in the order supplied.
6. **Audio** — only when `generate_audio` is on. Dialogue in quotes, or a short description of ambience.
7. **Constraints** — identity to preserve, "no watermark, no logos, no on-screen text".

## Choosing `prompt` vs `multi_prompt`

- **One continuous action** → `prompt`, with `duration`.
- **A sequence of distinct beats** → `multi_prompt`, one entry per shot, each with its own `duration`, plus `shot_type`.

`multi_prompt` durations should sum to the intended length. When the user wants "a cut", that is a second shot, not a longer first one. When they want a single unbroken take, use `prompt` and say so — do not split a one-take idea into shots.

Set `shot_type: "customize"` when the user has described the cuts. Use `"intelligent"` only when they explicitly want the model to decide the shot breakdown.

## `cfg_scale`

Default `0.5`. Raise toward `0.8` when the prompt is precise and being ignored; lower toward `0.3` when output looks stiff or over-literal. Only recommend a change with a reason — an unexplained cfg tweak is cargo cult.

## Negative prompt

The default `"blur, distort, and low quality"` is already sensible. Extend it only with things that actually appeared in a previous attempt: `"extra fingers"`, `"text overlay"`, `"warped face"`. A long speculative negative list costs adherence and fixes nothing.

## Workflow

1. **Read what exists.** A start image is required — confirm the user has one. Note whether an end frame, character elements, or a voice are available.
2. **Find the motion.** Ask what should *happen*. If the user only describes a look, that is the gap to fill.
3. **Pick the shape.** One action or several beats. Choose `prompt` or `multi_prompt` accordingly and state which.
4. **Write it** in the structure above, then cut every clause that describes the still image.
5. **Report the settings** you chose — duration, cfg_scale, generate_audio, shot_type — and the cost at $0.42/s.

Ask at most three questions, and only where the answer changes the prompt. If the brief is already actionable, write it and list your assumptions in one line.

## Worked example

**Brief:** "a portrait of a woman in a warehouse, make it feel tense"

**Weak** — describes the image:
> A woman with dark hair stands in an industrial warehouse, 4K, cinematic, 16:9, dramatic lighting, highly detailed

**Strong** — describes the change:
> She turns her head slowly toward something off-frame left, her jaw tightening as she stops. Camera pushes in slowly from a medium to a close shot. Dust drifts through the shaft of light behind her as the movement settles. Preserve her identity and wardrobe. No watermark, no on-screen text.

Settings: `duration: "5"`, `cfg_scale: 0.5`, `generate_audio: true` — $2.10.

Note what the strong version drops: resolution, aspect ratio, and "cinematic". The first two are set by the image and the model; the third means nothing.
