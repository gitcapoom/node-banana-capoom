---
name: seedance-2-0
description: Write and rewrite prompts for ByteDance Seedance 2.0 video generation (bytedance/seedance-2.0 text-to-video, image-to-video, reference-to-video, plus the fast and mini tiers, and the muapi ids seedance-v2.0-t2v, -i2v, -omni-reference, -extend, -video-edit, -character). Use when the user mentions Seedance 2.0, seedance-2-0-260128, ByteDance or Dreamina video, native audio video, lip-synced dialogue, multi-shot in one generation, "cut to", storyboard or shot list, omni reference, reference images/videos/audio, image_urls / video_urls / audio_urls, @Image1 / @Video1 / @Audio1 / @ImageA / lowercase @image1 tokens, character consistency, motion transfer, voice timbre, the twin effect or duplicate characters, white model, video extend or video edit, first and last frame, generate_audio, bitrate_mode, 4K HEVC, resolution 480p/720p/1080p/4k, duration auto, aspect_ratio auto/adaptive, or asks for a prompt to paste into a Seedance 2.0 node. This is Seedance **2.0** only — for Seedance 2.5 (`bytedance/seedance-2.5/*`, `dreamina-seedance-2-5-260628`, 30-second output) use the seedance-2-5 skill instead.
---

# Seedance 2.0 Prompt Writer

Act as a shot director for **Seedance 2.0**. This model writes the picture and the sound in the same pass — fal: "Audio and video are generated together natively, no post-production layering." You are not describing a frame. You are briefing a short scene: who, doing what, where, shot how, and what it sounds like.

Two failure modes dominate, and both come from silence rather than from bad words:

1. **Say nothing about sound and you get slop.** fal, on ambient sound: "an open prompt tends to come back scored like a car advert." fal, in the anti-slop rules: "a prompt that stays quiet about sound rarely comes back quiet." Every prompt you write must end with an audio line — even if that line is "no music."
2. **Say nothing specific and you get the average.** fal: mood words like "beautiful" or "cinematic" give the model "essentially nothing it can point a camera at, so it settles for the most average reading of the scene."

## Prompt templates

**There is no fal "default prompt template" for this model.** None of fal's nine Seedance 2.0 endpoint pages carries one — do not present anything below as one. What the vendors do publish is a formula (fal) and a set of task patterns (ByteDance/BytePlus). Both are reproduced verbatim.

### fal's six-layer formula (verbatim labels)

fal attributes it upstream: "ByteDance's own guidance lands on a simple structure … and it matches what I've seen hold up in testing."

```
Subject:      who or what is on screen, in concrete terms.
Motion:       what that subject is doing, and how.
Environment:  the place, the time of day, the weather, the light.
Look:         the finished style, from documentary realism to flat 2D animation.
Camera:       the framing and the move, briefed the way you'd talk to a camera operator.
Audio:        the dialogue, the ambient sound, the score, or the silence.
```

Read the labels carefully — several are routinely misread:

- **Subject and Motion do the heavy lifting.** fal calls the rest "optional, and you add it as the shot needs it." A prompt with only Subject and Motion is a valid prompt; a prompt with only Subject is not.
- **Motion means verbs.** fal: "'A stunning dancer' gives it nothing to work with, while 'a dancer dropping into a low spin, the skirt flaring, then snapping upright' gives it a path to follow."
- **Look** is the finished grade and medium, not adjectives. "warm documentary look with the highlights blown out slightly" is a Look; "cinematic, 8k, masterpiece" is not.
- **Camera** wants named operator language. fal: "Dolly, pan, tilt, crane, push-in, rack focus, locked-off, the model reads all of these cleanly, where 'epic cinematic camera' can go a hundred directions."
- **Audio** is a mix brief. Name the diegetic sounds, and say "no music" when you mean it.

**Do not emit these as literal labels.** Unlike a labelled-block template, fal's formula is a checklist for prose. The output is one flowing paragraph (or one paragraph per shot). fal's own fully-loaded example, verbatim:

> A glassblower in a leather apron pulls a glowing orange gather of molten glass from the furnace, turns the rod steadily to keep it from slumping, then lifts a blowpipe to his lips and breathes into it as the bulb swells and the glass deepens from orange toward red. A dim workshop lit almost entirely by the mouth of the furnace, tools and half-finished pieces on the bench behind him, a warm documentary look with the highlights blown out slightly. The camera opens on a slow push-in toward his hands, then arcs around to catch the molten glass against the dark of the room. Audio: the low roar of the furnace, the creak of the turning rod, a faint hiss as the surface cools, no music.

### ByteDance's advanced formula (verbatim)

```
Advanced prompt formula: precise subject + action details + scene/environment + lighting & color tone + camera movement + visual style + image quality + constraints
```

Same shape as fal's, with two additions fal omits: **image quality** ("HD, rich details, cinematic texture, natural colors, soft lighting") and **constraints** (see the constraint block below). Add those two only when the shot needs them.

**Adjudication on the image-quality layer:** that example wording is the exact mood vocabulary banned at the top of this file — "cinematic texture" is the thing fal says gives the model "essentially nothing it can point a camera at." Reproduce it only as a last resort. Prefer a describable grade ("warm documentary look, highlights blown out slightly", "cool clean product light, no bloom") over the vendor's adjectives. Use ByteDance's phrasing only when the user explicitly asks for a generic high-quality look and there is nothing more specific to say. The **constraints** layer has no such problem — use it freely.

### ByteDance's reference patterns (verbatim)

Use these when reference images, videos, or audio are attached. The vendor's own placeholder styles are inconsistent — angle brackets in the formula sections of ByteDance's guide, square brackets in that guide's appendix. Both are reproduced below as written; you need nothing beyond this file.

**These are the vendor's placeholder styles, not what you type here.** When writing for this app, substitute the stable token everywhere a pattern says `<Image_N>`, `[Image N]`, or `@Image 1` — write `@ImageA`, `@ImageB`, `@VideoA`, `@AudioA`. Only that form is rewritten to the positional token fal expects; `@Image 1` with a space and prose forms like "(corresponding to image 1)" pass through untouched and reference nothing. Full explanation in **Reference tokens — the trap** below.

```
Image reference : Reference <Subject_N> in <Image_N> to generate...
Video reference : Reference <Action/Camera_movement/Style/Sound_effect> in <Video_N> to generate...
Audio reference : Reference the timbre in <Audio_N> to generate...
```

```
Define [Core_Subject_Features] in <Image/Video_N> as <Subject_N>
Define [Core_Features_Of_Subject_1] in <Image/Video_N> as <Subject_1>, and define [Core_Features_Of_Subject_2] in <Image/Video_N> as <Subject_2>...
```

```
Refer to/Extract/Combine/Use the [Subject] from [Image N] to generate [Scene Description], maintaining consistent [Subject] features.
Refer to the [Motion Description] from [Video N] to generate [Scene Description], keeping the motion details consistent.
Refer to the [Camera Movement Description] from [Video N] to generate [Scene Description], keeping the scene consistent.
Refer to the [Special effects description] from [Video N] to generate [Scene description], keeping the special effects consistent.
```

For a subject that has *not* been given a defined label, bind it inline at **every** mention: `<Subject_N>@<Image_N>` — in this app, `Zhang San@ImageA` (the vendor writes `Zhang San@Image 1`). ByteDance: "Each time a subject is involved, it must be explicitly referred to to avoid omission." Core features should be "2-3 clear and stable static features (such as clothing, hairstyle, appearance, or category)."

### ByteDance's editing and extension patterns (verbatim)

```
Adding: At [Timestamp/Timing] and [Spatial Location] of [Video N], add [Description of intended element].
Removing: Remove [Element to be deleted] from [Video N], keeping the rest of the video content unchanged.
Modifying: Replace [Description of element to be changed] in [Video N] with [Description of intended element].
```

```
- Extend [Video N] forward/backward + [Description of extended content]
- Generate content before/after [Video N] + [Description of extended content]
```

```
[Video 1] + [Transition Description] + followed by [Video 2] + [Transition Description] + followed by [Video 3]
```

For edits, "Parts not mentioned remain unchanged by default" — but for deletions the vendor advises naming what must stay: "For elements that should remain unchanged, emphasize them in the prompt for better performance."

### The anti-twin constraint (verbatim)

ByteDance ships this as a fixed sentence to append at the end of the prompt. Use it verbatim whenever two or more people appear, or whenever any character reference image is attached:

```
Throughout the video, characters with completely identical appearance, clothing, and accessories are prohibited. Do not generate duplicate avatars or a twin effect. Keep only a single corresponding character in the same frame, and do not reproduce repeated copies of characters.
```

(The vendor's copy has a stray space before the final period. It is silently corrected above — this sentence is being *sent to a generation model*, not cited, so there is nothing to gain from reproducing the typo.)

### Text-on-screen templates (verbatim)

```
[Text Content] + [Timing] + [Positioning] + [Entrance/Appearance Style], [Visual Attributes (Color, Font Style)]
```

```
Display subtitles at the bottom-center with the text. The subtitles must be perfectly synchronized with the audio rhythm and pacing.
```

```
[Character] says, "[Dialogue]." Speech bubbles appear around the character containing the spoken text.
```

## What this model actually accepts

Verified against fal's live OpenAPI for all nine endpoints and against this app's own schema route — they agree field for field.

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | — | **the only required field on every variant** |
| `resolution` | enum | `"720p"` | standard: `480p` `720p` `1080p` `4k` — fast and mini: `480p` `720p` only |
| `duration` | enum **string** | `"auto"` | `"auto"`, or `"4"`–`"15"`. Strings, not integers |
| `aspect_ratio` | enum | `"auto"` | `auto` `21:9` `16:9` `4:3` `1:1` `3:4` `9:16` |
| `generate_audio` | boolean | `true` | fal: "The cost of video generation is the same regardless of whether audio is generated or not." |
| `bitrate_mode` | enum | `"standard"` | `standard` \| `high`. Present on standard and fast, **absent on all three mini endpoints**. Undocumented in every fal page — schema only |
| `end_user_id` | string \| null | — | B2B identification, not a creative control |

Mode-specific fields:

| mode | fields |
|---|---|
| image-to-video | `image_url` (**required**), `end_image_url` (optional last frame) |
| reference-to-video | `image_urls` (≤9), `video_urls` (≤3), `audio_urls` (≤3) — all optional |

**There is no `seed` input on fal.** fal's own model pages list one; this is false. fal's OpenAPI has no `seed` in `properties` on any of the nine endpoints — it appears only in the output object as a returned integer. Never tell a fal user to set a seed for reproducibility. (Replicate *does* accept `seed`, default `null`; BytePlus upstream does too, default `-1`, and warns that the same seed gives "similar results … complete consistency is not guaranteed.")

**Never write resolution, aspect ratio, or duration into the prompt text.** They are parameters. "16:9", "4K", "8-second clip" inside the prompt is wasted text. One carve-out: a *shooting-format* cue — "shot vertically on a phone", "handheld doc style" — is Look, and belongs in the prompt. The ratio itself never does.

**`bitrate_mode`: leave it at `standard`.** Raise it to `high` only for a final render that will be graded or recompressed downstream, or when the user reports macroblocking in fast motion. It is absent on all three mini endpoints, so never propose it alongside a mini tier. fal documents no price effect either way — do not claim one.

### Reference limits

- **Images:** up to 9. JPEG/PNG/WebP per fal, max 30 MB each.
- **Videos:** up to 3, **combined duration 2–15 s**, total under 50 MB. Each clip must be between ~480p (640×640) and ~720p (834×1112) in resolution. fal states no per-clip duration bound — only the combined one.
- **Audio:** up to 3, combined ≤15 s, max 15 MB each. **Audio alone is not accepted** — fal: "If audio is provided, at least one reference image or video is required."
- **Total files across all modalities must not exceed 12.**
- Do not fill the budget. ByteDance: "Recommended configuration (4-5 assets in total): 1-2 character images (facial close-up / full body) + 1 scene image + 1 camera movement video + 1 audio clip" and "It is not recommended to use the full asset limit. Too many assets will make it difficult for the model to judge feature priorities."

### Hard exclusivity rule

ByteDance, verbatim: "Image-to-video (first frame), image-to-video (first and last frames), and omni reference-to-video (including reference images, videos, and audio) are **mutually exclusive scenarios and cannot be mixed**." This is why fal ships image-to-video and reference-to-video as separate endpoints. Never write a prompt that assumes a start frame *and* reference images — pick a mode and say which.

Also documented upstream: Seedance 2.0 "do[es] not support directly uploading reference images or videos that contain real human faces." If the user's plan depends on a photo of a real person, flag it rather than writing a prompt that will be rejected.

## Choosing the mode

- **text-to-video** — no assets. The model invents everything. Best for concept boards, spec ads, anything where identity does not have to match something that already exists.
- **image-to-video** — one start frame, optionally an end frame. Use when the look is already locked and you only need motion. `end_image_url` "only works if a first frame image is also provided," and if the two images disagree on aspect ratio, "the first frame image takes precedence, and the last frame image will be automatically cropped to fit."
- **reference-to-video** — up to 9 images + 3 videos + 3 audio, referenced by token. Use for character reuse, motion transfer, style/effect transfer, voice timbre, video editing and extension. This is the mode the whole 2.0 release is built around.
- **video edit or extend, on fal** — there is no dedicated fal endpoint for either. Route to **reference-to-video** with the source clip in `video_urls`, and use the Adding / Removing / Modifying or the Extend pattern in the prompt text. Watch the 2–15 s combined video budget: a 15-second source leaves no room for a second reference clip.
- **`muapi:seedance-v2.0-extend` / `muapi:seedance-v2.0-video-edit`** — use these only when the user is already on a muapi node. Tokens are lowercase there, and on `-extend` the source video's auto-extracted last frame is always `@image1`, so the user's own images start at `@image2`. `-video-edit` takes exactly one source clip and numbers user images from `@image1`. See the parameter tables at the end of this file.

## Choosing the tier

fal, verbatim: "The **only functional difference** between the two tiers is resolution support and cost. Use fast unless you need 1080p." Schema-verified true, with one addition fal does not mention: mini also drops `bitrate_mode`.

| tier | resolutions | use it when |
|---|---|---|
| **mini** | 480p, 720p | iterating on wording; cheapest by a wide margin |
| **fast** | 480p, 720p | the working default for finished 720p |
| **standard** | 480p, 720p, 1080p, 4k | only when you actually need 1080p or 4K |

BytePlus positions the same three: "For the highest generation quality, use Seedance 2.0. For a balance of cost and generation speed when top-tier quality is not required, use Seedance 2.0 fast. For the best cost performance, use Seedance 2.0 mini."

4K is standard-tier only, and it ships as **10-bit H.265/HEVC** — "Some players or browsers may not support direct playback" (VLC, mpv, or QuickTime suggested). Warn the user before recommending it.

## Reference tokens — the trap

Five incompatible spellings exist across the sources. **In this app, write `@ImageA`, `@ImageB`, `@VideoA`, `@AudioA`.**

The node gives every reference pin a *stable* letter token and rewrites it to the positional token fal expects (`@Image1`) at submit time, based on the pin's current slot order. The source comment says why: "Positional tokens are fragile: deleting/reordering a reference shifts every later number, silently breaking the prompt." Literal positional tokens you type are left untouched, so `@Image1` also works — it is just brittle.

For reference outside this app, match the provider:

| source | token form |
|---|---|
| fal API schema (authoritative for fal calls) | `@Image1` `@Video1` `@Audio1` |
| fal model page (feature list and its Tips section) | `[Image1]` `[Video1]` `[Audio1]` |
| Replicate | `[Image1]` `[Video1]` `[Audio1]` |
| muapi | `@image1` … `@image9`, lowercase, plus `@character:<id>` |
| ByteDance / BytePlus (originating lab) | `Image 1`, `@Image 1`, with a space |

fal contradicts itself here — its OpenAPI schema says `@Image1` while its model page, in both the feature list and the Tips section, says `[Image1]`. (fal's separate prompting guide takes no position: it never uses either bracket form.) Neither has been empirically tested. Prefer the schema form. Numbering is always 1-based and positional per modality, in request-array order. ByteDance: "referencing assets by Asset ID is not supported."

## Cost

fal bills per second of output. **Resolution and duration are the only two levers** — fal: "two settings actually move the number: resolution and duration."

| tier | 480p | 720p | 1080p | 4k |
|---|---|---|---|---|
| standard | *no published rate* | **$0.3034/s** | **$0.682/s** | *no published rate* |
| fast | *no published rate* | **$0.2419/s** | — | — |
| mini | **$0.0721/s** | **$0.1547/s** | — | — |

So a 5-second 720p test costs about **$1.52 standard, $1.21 fast, $0.77 mini**. Ten seconds at 1080p standard is **$6.82**.

Underneath, billing is token-based: `(height × width × duration × 24) / 1024` tokens, at $0.014/1k for 480p–1080p standard, $0.008/1k for 4K, $0.0112/1k fast, $0.007/1k mini.

**Three cells have no per-second figure, and you cannot compute one.** The formula needs the output's pixel dimensions, and fal publishes none — only the note that pixel count stays roughly constant across shapes, which fixes no height and width to multiply. So: **for standard 480p, standard 4K and fast 480p, say there is no published per-second rate and quote the token formula and the per-1k token price. Never invent a number.** Two things you can say safely: 480p costs strictly less per second than 720p on the same tier (same token price, fewer pixels), and 4K's cheaper $0.008/1k token price does *not* make it cheap — 4K carries four times the pixels of 1080p, so expect more than double the 1080p per-second cost.

Two things that do **not** move the price: `generate_audio` (fal: "Audio is generated in the same pass and doesn't change the price, so there's no reason to switch it off to save money") and aspect ratio (fal: "the model keeps the total pixel count close to constant across shapes inside a given resolution").

**Reference-to-video with a video input bills the input as well as the output** — the token formula changes to `(input video duration + output video duration)`, so a long reference clip costs real money. How the 0.6× discount applies depends on the tier, and the two behaviours are opposites:

- **standard and fast:** the 0.6× multiplies the *whole* per-second price. 720p works out to **$0.1814/s standard, $0.14515/s fast**, charged across input + output seconds. A 3 s reference plus a 5 s output at standard 720p is 8 × $0.1814 ≈ **$1.45**.
- **mini:** there is **no output discount**. Output bills at the full **$0.0721/s (480p) / $0.1547/s (720p)**, and the video input is charged separately at 0.6× that rate — **$0.0433/s (480p) / $0.0928/s (720p)** — fal: "You will be charged for video input and output, at the rate for the output resolution." The same 3 s + 5 s job at mini 720p is (5 × $0.1547) + (3 × $0.0928) ≈ **$1.05**.

So a video input makes reference-to-video *cheaper per output second* on standard and fast only. On mini it is strictly an addition to the bill — do not tell a mini user their reference clip is discounting the render.

Never silently propose 15 seconds when 5 tells the story. fal's own advice: "Start with 5-second clips at 720p to lock your style, then push the duration or step up to 1080p once the look is right." Do your iteration on **mini at 480p**.

## Core rules

1. **Spend the words on verbs.** If a clause would be equally true of a still photograph, it is wasted.
2. **One camera move per shot.** ByteDance: "Try to specify only 1 type of camera movement in a single shot. Do not require push, pull, pan, and move at the same time, as this will increase image instability."
3. **Always brief the audio**, including silence. "no music", "no voiceover", "room tone only" are real instructions.
4. **Dialogue goes in double quotes** and stays short. fal, Replicate and BytePlus all specify double quotes for lip-sync; keep lines clipped, because "Long monologues drift out of sync." (ByteDance's own worked example uses curly braces `{…}` instead — an inconsistency in the vendor's own material. Use double quotes; that is what three of four sources specify.)
5. **If you want a cut, write "cut to".** fal: "the model honors a shot list far more reliably than it invents one." The threshold for switching format: **one or two beats inside a continuous scene — write them inline with "cut to". Three or more beats, or a change of location or subject — use `Shot 1: / Shot 2: / Shot 3:` ordering.** ByteDance's recommended structure for the latter is "a timeline-based storyboard … who + where + doing what + how the camera moves."
6. **Never give timestamps.** ByteDance: "The model's support for precise timing (such as 0–3 seconds) is unstable, and forcibly limiting duration may lead to abnormal generation results." Order the shots; let the model pace them.
7. **Physics needs a consequence.** fal: "'Leaves scatter on each impact' or 'the mug slides and tips' gives the model something concrete to resolve toward."
8. **Prefer small, continuous movement.** ByteDance: "Prioritize slow, gentle, coherent subtle movements, and try to avoid high-burst, large-dynamic actions such as sprinting, big jumps, and violent rolls." Specify the body part, plus range, speed and force — "slowly raise a hand", "quickly turn the head".
9. **Externalise emotion as physical detail.** Not "she is nervous" but "frequently checking the watch, fingers constantly tapping the tabletop, rapid breathing, eyes darting away" — the vendor's own substitution for nervousness.
10. **Keep it under 600 English words.** The sources disagree and this is the adjudication: BytePlus's own docs say "no more than 500 Chinese characters or 1,000 English words", because longer "will lead to scattered information, and the model may ignore details"; Replicate's field description relays a tighter "under 600 English words" and hard-caps the field at 4,000 characters. Take **600** as the working limit — it satisfies both, and nothing is lost by being shorter. The 4,000-character cap is a field length, not a quality limit.
11. **Never invent assets.** If the shot needs a reference image, an end frame, or a voice clip the user has not supplied, say so instead of writing a prompt that assumes it.
12. **One dialogue language per video.** ByteDance: "The language of dialogue must be consistent, and mixing Chinese and English should be avoided (except for proper nouns)."
13. **Prompt language is a separate question.** BytePlus lists English as supported by all models and Chinese throughout, with the 2.0 series "additionally support[ing] Spanish, Indonesian, Portuguese, and Japanese." That is the language you may *write the prompt in*. No source states which languages the model can *speak* — do not present this list as a set of dialogue languages, and do not promise a user that a spoken line will come back in Japanese because the prompt may be written in it.

## Known failure modes and the prompt-side fix

- **Duplicated characters ("twin effect")** — worst with more than four people or with three-view reference sheets. Fix: bind every role to its image at every mention (`Zhang San@ImageA` … `Li Si@ImageB`), use single-person reference photos, and append the anti-twin constraint sentence verbatim. Also: "Do not directly use the complete script as the prompt."
- **Character ID drift** — caused by a combined reference image where the face occupies too little of the frame. Fix: a separate headshot, face only, "no expression is best". Define the subject explicitly and **place the most precision-critical asset first**: "The more an asset requires precise reference, the earlier it should be placed in the prompt." Multi-view character sheets are explicitly "not recommended" — the model reads the angles as different people.
- **Unrequested subtitles** — cannot be prevented completely. Add an explicit constraint, strip text from the reference assets first, and "prioritize generating videos in landscape size (the probability of generating subtitles in landscape is significantly lower than in portrait)", cropping to portrait afterwards.
- **Style drift toward live action** when references are photoreal but an animated look is wanted. Fix: state the style constraint explicitly; do not leave Look empty.
- **Effects that miss.** Fix: define the effect with a reference video rather than words.
- **More than four reference people.** Generate grouped images of ≤4 first, then feed those as references.
- **Quality decay across repeated extensions.** Convert to a white-model pass first, using the vendor's reference prompt verbatim: `Convert the video into a white 3D model. All characters should be unified as pure white 3D models, with no color, no texture, and no shadows; use a pure white background, stable structure, and smooth motion.`
- **Jump cuts at extension joins** and **click/noise at the end of narrated clips** are post fixes, not prompt fixes — trim 6 frames off the end of the outgoing segment and 1 frame off the start of the incoming one; fade the tail audio. Say so rather than trying to prompt around them.

## Workflow

1. **Establish the mode.** Assets in hand decide it: none → text-to-video; a start frame → image-to-video; references → reference-to-video. Confirm the user is not trying to mix a start frame with references — that combination is rejected.
2. **Pick the tier and resolution.** Default to mini or fast at 720p for iteration. Only reach for standard when 1080p or 4K is genuinely required.
3. **Find the motion and the sound.** If the user described only a look, those are the two gaps — ask about them before anything else, *unless* the brief already implies a standard format (a UGC ad, a talking head, a product turntable). Then assume the obvious motion and mix, and state the assumption in your closing line instead of stalling on a question.
4. **Decide single-take or shot list.** Apply the rule-5 threshold: one or two beats in a continuous scene → one paragraph with "cut to" inline; three or more beats, or a change of location or subject → `Shot 1: / Shot 2: / …` with explicit cuts. No timestamps either way.
5. **Write it** through fal's six layers as prose, then cut every clause that describes a still, every mood adjective, and every parameter that belongs in a field.
6. **Add constraints last** — the anti-twin sentence when people are involved, style constraints when drift is a risk.
7. **Report the settings** you chose — mode, tier, resolution, duration, aspect_ratio, generate_audio — and the cost at the per-second rate for that tier. If the tier/resolution pair you picked has no published per-second rate (standard 480p, standard 4K, fast 480p), say so and quote the token formula rather than inventing a number.

Ask at most three questions, and only where the answer changes the prompt. If the brief is already actionable, write it and list your assumptions in one line.

## Worked example 1 — text-to-video, no assets

**Brief:** "a woman talking about our skincare product, make it feel authentic"

**Weak** — mood words, no motion, no sound, parameters leaking into the text:

> A beautiful cinematic video of a woman holding a skincare bottle, authentic, natural, 8k, masterpiece, vertical 9:16, 10 seconds, high quality

Nothing there is a verb. Nothing there is a sound. "Authentic" and "cinematic" are exactly the words fal names as producing "the most average reading of the scene", and the last three items belong in `aspect_ratio`, `duration` and `resolution`.

**Strong** — fal's six layers as prose, with a cut written out and the mix specified:

> A UGC-style ad shot on a phone. A woman in her late twenties sits on a sunlit sofa holding a small amber skincare bottle, talking straight to camera with the easy energy of a creator. She says: "I'm not going to pretend three drops changed my life, but my skin stopped freaking out, so." She gives a small shrug and a half-smile on the last word. Slightly handheld, natural window light, the warm faintly oversaturated look of a good phone camera, no studio polish. Cut to a short insert of her hands shaking the bottle and a single drop landing on a fingertip, then back to her face. Audio: her voice clear and casual, light room tone, a soft lo-fi beat low in the mix.

*(Adapted from fal's own published example for this pattern. Two edits, both required by the rules above: fal's original opens "A UGC-style ad shot on a phone, **vertical framing**" — "shot on a phone" is a shooting-format cue and stays, but "vertical framing" is the ratio and belongs in `aspect_ratio` — and it writes "a **two-second** insert", which is the timestamp rule 6 forbids. Beat length is carried by shot order instead. Everything else is fal's wording.)*

**What changed and why:**

- **Subject** got concrete — age, posture, what is in her hands — so the model stops averaging.
- **Motion** became verbs with a beat: she talks, shrugs, half-smiles on a specific word. Body part, timing, size of gesture.
- **Dialogue** is one short line in double quotes, which is what triggers lip-sync; short because long lines drift out of sync.
- **Camera** is named ("slightly handheld"), and the cut is spelled out with "Cut to … then back to", which fal says the model honors far more reliably than an invented shot list.
- **Look** replaced "cinematic" with a describable grade — "warm faintly oversaturated look of a good phone camera, no studio polish."
- **Audio** is now a mix brief with three named layers instead of silence, which is what stops the generic score arriving uninvited.
- **Parameters left the prompt.** "9:16" became `aspect_ratio: "9:16"`; "10 seconds" became a `duration` decision, and the answer was 5, not 10 — the beat does not need ten seconds and fal's own advice is to start at five; "8k" was dropped entirely, since 8K is not an option.

Settings: `bytedance/seedance-2.0/fast/text-to-video`, `resolution: "720p"`, `duration: "5"`, `aspect_ratio: "9:16"`, `generate_audio: true`. At $0.2419/s that is about **$1.21**. Iterate on mini at 480p first ($0.0721/s) and move up once the read is right. (`duration: "auto"` is for when the user genuinely has no length in mind — it hands the call to the model and makes the cost a range instead of a number, so do not reach for it by default.)

Assumed: a creator read to camera, one insert cut, one short spoken line, light lo-fi bed — say if you want a voiceover instead, or no music.

## Worked example 2 — reference-to-video, two characters and a motion clip

This is the mode most of this file is about, and the one where the app-specific rules actually bite: token spelling, asset ordering, and the anti-twin sentence.

**Brief:** "Headshot of our founder Marcus, a photo of our head of design Priya, and a 4-second clip of a presenter doing a walk-and-turn to camera. Put the two of them in our lobby doing that walk."

**Assets, in the order they must be connected:** `@ImageA` = Marcus, face-only headshot, neutral expression. `@ImageB` = Priya. `@VideoA` = the 4 s walk-and-turn.

**Prompt:**

> Marcus@ImageA, grey-flecked beard and charcoal knit sweater, walks at an easy pace across a bright office lobby beside Priya@ImageB, black-framed glasses and a cropped dark bob, the two of them mid-conversation. Refer to the walking and turning motion in @VideoA, keeping the motion details consistent. Priya@ImageB says: "The second floor is finally finished." Marcus@ImageA laughs once, then slows and turns to camera as they reach the reception desk, one hand coming to rest on the counter — his badge lanyard swings forward and settles against his chest. Late-morning sun through a glass wall, long soft shadows tracking across polished concrete, a clean corporate documentary look with neutral skin tones and no bloom. The camera holds a slow dolly alongside them at chest height. Audio: two sets of footsteps on hard floor, Priya's line clear and close, low room tone from an open atrium, no music.
>
> Throughout the video, characters with completely identical appearance, clothing, and accessories are prohibited. Do not generate duplicate avatars or a twin effect. Keep only a single corresponding character in the same frame, and do not reproduce repeated copies of characters.

**Why it is written that way:**

- **Every mention is bound.** `Marcus@ImageA` appears three times and carries its token all three times; same for `Priya@ImageB`. ByteDance: "Each time a subject is involved, it must be explicitly referred to to avoid omission." Never `Marcus@Image 1`, never "(corresponding to image 1)" — neither is rewritten, and both reference nothing.
- **The precision-critical asset is first.** Marcus's face is the thing that must match, so he opens the prompt and his headshot goes on the first image pin. "The more an asset requires precise reference, the earlier it should be placed."
- **Each character carries 2–3 stable static features** — beard and sweater, glasses and bob — which is what the vendor asks for, and what keeps identity from drifting mid-walk.
- **The video reference is scoped to motion only,** with the vendor's "keeping the motion details consistent" tail. Without that scope the model tends to import the reference clip's setting and grade as well.
- **The anti-twin sentence is appended verbatim,** because two people appear and character reference images are attached. This is the single most common reference-to-video failure.
- **One camera move** (a slow dolly alongside), and a physical consequence to resolve toward (the lanyard swinging and settling) rather than an adjective.
- **A separate face-only headshot**, not a multi-view character sheet — the model reads sheet angles as different people.

Settings: `bytedance/seedance-2.0/fast/reference-to-video`, `resolution: "720p"`, `duration: "5"`, `aspect_ratio: "16:9"`, `generate_audio: true`. Landscape is deliberate — unrequested subtitles are significantly less likely there than in portrait; crop to vertical afterwards if you need it.

Cost: a video input puts this on the 0.6× reference rate, **$0.14515/s on fast at 720p**, billed across input *and* output seconds. The 4-second reference plus a 5-second output is 9 billed seconds ≈ **$1.31**. Note this discount is a standard/fast behaviour only — if you drop to mini to iterate, the reference clip becomes an *addition* to the bill, not a discount.

## Other providers in this app's catalogue

The fal endpoints above are the reference implementation. If the user is on another provider, the vocabulary changes:

- **Replicate** (`bytedance/seedance-2.0`, `-fast`, `-mini`): `duration` is an **integer**, default `5`, with `-1` for intelligent duration; `aspect_ratio` defaults to `"16:9"` and adds `9:21` and `adaptive`; `seed` **is** accepted; reference fields are `reference_images` / `reference_videos` / `reference_audios` with `[Image1]`-style tokens. Note these three entries are miscategorised in this app's catalogue as capability `text-to-audio`, which can misroute node wiring.
- **muapi** (`seedance-v2.0-t2v`, `-i2v`, `-extend`, `-video-edit`): four parameters each, but **not the same four** — do not send `remove_watermark` to extend or edit, it does not exist there.

  | endpoint | parameters |
  |---|---|
  | `-t2v`, `-i2v` | `aspect_ratio`, `duration` (integer, enum `5`/`10`/`15`), `quality` (`basic`/`high`), `remove_watermark` |
  | `-extend`, `-video-edit` | `aspect_ratio`, `duration` (integer, min 4 max 15), `images_list`, `quality` (`basic`/`high`) — **no `remove_watermark`** |

  `images_list` carries the reference images: up to 8 on `-extend` (mapping to `@image2`…`@image9`), up to 9 on `-video-edit` (`@image1`…`@image9`). On `-i2v` the images arrive as a connectable input rather than a parameter, same 9-image ceiling. Tokens are **lowercase** `@image1`, and a trained character can be referenced as `@character:<id>`. On `-extend`, `@image1` is always the source video's auto-extracted last frame, so user images start at `@image2`.
- `muapi:seedance-v2.0-omni-reference` and `muapi:seedance-v2.0-character` **have no real schema in this app** — the schema route falls back to a generic image-to-image placeholder (single `image_url`, `resolution: 1k/2k/4k`, `seed`), which are not Seedance video fields. Do not write prompts against those two ids; steer the user to a fal reference-to-video endpoint instead.
