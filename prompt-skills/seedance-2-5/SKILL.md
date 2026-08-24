---
name: seedance-2-5
description: Write and rewrite prompts for ByteDance Seedance 2.5 on fal (bytedance/seedance-2.5/text-to-video, /image-to-video, /reference-to-video). Use when the user mentions Seedance 2.5, Seedance 2-5, Dreamina, dreamina-seedance-2-5-260628, seedance t2v/i2v/r2v, reference-to-video, @Image1, @Video1, @Audio1, image_urls, video_urls, audio_urls, end_image_url, generate_audio, bitrate_mode, aspect_ratio auto, duration auto, 30-second video, native audio video, lip sync, video extension, video editing, storyboard to video, or asks for a prompt to paste into a Seedance 2.5 node. This is Seedance **2.5** only — for Seedance 2.0 (`bytedance/seedance-2.0/*`, `seedance-2-0-260128`, the muapi `seedance-v2.0-*` ids, 15-second maximum) use the seedance-2-0 skill instead.
---

# Seedance 2.5 Prompt Writer

Act as a visual content producer for **`bytedance/seedance-2.5/{text-to-video, image-to-video, reference-to-video}`** on fal. Turn a rough idea into a structured, timed prompt.

This model generates up to **30 seconds natively in one pass** with **audio co-generated in the same latent space** as the picture. That single fact drives everything below: the prompt is not a caption, it is a **shot plan with a timeline and a soundtrack**.

## The failure this model is actually prone to

Not incoherence — plot density mismatched to duration. The lab states it plainly:

> "If too little plot is specified within a given time range, the model may improvise more freely. If too much content is packed into a given time range, the result may contain excessive cuts or omit parts of the plot."

So a thin one-line prompt at `duration: "30"` does not give you a 30-second version of your idea; it gives the model 25 seconds it will fill with invented business. And a dense paragraph crammed into 5 seconds produces machine-gun cutting or silently dropped beats.

**The fix is structural: allocate plot to seconds explicitly, and match the duration to the amount of story you actually wrote.** Budget roughly one distinct beat per 3–5 seconds. If the user has one action, that is a 4–6 second prompt, not a 30-second one.

## Default prompt template

**fal's three model pages carry no prompt template at all** — verified against the raw page bytes. The template below is the **originating lab's**, from the BytePlus ModelArk "Dreamina Seedance 2.5 prompt guide". Reproduce its labels verbatim; they are the vendor's own section names.

The guide's preamble, verbatim: *"Treat Seedance 2.5 as a visual content producer, and write structured prompts with a visual storytelling mindset."*

```
Asset Referencing for R2V
Clearly identify each image, video, or audio asset by its upload order and intended
purpose, such as which asset represents the subject, voice, action, scene, and so on.

One-Sentence Summary
Subject + Location + Event + Genre/Style + Camera movement...

Detailed Plot Description
Shot sequence or timeline: Either format is acceptable. Use timestamps or "Shot N" to
divide the video into segments, and describe each segment's specific visuals, camera
movement, actions, dialogue, sound effects, and other details.
Use positive descriptions whenever possible. Negative constraints are supported for
subtitles and audio control, such as "no subtitles" and "no BGM."

Additional Notes
Add any visual details that should remain consistent throughout, such as camera angle,
camera movement, environment, scene setting, sound, atmosphere, and other recurring
elements.
```

These four labels are routinely misread. What each is actually asking for:

- **Asset Referencing for R2V** — a mapping line, only for reference-to-video. It binds each uploaded file to a *job* ("@Image1 = the character's face, @Audio1 = her voice"). Omit this label entirely on t2v and i2v.
- **One-Sentence Summary** — the model's anchor for the whole clip, not a title. One or two sentences; a leading style-and-lighting clause ahead of the scene sentence is acceptable and is exactly what the vendor's own worked example does. Read `Subject + Location + Event + Genre/Style + Camera movement` as a checklist of what to include, not as a strict word order. Do not expand it into a paragraph.
- **Detailed Plot Description** — the timeline. This is where the seconds get allocated. Timestamps (`0s-3s:`) **or** shot numbers (`Shot 1:`), not both in one prompt.
- **Additional Notes** — *persistent* qualities that hold across every beat: grade, lens, ambience, mood, audio bed. Not new plot. If a detail only applies to one beat, it belongs in that beat, not here.

You do **not** emit these labels as literal headings. The guide's own worked example instantiates the structure as flowing text. Its shape, which you should copy:

```
Realistic nature documentary style, natural lighting and shadows. On a warm afternoon, on a grassy slope in the forest, a chubby panda cub rolls down the hill.

The panda has fluffy, realistic black-and-white fur, a small round body, and clumsy, adorable movements. The scene is a green forest slope. The ground is covered with grass, moss, clover, soil, small stones, dry branches, and a few small yellow flowers. Tall tree trunks and dense woods are softly blurred in the background. The camera is a low-angle medium-wide shot with a slight handheld feel. The framing remains mostly stable, keeping the panda in frame at all times.

0s-3s: A panda cub lies on a green grassy slope, its body round and chubby. It begins to slowly roll sideways down the slope with clumsy movements, gently bending the grass beneath its body. A light breeze passes through, and sunlight filters through the trees from the upper left, creating dappled light and shadow.

3s-8s: The panda rolls toward the lower right of the frame and gradually comes to a stop, shifting from lying on its side to lying on its belly. Its round face turns toward the camera, and its front paws press into the grass. The panda lies in the foreground grass, adjusts into a comfortable position, slightly raises and lowers its head, and makes a soft little humming sound.

Low camera position, slight handheld feel, subtly following the panda as it moves toward the lower right. Natural depth of field: the foreground grass is slightly blurred, the panda remains clear, and the background forest is softly out of focus. Natural environmental audio only, including wind, rustling grass, and the soft plop of the panda rolling. The overall mood is warm, realistic, and natural.
```

Line 1 is the One-Sentence Summary. Paragraph 2 is static subject/scene/camera. Then the timestamped beats. The closing paragraph is Additional Notes plus audio.

### The basic formula (use when the shot is simple)

From the model's tutorial, verbatim, including its own spacing:

> "Follow the basic formula : Organize the prompt in the order of "subject + action/event + scene and environment + visual style + camera movement/shot cuts + sound"; unnecessary parts may be omitted."

For a single continuous action under ~8 seconds, write one paragraph in that order and skip the timeline. Say which form you chose.

### The labelled storyboard variant (multi-shot work)

When the user has a storyboard or wants explicit cuts, the guide's alternative form uses literal labels and a bracketed shot header:

```
Visual Style: Domestic realistic short drama, shot on Arri Alexa Mini LF, 35 mm cinema lens, cinematic realistic lighting, indoor night scene with snow-falling night view outside the window, film grain, authentic skin texture, natural lifelike performance, subtle micro-expressions, real adult facial bone structure and facial features, no excessive beautification or skin smoothing.
Asset Bindings: Storyboard @Image1, bedroom @Image2, Li Tian @Image3, Li Qian @Image4, book *Happy Times* @Image5.
Shot 1: [Wide shot, locked-off camera, eye-level, rule-of-thirds composition] Room on a snowy winter night. In front of floor-to-ceiling windows, a man stands sideways with both hands in his pockets, gazing out at falling snow. A young girl stands beside him, watching the man quietly. Calm and restrained atmosphere. Snowflakes keep drifting against the glass window.
Shot 2: [Medium shot, over-the-shoulder shot] The girl's back serves as foreground. The man turns his head and looks gently toward the girl. The girl bows her head slightly in silence. Snow keeps falling outside the window.
```

`Visual Style:` / `Asset Bindings:` / `Shot N: [shot size, camera, composition]` are the vendor's own labels and bracket convention. The guide's recipe for this form, verbatim: *"Step 1: Clearly state the mapping relationships of the reference assets. Step 2: Write an overall story summary. Step 3: Fully describe the plot according to the storyboard, and at minimum fill in information not shown in the storyboard."*

## What the endpoints actually accept

Verified against fal's OpenAPI for all three variants and mirrored by this app's `/api/models` schema. **Where fal's prose model page disagrees with its OpenAPI, the OpenAPI wins — that is what the node sends.**

### Shared by all three

| field | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required on all three**, including image-to-video |
| `resolution` | string | `"720p"` | `480p` \| `720p` \| `1080p` |
| `duration` | string | `"auto"` | `"auto"`, or `"4"`…`"30"` — **strings, not integers** |
| `aspect_ratio` | string | `"auto"` | t2v & r2v: `auto`,`21:9`,`16:9`,`4:3`,`1:1`,`3:4`,`9:16`. **i2v: not selectable** |
| `generate_audio` | boolean | `true` | audio costs nothing extra — see cost |
| `bitrate_mode` | string | `"standard"` | `standard` \| `high` |
| `end_user_id` | string \| null | — | fal: "Required for B2B access" |

### Per variant

| variant | extra fields |
|---|---|
| **text-to-video** | none. `required = ["prompt"]` |
| **image-to-video** | `image_url` (**required**, first frame, JPEG/PNG/WebP, max 30 MB); `end_image_url` (optional last frame — the clip transitions from first to last) |
| **reference-to-video** | `image_urls[]` (up to 30), `video_urls[]` (up to 10), `audio_urls[]` (up to 10). Total files across all modalities **must not exceed 50** |

**`seed` is not an input.** fal's prose page lists it on all three variants; it is absent from every Input schema in fal's OpenAPI and from this app's schema, appearing only in the *output*. The returned seed is informational — you cannot replay it. Disregard fal's "re-run the winning seed at 720p" tip; it is not actionable on 2.5.

**`aspect_ratio` is not selectable on image-to-video.** fal's prose shows the full enum, but the OpenAPI has no enum and its description reads literally `Always "auto" for image-to-video`. The lab explains why: first-frame tasks *lock* the output ratio to the input image's ratio. Never promise a user a different aspect ratio on i2v — crop the input image instead.

**There are no fast or mini tiers.** Seedance 2.0 ships base + `fast` + `mini`; 2.5 ships only the three base endpoints (`fast`/`mini`/`pro`/`lite` under `seedance-2.5/` all 404). If the user needs a cheap tier, that is a reason to stay on 2.0.

## Choosing the variant

- **text-to-video** — no assets. Full control of `aspect_ratio` and `duration`.
- **image-to-video** — a specific first frame matters. Add `end_image_url` to land on a chosen final composition (loops, product reveals, before/after). Aspect ratio is locked to the image.
- **reference-to-video** — the most controllable endpoint, and far broader than fal's page suggests. The **same endpoint** covers subject reference (appearance and/or voice), motion reference, style reference, audio reference, storyboard-to-video, keyframe alignment, **video editing**, **video extension**, and transitions between two clips. Which one you get is decided by **prompt intent**, not by a parameter.

For editing and extension the native model requires trigger wording in the prompt: editing needs *"edit video, add, insert, remove, delete, modify, replace, change to, or similar wording"*; extension needs *"extend forward, extend backward, continue, continue from, extend the story, or similar wording."* Without it the model may classify the task differently than intended.

## 2.5 vs 2.0 — the choice neither vendor page states

Diffing the two OpenAPI specs property-by-property, every input is identical except two:

| | Seedance 2.0 | Seedance 2.5 |
|---|---|---|
| `duration` | auto, 4…**15** | auto, 4…**30** |
| `resolution` | 480p, 720p, 1080p, **4k** | 480p, 720p, 1080p — **no 4k** |
| reference cap | 9 images, 12 total | 30 images, 50 total |

**If you need 4K, you must use Seedance 2.0.** 2.5 buys double the duration ceiling and four times the references at the cost of the top resolution tier. Say this whenever a user asks for 4K.

The lab's own framing is worth quoting to anyone deciding: *"Compared with Seedance 2.0, Seedance 2.5 is not a cross-generational leap in the same way that 2.0 was compared with 1.5."* It is a production-workflow upgrade, not a quality jump. Other 2.5-only gains the lab names: timestamps are honoured (2.0 responds only to shot numbers), multi-view subject images are supported, and output aspect ratio can be any value in [0.4, 2.5] by controlling input assets.

## Cost

Billing is token-based. The formula is authoritative:

```
tokens = (output_height * output_width * duration_seconds * 24) / 1024
```

Rate: **$0.0214 per 1000 tokens** at 480p and 720p, and fal's pricing widget states **roughly $0.0234 per 1000 tokens for 1080p**.

Per-second figures derived from the formula, for the frame sizes fal itself uses in its worked examples: **~$0.462/second at 720p** (1280 × 720 → 21,600 tokens/s) and **~$0.215/second at 480p** (864 × 496 → 10,044 tokens/s). Quote these, and always state the frame size you assumed — the rate is a function of frame area, so it moves with the aspect ratio.

| generation | tokens | cost |
|---|---|---|
| 5s @ 720p 16:9 (1280 × 720) | 108,000 | ~$2.31 |
| 10s @ 480p (864 × 496) | 100,440 | ~$2.15 |
| 30s @ 720p 16:9 (1280 × 720) | 648,000 | ~$13.87 |

**Do not quote fal's per-second headline numbers.** fal's pricing block advertises ~$0.4730/second at 720p and ~$0.2205/second at 480p. Both disagree with fal's own formula *and* with fal's own worked examples on the same page: 108,000 tokens for 5s at 720p is $0.462/second, not $0.4730, and 100,440 tokens for 10s at 480p is $0.215/second, not $0.2205. The formula and the token counts agree with each other; only the headline rates are out. Derive from the formula every time.

**The cost lever is duration × frame area — nothing else.**

- **Audio is free.** Verbatim from the schema: "The cost of video generation is the same regardless of whether audio is generated or not." Turn `generate_audio` off only when you need silence, never to save money.
- **Aspect ratio changes cost**, because it changes frame area. Wider ratios cost more per second.
- **`"auto"` costs are unpredictable.** fal: *"Both 'auto' settings affect your token count. Pass explicit values for duration and aspect_ratio when you need predictable cost."* Set both explicitly whenever budget matters.
- **`bitrate_mode: "high"` has no stated price effect** in any source, and no documented counterpart in the native API. Treat its behaviour as unverified.

**reference-to-video bills input video too**, on a different formula:

```
tokens = (output_height * output_width * (input_video_duration + output_duration) * 24) / 1024
```

If any video references are provided the price is multiplied by **0.6** — roughly **$0.277/second at 720p** (0.6 × $0.462), applied to input and output seconds alike. Image and audio references are not billed. (fal's page states $0.2838/second here; that is 0.6 × its own inflated $0.4730 headline, so it inherits the same error.) fal's warning, verbatim: *"Trim reference videos to the segment that actually matters. Every second of input video you send is a billed second."*

Iterate at 4–5 seconds and 480p to lock composition, then scale up. A 5-second test costs roughly a sixth of a 30-second one.

## Core rules

1. **Allocate seconds to beats.** One beat per 3–5 seconds. Keep the timeline continuous — the guide warns explicitly against gaps like "0-3s… 5-6s…".
2. **Set `duration` to match the plot you wrote.** Do not write four beats and leave `duration: "auto"`.
3. **Do not timestamp high-frequency action.** The guide's own example of what not to do: *"shake your head three times per second."* Timestamps control story beats, not gestures.
4. **Write positively.** Negative phrasing is supported only for subtitles and audio — "no subtitles", "no BGM", "no audio". Everything else must be stated as what *should* happen.
5. **Name camera language directly.** Shot size (extreme wide / wide / medium / medium close-up / close-up), movement (push in, pull out, pan, track, follow, orbit, dive, tilt up, handheld shake), and angle (low angle, overhead, first-person) can all be written as-is, as can one-shot/long take, dolly zoom, FPV, bullet time and speed ramp. For niche terms, write **[term + a descriptive explanation]** — the term alone may not land.
6. **On image-to-video, describe what changes, not what is visible.** The image already establishes the subject; spend the prompt on motion, camera and sound. If a sentence would still be true of the still frame alone, cut it.
7. **If first and last frames are both supplied, they must share an aspect ratio.** Verbatim: *"If the last frame has a different aspect ratio from the first frame, it will be stretched."*
8. **Never invent assets.** If a shot needs a reference the user has not supplied, say what they need to provide rather than writing `@Image3` into the dark.

## Audio and dialogue — two conventions, do not merge them

Audio is generated jointly with the picture, so sound cues belong in the prompt.

**Default on fal: wrap spoken lines in double quotes.** fal's own tested guidance: `The man stopped and said: "Remember this moment."`

**The native model additionally documents a fuller symbol set:** `()` for music, `<>` for sound effects, `{}` for dialogue, and `【】` for subtitles. *"For non-Chinese dialogue, it is recommended to specify the language before the dialogue."*

These conflict on dialogue. fal wraps the native model, so **use double quotes by default on fal endpoints**, and offer the brace set only when the user needs to separate music, SFX, dialogue and subtitles precisely. Never mix both conventions in one prompt, and tell the user which you used.

Prompts and generated speech are supported in **Chinese, English, Spanish, Indonesian, Malay, Thai, Arabic, Portuguese, Vietnamese, Japanese and Korean**.

## Reference handling (reference-to-video)

Refer to assets as **`@Image1`, `@Video1`, `@Audio1`** — the form used by both fal's OpenAPI and the lab. (fal's prose page shows `[Image1]`; that is the outlier, contradicted by fal's own schema. Do not use it.) State what each asset provides *and what should not be referenced from it*.

Documented sweet spots, not hard limits: 1–8 subject **image** references work well (9–12 is possible); 1–5 subject **audio/video** references work well (6–10 loses stability); reference clips of **5–10 seconds** work better than long ones; video editing works best on **videos under 20 seconds**.

Hard constraints: video refs must be 1.8–30.2s each, ≤200 MB, combined ≤30.2s, 24–60 FPS, 300–6000 px/side, AR 0.4–2.5. Audio refs 1.8–30.2s, ≤15 MB each, combined ≤30.2s. **If audio is provided, at least one reference image or video is required.**

More references is not better — each competes for influence. Start with the two or three that carry the concept.

### Lip sync and voice

Lip sync is not a separate endpoint or a parameter. It falls out of `generate_audio` being on, and there are two different jobs the user may mean.

**No voice asset — the model synthesizes the speech.** Write the spoken words in the prompt, in double quotes. This is fal's tested route and it works on **all three variants**, t2v and i2v included: *"Put spoken dialogue in double quotes for lip-synced audio"* — the model generates matching lip movements and a voice. If the user only wants a character to say a line, they do **not** need r2v or an audio file.

**A voice asset exists — r2v, and the assets split by job.** `@Audio1` carries the voice; `@Image1` or `@Video1` carries the face. Say so explicitly in the asset-binding line, and say what should *not* be taken from each: an audio reference contributes *"music, dialogue, voice, tone, or timbre"*, a subject reference contributes *"appearance identity and/or voice"* — so a talking-head video reference can hand over both, and you should state which of the two you want when it could be either.

**Whether to also type the words when `@Audio1` supplies them is undocumented.** No source states that repeating the script alongside a voice track helps, and it risks the model synthesizing a second competing read. Default to naming the asset's job (`@Audio1 = her voice, use its timbre and timing`) and quoting the words only when you want the model to *generate* the speech. The vendor's own dubbing example instructs rather than re-types the script: *"Translate the spoken dialogue in the video into Chinese, with no subtitles. Precisely adjust the lip movements to match the translated speech, while keeping everything else unchanged."* Tell the user which of the two you chose.

**Constraints that bite on this workflow specifically:**

- **Audio alone is not a valid r2v job.** Verbatim from the schema: *"If audio is provided, at least one reference image or video is required."* A voice track with no face attached is rejected — ask for the face asset before writing the prompt.
- Audio refs: up to 10 files, **1.8–30.2 s each, ≤15 MB each**, combined ≤30.2 s. A voice track longer than 30.2 s must be trimmed, and it caps the clip you can sync to it.
- 1–5 subject audio/video references work well; 6–10 loses stability. For a voice, one clean reference beats several.
- Keep `generate_audio: true`. Turning it off removes the lip-synced speech, which is the whole job.
- Real human faces are the live hazard here — see the operational warning below. A lip-sync workflow is a portrait workflow by definition, so raise it before the user uploads anything.

## Two operational warnings

**Real human faces.** The lab states plainly: *"Seedance 2.5 does not support directly uploading reference images or videos containing real human faces."* Its three sanctioned workarounds (trusted platform outputs, preset digital characters, authorized verified assets) are **ModelArk-only and have no fal equivalent**. fal's pages never mention this restriction and show portrait examples. Whether fal is exempt, proxies it silently, or surfaces an opaque moderation failure is undocumented and untested. Flag this to any user building a portrait or character workflow — it is the likeliest cause of a confusing failure.

**Long generations.** fal: *"Use the queue API rather than a synchronous call for anything past a few seconds of output"*, and reference generations with video inputs are the slowest of the three. No latency figures are published. A 30s 720p job may exceed this app's 5-minute `/api/generate` timeout; that has not been measured either way.

## Workflow

1. **Pick the variant.** Assets on hand decide it: none → t2v; a first frame → i2v; anything to reference, edit or extend → r2v.
2. **Count the beats**, then set `duration` to roughly 3–5 seconds per beat. Do not leave it on `"auto"` when cost or timing matters.
3. **Pick the form.** One action → the basic formula, one paragraph. Several beats → the timestamped structure. A storyboard or explicit cuts → the labelled `Shot N:` variant.
4. **Write it**, then cut every clause that describes a still rather than a change, and check the timeline has no gaps.
5. **Report the settings** — variant, resolution, duration, aspect_ratio, generate_audio — and the cost from the formula.

Ask at most three questions, and only where the answer changes the prompt. If the brief is already actionable, write it and list your assumptions in one line.

## Worked example

**Brief:** "a chef plating a dish in a restaurant kitchen, make it look premium, 30 seconds"

**Weak** — a caption at a duration it cannot fill:

> A professional chef plates a gourmet dish in a high-end restaurant kitchen. Cinematic, 4K, highly detailed, dramatic lighting, shallow depth of field, award-winning food photography.

Three failures. It describes a *look*, not a sequence, so 30 seconds of unallocated time gets filled with improvised business. "4K" is not available on 2.5 at all and is wasted text either way — resolution is a parameter. "Cinematic" and "award-winning" carry no instruction.

**Strong** — text-to-video, timestamped, duration matched to the beats written:

```
Fine-dining documentary style, warm practical lighting with deep shadows. In a
professional restaurant kitchen at service, a chef plates a scallop dish under
a pass light, shot on a slow push-in.

The chef is in his forties, white jacket, sleeves rolled, hands steady and
unhurried. The pass is stainless steel, scuffed and warm-lit from above; the
background kitchen is busy but softly out of focus. Camera is a medium close-up
on the plate, eye-level, moving on a slow continuous push toward the dish.

0s-4s: The chef sets a warm white plate down on the steel pass. Steam drifts
across frame from the left. His hands enter frame holding tweezers.

4s-9s: He places three seared scallops in a slow arc across the plate, one at a
time, adjusting the last one by a few degrees. Faint sizzle continues off-screen.

9s-14s: He spoons a pale green emulsion beside the scallops in a single confident
sweep, then draws the back of the spoon through it once.

14s-18s: He scatters small herb leaves and finishes with a light grind of pepper.
He pauses, looks at the plate, and gives one small nod.

One unbroken take, slow continuous push-in throughout. Shallow depth of
field: the plate stays sharp, the kitchen behind stays soft. Natural kitchen
audio only — distant sizzle, low extractor hum, the light click of tweezers and
ceramic. No BGM. No subtitles. Warm, calm, precise mood.
```

Settings: `duration: "18"`, `resolution: "720p"`, `aspect_ratio: "16:9"`, `generate_audio: true`, `bitrate_mode: "standard"`.
Cost: 1280 × 720 × 18 × 24 / 1024 = 388,800 tokens ≈ **$8.32**.

**What changed and why:**

- **30s became 18s.** Four beats is roughly 18 seconds of real story. Asking for 30 would have handed the model 12 unscripted seconds to improvise into — the documented failure mode — and would have cost ~$13.87 instead of ~$8.32.
- **A timeline replaced adjectives.** Each beat is one action in a stated window, continuous with no gaps.
- **The camera got one named behaviour** ("one unbroken take, slow continuous push-in") instead of "cinematic". Note the positive phrasing: "no cuts" would have been a camera negative, and negatives are not supported outside subtitles and audio.
- **Audio was written**, because it is generated jointly and free. The negatives used — "No BGM", "No subtitles" — are the only two categories where negative phrasing is supported.
- **"4K" and "highly detailed" were dropped.** 2.5 has no 4K tier; resolution is a parameter, not prompt text.
- `aspect_ratio` was set explicitly rather than left on `"auto"`, so the token count and therefore the cost are predictable. Had this been image-to-video, that field would have been unavailable and the ratio inherited from the input frame.
