---
name: gpt-image-2
description: Write and rewrite prompts for OpenAI GPT Image 2 (openai/gpt-image-2, openai/gpt-image-2/edit, fal-ai/gpt-image-2, replicate openai/gpt-image-2). Use when the user mentions GPT Image 2, gpt-image-2, ChatGPT Images 2.0, GPT Image 2 edit, text-to-image, image-to-image, edit an image, image_size, image_urls, input_images, mask_url, quality low/medium/high/auto, aspect_ratio, num_images, number_of_images, output_format, output_compression, sync_mode, background transparent, transparent background, moderation, inpainting or outpainting with a mask, text-in-image or signage or poster copy, UI mockups, infographics, product mockups, 4K image generation, or asks for a prompt to paste into a GPT Image 2 node. Also use when choosing between GPT Image models — gpt-image-1, gpt-image-1.5, gpt-image-1-mini, "which GPT Image model", "GPT Image 2 vs 1.5", or input_fidelity.
---

# GPT Image 2 Prompt Writer

Act as an art director for **GPT Image 2**. Write prompts that are *specified*, not decorated.

This model is not a tag-soup model. fal positions it as built "for developers that require extreme prompt adherence and text rendering capabilities coupled with general intelligence about the world," and notes it "is capable of reasoning about input text, and is capable of thinking for variable amounts of time depending on the complexity of the prompt." Two things follow, and they drive everything below:

1. **Booster words are dead weight.** "4K, masterpiece, highly detailed, cinematic, trending" buys nothing from a model that follows instructions literally. Resolution is a parameter, not a word. Every token you spend on adjectives is a token not spent on a fact.
2. **What you do not specify, the model decides — and it will decide differently every run.** OpenAI lists Consistency and Composition Control as standing limitations: it "may occasionally struggle to maintain visual consistency for recurring characters or brand elements across multiple generations" and "may have difficulty placing elements precisely in structured or layout-sensitive compositions." Underspecification is the failure mode. The template exists to close it.

## Default prompt template

**This is fal's own template, published on the `openai/gpt-image-2` text-to-image page. Reproduce the labels verbatim** — sentence case, colon, newline, one bracketed line:

```
Scene:
[where this happens, time of day, background, environment]

Subject:
[who or what is the main focus]

Important details:
[materials, clothing, texture, lighting, camera angle, lens feel, composition, mood]

Use case:
[editorial photo / product mockup / poster / UI screen / infographic / concept frame]

Constraints:
[no watermark / no logos / no extra text / preserve face / preserve layout]
```

Five sections, in that order. Do not rename, reorder, pluralise, or add a section. `Important details` and `Use case` are two words each with a lowercase second word.

What each label is actually asking for — several get misread:

- **Scene** is the *container*: place, time of day, background, environment. Not the subject, and not the mood.
- **Subject** is the single focal thing. One subject. If you are writing two, you are writing a composition problem the model is documented to be weak at — put the relationship in `Important details` instead. For inherently multi-element artefacts (UI screens, infographics, posters), see *Layout-sensitive use cases* below: the frame becomes the subject.
- **Important details** is the workhorse and the only section that is a list. It covers materials, clothing, texture, lighting, camera angle, lens feel, composition, and mood. Most of a good prompt lives here.
- **Use case** tells the model what kind of artefact this is — the vendor's own examples are editorial photo / product mockup / poster / UI screen / infographic / concept frame. This is a strong, cheap steer: "poster" and "editorial photo" imply completely different framing, typography, and margin behaviour. Do not skip it.
- **Constraints** is negative and preservation instructions. There is **no `negative_prompt` parameter on any GPT Image 2 endpoint** — this section is the only place exclusions can go.

Drop a section only when you have no fact for it; never emit a label with a placeholder or an empty line under it. An empty label is worse than an absent one.

### Layout-sensitive use cases: UI screens, infographics, posters

Three of the vendor's own `Use case` values — UI screen, infographic, poster — are multi-element artefacts, which collides with "one subject." Resolve it this way rather than refusing the job:

- **Make the frame itself the Subject.** `Subject: A single mobile settings screen.` Not a list of controls. The artefact is one object; its parts are details.
- **Enumerate the elements in `Important details`, in reading order, with explicit relative positions.** "A status bar at the top; below it a title row; beneath that four list rows separated by hairline dividers; a footer button pinned to the bottom edge." Top-to-bottom or left-to-right, never a bare unordered set — order is the only positioning language the model reliably honours.
- **Quote every label verbatim.** Each unquoted label is a label the model invents and may misspell. This is where the text-in-images rules matter most: layout artefacts are almost entirely text.
- **Element count is the risk multiplier.** Precise placement in structured compositions is a documented weakness, and it degrades with element count, not with prompt length. Recommend fewer elements per run, and composing several passes together downstream, over one prompt that specifies twenty.

`Constraints:` earns extra weight here — "no extra UI chrome, no placeholder lorem ipsum, no additional icons" is load-bearing on a model that volunteers labels.

**Scope of this template:** it is published on the GPT Image 2 page specifically. Do not reuse it as a generic GPT Image template for 1.5 / 1 / 1-mini.

**There is no vendor template for editing.** The `/edit` page has no "Default prompt template" section, and neither Replicate nor OpenAI publish one. For edits, use the Edit prompting section below — that guidance is derived from Replicate's "How to get good results" README bullets, which are advice, not a template. Say so rather than silently reshaping the t2i template into an edit template.

## The three variants this app exposes

Exactly three GPT Image 2 ids are in the catalogue. They are not interchangeable.

### A. `fal:openai/gpt-image-2` — text to image

Node handles: **`text` (prompt) only.** No image input.

| Parameter | Type | Default | Enum / range |
|---|---|---|---|
| `prompt` | string | — | required, 2–32,000 chars |
| `image_size` | preset **or** `{width,height}` | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto` |
| `quality` | string | `high` | `auto`, `low`, `medium`, `high` |
| `num_images` | integer | `1` | 1–4 |
| `output_format` | string | `png` | `jpeg`, `png`, `webp` |
| `sync_mode` | boolean | `false` | returns a data URI and excludes the output from request history |

### B. `fal:openai/gpt-image-2/edit` — image to image, with optional mask

Node handles: **`text` (prompt), `image-image_urls` (required, accepts an array), `image-mask_url` (optional).**

Same parameters as A, with two differences: `image_size` defaults to **`auto`** (infer from the input images), and `image_urls` accepts **a maximum of 16 images**.

**The mask field is `mask_url`.** fal's marketing prose and every code sample on both fal pages call it `mask_image_url` — that name appears nowhere in the OpenAPI spec, the API Reference schema, or this app's schema route, all three of which say `mask_url`. The schema wins; the node sends `mask_url`. Anything written from the prose would silently drop the mask.

### C. `replicate:openai/gpt-image-2` — text to image only, in this app

| Parameter | Default | Enum / range |
|---|---|---|
| `prompt` | — | required |
| `aspect_ratio` | `1:1` | `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `1536x1152`, `1152x1536`, `2048x2048`, `2048x1152`, `1152x2048`, `3840x2160`, `2160x3840` |
| `quality` | **`auto`** | `low`, `medium`, `high`, `auto` |
| `number_of_images` | `1` | 1–10 |
| `background` | `auto` | `auto`, `transparent`, `opaque` |
| `output_format` | **`webp`** | `png`, `jpeg`, `webp` |
| `output_compression` | `90` | 0–100, applies to jpeg/webp |
| `moderation` | `auto` | `auto`, `low` |
| `input_images` | `null` | array |
| `openai_api_key` | `null` | string |
| `user_id` | `null` | string |

Two traps here:

- **`input_images` classifies as an array *parameter*, not an input pin.** The Replicate node exposes **no image handle** — you cannot wire an upstream image into it. If the user wants image-to-image, route them to `fal:openai/gpt-image-2/edit`. This is the single most common misrouting.
- **`openai_api_key` renders as a plain parameter field.** Never encourage a user to paste an OpenAI key into a node. The field is optional and the provider proxies without it.

Replicate's README under-reports its own schema (it lists only three aspect ratios and omits `transparent`). The schema above is what the node sends.

### Choosing

- **No input image** → A (fal t2i) or C (Replicate). Prefer A when you want `image_size` presets or an explicit `{width,height}`; prefer C when you want `background`, `moderation`, `output_compression`, or more than 4 images per run.
- **An input image, or several, or a painted mask** → B. It is the only one of the three with an image handle.
- **Transparency** is reachable only on C, and its status is genuinely contradictory — see below.

## Cost, and the real lever

**Cost is token-metered, not flat per run.** There is no `pricing` field on any of the three catalogue entries, so the app cannot compute a cost for GPT Image 2 — quote these vendor tables instead.

fal, text-to-image (per fal's published table):

| Size | Low | Medium | High |
|---|---|---|---|
| 1024 x 768 | $0.005 | $0.037 | $0.145 |
| 1024 x 1024 | $0.006 | $0.053 | $0.211 |
| 1024 x 1536 | $0.005 | $0.042 | $0.165 |
| 1920 x 1080 | $0.005 | $0.040 | $0.158 |
| 2560 x 1440 | $0.007 | $0.056 | $0.222 |
| 3840 x 2160 | $0.012 | $0.101 | $0.401 |

fal, edit — same shape but **including one input image**: 1024x1024 runs $0.015 / $0.061 / $0.219; 3840x2160 runs $0.024 / $0.113 / $0.413. fal states plainly: "Longer prompts increase the cost, more complex requests (involving use of world knowledge, etc.) cost more, and larger images cost more."

Replicate bills **per output image, keyed on `quality`**: `low` $0.012, `medium` $0.047, `high` $0.128, and **`auto` is billed at the `high` rate of $0.128**.

**`quality` is the dominant lever, and the two providers are not comparable — roughly 30× between `low` and `high` at the same size on fal (29× to 35× across the rows above), and about 11× on Replicate ($0.012 → $0.128).** Both defaults land on the expensive end: fal defaults to `high`, Replicate defaults to `auto` which bills as `high`. Say this out loud when proposing settings. OpenAI's own advice: "Use quality: 'low' for fast drafts, thumbnails, and quick iterations."

Secondary levers: image count (`num_images` up to 4 on fal, `number_of_images` up to 10 on Replicate — multiply the per-image price), size, and prompt length. Do not pad a prompt for the sake of looking thorough; on this model verbosity is billed.

## Size rules

For explicit `{width,height}` on fal, or a pixel value in Replicate's `aspect_ratio`, OpenAI's constraints apply and fal repeats them identically:

- Both edges must be **multiples of 16px**
- Maximum edge length **≤ 3840px**
- Long-edge to short-edge ratio **must not exceed 3:1**
- Total pixels **between 655,360 and 8,294,400**

Above 2560x1440 (3,686,400 px) is documented as **experimental**. Square images are typically fastest.

Two caveats to state rather than hide. fal's own "Technical Specifications" table contradicts its own schema twice — it prints "655,3**4**0" as the pixel minimum and "**4000** pixels" as the max side length, against 655,360 and 3840 everywhere else including fal's schema and OpenAI's docs; treat those as typos and use 655,360 / 3840. And fal's own presets `square` (512x512 = 262,144 px) and `landscape_16_9` / `portrait_16_9` (1024x576 = 589,824 px) fall **below** the stated 655,360 floor. No vendor explains whether presets are exempt, upscaled, or rejected. Presets are safe to use; just do not derive the rules from them.

## Text in images

This is the model's headline capability and its most visible failure when the prompt is lazy. fal claims text is integrated "with correct spelling and consistent spacing" across Latin and CJK scripts — but OpenAI still lists text rendering as a limitation: it "can still struggle with precise text placement and clarity."

So: **put the exact copy in quotation marks and describe the typography.** Replicate's README is explicit — 'For readable text in images, put the exact copy in "quotes" and describe the typography. "Bold sans-serif, centered, high contrast" helps ensure legibility.'

- Write `a sign reading "CLOSED FOR THE SEASON"` — never `a sign with a closing message`.
- Name weight, case, alignment, contrast. Typography unspecified is typography randomised.
- Keep copy short. Every additional word of in-image text is another chance to misspell.
- If no text is wanted, say so in `Constraints:` — `no extra text`. The model adds signage and labels to scenes on its own.

## World knowledge

The model reasons about what you name, so name things precisely rather than describing them. Replicate: ask for a scene set in "Bethel, New York in August 1969" and the model understands you want Woodstock. A named place, date, era, material, or camera does more work than a paragraph of adjectives — and costs fewer tokens.

For realism, use photo language rather than quality words: "Shot with a 50mm lens, soft daylight, shallow depth of field" beats "photorealistic, ultra detailed."

## Edit prompting

No vendor template exists for edits. **An edit prompt is a short prose paragraph — two to five sentences, no labels.** Do not reshape the five-section block into an edit template; the block describes an image to invent, an edit describes a change to an image that already exists. Build the paragraph from these four moves, in this order:

1. **State the single change.** One adjustment per run. Replicate: "Start with a base image, then make one adjustment at a time rather than rewriting everything."
2. **Lock everything else, explicitly.** This is the step people skip and the reason edits drift. "Change only the lighting, preserve the subject's face, pose, and clothing." Unlocked attributes are re-decided.
3. **Be concrete about the change.** Not "make it better" — "add soft coastal daylight," "change the red hat to light blue velvet."
4. **Number your references when there are several.** "Apply the style from image 1 to the subject in image 2." Order in the `image_urls` array is the numbering.

Do not tell the user to set `input_fidelity`. It exists on older GPT Image models but **must be omitted for gpt-image-2** — OpenAI states the API doesn't allow changing it because the model processes every image input at high fidelity automatically. There is no fidelity knob, and edit requests with reference images cost more because of it.

### Masks

Only on `fal:openai/gpt-image-2/edit`, via the `image-mask_url` handle. Replicate has no mask parameter at all.

fal's stated convention: **white pixels are the regions the model is allowed to edit; black pixels must be preserved exactly.** The mask must match the dimensions of the input image. With no mask, the model chooses what to change from the prompt alone.

This matches what the app's `maskPainter` node emits (white on black), so `maskPainter` → `image-mask_url` is the right wiring. One unresolved caveat worth flagging to the user rather than asserting either way: OpenAI's direct API additionally requires the mask to carry an **alpha channel** and to match the input's format and size; fal documents only white/black and dimension matching, and whether fal's wrapper synthesises the alpha is not documented. If a mask appears to be ignored, that is the first thing to test.

Also: masking is guidance, not a stencil. OpenAI: "Masking with GPT Image is entirely prompt-based. The model uses the mask as guidance, but may not follow its exact shape with complete precision." Still write the prompt as if describing the whole result — the mask narrows where, the prompt says what. And if several images are passed, **the mask applies to the first one**.

## Transparency — say the contradiction, don't resolve it

Three sources disagree and none of them can be trusted alone:

- OpenAI: transparent backgrounds are "available in preview" for gpt-image-2; use `png` or `webp`, jpeg is not supported with transparency.
- Replicate's README: "GPT Image 2 doesn't support transparent backgrounds. For transparent PNGs, use openai/gpt-image-1.5."
- Replicate's live schema nonetheless offers `background: transparent`.

**fal exposes no `background` parameter at all**, so transparency is unreachable through either fal endpoint in this app. If a user needs guaranteed alpha, tell them it is unverified on GPT Image 2 here and that Replicate's own README points at gpt-image-1.5 instead.

## Do not confuse it with gpt-image-1 / 1.5 / 1-mini

All four are in this app under different ids. Concrete separators:

- **Resolution.** GPT Image 2 takes any resolution meeting the constraints above, up to 4K. The older models are the fixed 1024x1024 / 1024x1536 / 1536x1024 trio.
- **`input_fidelity`** is settable on the older models, and must be omitted on 2.
- **Colour.** fal credits 2 with eliminating "the persistent warm color cast present in GPT Image 1.5."
- **Price is not uniformly better.** At high quality, 1024x1024: 2 = $0.211 vs 1.5 = $0.133 — 2 is *more* expensive at square. At 1024x1536 / 1536x1024: 2 = $0.165 vs 1.5 = $0.200 — 2 is *cheaper* at portrait and landscape. Never claim a blanket "cheaper" or "pricier."
- **Namespace.** GPT Image 2 lives under `openai/`; 1.5 and 1-mini under `fal-ai/`. `fal-ai/gpt-image-2` is a live alias of `openai/gpt-image-2`.

Do not carry the older models' fixed image-token tables onto 2 — it has none published.

## Core rules

1. Fill the five template sections for text-to-image. Underspecification is the failure mode; the template is the fix.
2. Delete every quality booster. No "4K", "masterpiece", "highly detailed", "8k", "trending", "award-winning". Size is a parameter.
3. Do not write the aspect ratio or resolution into the prompt. Set `image_size` / `aspect_ratio`.
4. Exact in-image copy goes in quotation marks, with typography named. Unwanted text goes in `Constraints:`.
5. Prefer a named thing over a described one — place, year, material, lens.
6. One subject, one change. Composition control and multi-generation consistency are documented weaknesses; do not write prompts that depend on them. For layout artefacts, make the frame the subject and enumerate elements in reading order.
7. On edits, name what must not change. Every unlocked attribute is re-rolled.
8. `Constraints:` is the only negative channel — there is no `negative_prompt` on any endpoint.
9. Never route an image into the Replicate variant. It has no image handle.
10. Never suggest pasting an OpenAI API key into the `openai_api_key` field.
11. State the `quality` you chose and what it costs. Both defaults bill at the top rate.

## Workflow

1. **Pick the variant.** Is there an input image or mask? → `fal:openai/gpt-image-2/edit`. Otherwise fal t2i or Replicate; say which and why.
2. **Find the specifics.** Ask what the artefact is for (the `Use case` line), what text must appear verbatim, and what must not change. Those three answers carry most of the quality.
3. **Write it.** Template for t2i; the four edit steps for edits. Then delete every clause that is decoration rather than fact.
4. **Choose settings and say them:** `image_size`/`aspect_ratio`, `quality`, `num_images`, `output_format` — with the cost implication of `quality`.
5. **Recommend `quality: "low"` for the first pass** unless the user is finishing, not exploring.

Ask at most three questions, and only where the answer changes the prompt. If the brief is already actionable, write it and list your assumptions in one line.

## Worked example 1 — text to image (`fal:openai/gpt-image-2`)

**Brief:** "a poster for our coffee shop's autumn menu, make it look premium"

**Weak** — decoration, not specification:

> premium coffee shop poster, autumn menu, cozy vibes, 4k, highly detailed, masterpiece, professional photography, trending on artstation, beautiful lighting

Every one of those tokens after "autumn menu" is a booster the model does not use — and on a token-metered model, they are billed. It names no place, no copy, no typography, no format. The model will invent the text, and invented text is where it misspells.

**Strong** — fal's template, filled with facts:

```
Scene:
A wood-panelled café interior in late afternoon, low autumn sun through a window at frame left, warm shadows falling across a bare oak counter.

Subject:
A single white ceramic pour-over cup on a saucer, centred on the counter, steam rising.

Important details:
Matte ceramic and unfinished oak texture, shallow depth of field as if shot on a 50mm lens at wide aperture, low side light with a soft falloff, generous empty space in the upper third for type. Headline "AUTUMN MENU" in bold condensed sans-serif, centred, high contrast, dark brown on the cream wall. Smaller line beneath reading "Maple Cortado / Spiced Cold Brew". Calm, editorial, unhurried mood.

Use case:
Poster.

Constraints:
No watermark, no logos, no extra text beyond the two lines specified, no people.
```

Settings: `image_size: "portrait_4_3"`, `quality: "low"` for the first pass (about $0.005 per image on fal, versus about $0.145 at `high` — fal's 4:3 row, which it publishes as the 1024x768 transpose), `num_images: 4` to compare compositions, `output_format: "png"`.

What changed and why:

- **"Premium" became specifics.** Matte ceramic, unfinished oak, 50mm at wide aperture, low side light. The model renders materials and optics; it cannot render a price bracket.
- **The copy is now verbatim and in quotes**, with weight, case, alignment and contrast named. That is the difference between a legible headline and a plausible-looking misspelling.
- **`Use case: Poster.`** tells the model to leave margin and treat type as a first-class element — which is also why `Important details` reserves the upper third.
- **`Constraints:` earns its place.** "No extra text beyond the two lines specified" is load-bearing: this model volunteers signage. There is no `negative_prompt` field, so if it is not here it is nowhere.
- **Dropped:** "4k", "masterpiece", "highly detailed", "trending on artstation". Size is `image_size`; the rest mean nothing to an instruction-following model and are billed as prompt tokens.
- **`quality: "low"` first.** Four low-quality drafts cost about $0.02 — roughly a seventh of one `high` image at this size. Pick the composition, then re-run the winner at `high`.

## Worked example 2 — edit (`fal:openai/gpt-image-2/edit`)

**Brief:** "here's a photo of our sofa in the showroom and a swatch of the new green fabric — reupholster it in the green, and make the room feel like morning"

Two images, so two things to fix: the request is two changes, and it names no numbering. Wired as `image_urls` = [sofa photo, fabric swatch].

**Weak** — rewrites the whole scene:

> a beautiful modern living room with a green velvet sofa in soft morning light, cozy and inviting, professional interior photography

This does not edit anything. It describes a new image, so the model produces one: new room, new sofa, new camera. Nothing from the input survives, because nothing was locked and neither input image was referenced.

**Strong** — prose, one change, everything else locked:

> Reupholster the sofa in image 1 using the fabric shown in image 2, matching its colour, weave and sheen exactly, including on the cushions and the piping. Keep the sofa's shape, proportions, leg style and position in the frame identical. Preserve the room, the flooring, the wall, all other furniture, the camera angle and the lens perspective exactly as they are. Change nothing except the sofa's upholstery material.

Settings: `image_size: "auto"` (the edit endpoint's default — it infers from the input and keeps the source framing), `quality: "medium"`, `num_images: 2`, `output_format: "png"`.

What the four steps did:

- **One change.** "Make the room feel like morning" was dropped from this run. Relighting is a second edit; run it on the winning output, not alongside. Say this to the user rather than silently merging the two.
- **The lock list is the longest sentence in the prompt.** It is the edit-mode equivalent of `Constraints:` — shape, legs, position, room, floor, wall, other furniture, camera angle, lens. Every attribute not named here is re-decided on each run, and that is what "the edit drifted" always turns out to be.
- **References are numbered**, and the numbering is the order of the `image_urls` array — image 1 is the first element. Say the wiring out loud when you hand over the prompt, because a reordered array silently inverts the instruction.
- **Concrete about the change.** "Matching its colour, weave and sheen" and the explicit mention of cushions and piping, rather than "in the new green."

**With a mask** (`maskPainter` → `image-mask_url`, white over the sofa only), the prompt barely changes — the lock list can shorten, but the description of the result must not:

> Reupholster the sofa in image 1 using the fabric shown in image 2, matching its colour, weave and sheen exactly. Keep the sofa's shape, proportions and position identical, and preserve the surrounding room exactly.

The mask says *where*, the prompt still says *what the whole result looks like* — masking here is guidance, not a stencil, and the mask applies to the first image in the array.
