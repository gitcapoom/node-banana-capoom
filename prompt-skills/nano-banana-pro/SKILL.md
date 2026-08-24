---
name: nano-banana-pro
description: Write and rewrite prompts for Nano Banana Pro / Gemini 3 Pro Image (gemini-3-pro-image, gemini-3-pro-image-preview, fal-ai/nano-banana-pro, fal-ai/nano-banana-pro/edit, fal-ai/gemini-3-pro-image-preview, google/nano-banana-pro on Replicate, kie nano-banana-pro, muapi nano-banana-pro-edit). Use for text-to-image and image editing prompts: photoreal scenes, product mockups, infographics and data-viz, logos, posters, packaging, accurate text rendering and typography in images, brand consistency, character consistency across up to 5 people, style transfer, inpainting, semantic masking, combining multiple reference images, sketch-to-photo, 360 character turnarounds, comic panels and storyboards. Also use when the user says edit this image, image-to-image, img2img, change or replace the background, remove or add an object, combine two photos, outpaint or expand the frame, uncrop, make or generate an image, text-to-image, negative prompt, reference image, portrait/square/16:9, thumbnail, banner, ad creative, book cover, album art, flyer, menu, UI mockup, or grid upscale with Nano Banana Pro. Also when the user mentions aspect_ratio, resolution 1K/2K/4K, num_images, seed, system_prompt, limit_generations, enable_web_search, safety_tolerance, safety_filter_level, image_urls, image_input, images_list, allow_fallback_model, Google Search grounding, SynthID, thinking level, or asks for a prompt to paste into the Nano Banana Pro node.
---

# Nano Banana Pro Prompt Writer

Act as an art director writing for **Nano Banana Pro** (Google's `gemini-3-pro-image`; this app maps `nano-banana-pro` → `gemini-3-pro-image-preview`). Google's own one-line description: "A professional design engine with a reasoning core for studio-quality 4K visuals, complex layouts, and precise text rendering."

This is not a diffusion model that rewards keyword soup. It is a **thinking model**: Google states "Gemini 3 image models are thinking models that use a reasoning process ('Thinking') for complex prompts. This feature is enabled by default and cannot be disabled in the API." It reasons about composition before rendering, and it reads instructions the way a person reads a brief. Write briefs, not tag lists.

**The failure mode this model is actually prone to** is being handed a Midjourney-style tag string — `beautiful woman, 8k, ultra detailed, masterpiece, trending on artstation, bokeh, --ar 16:9` — when it wanted a sentence that says what the picture *is for* and what is *in* it. Tag soup gives its reasoning core nothing to reason about, and it silently averages toward stock-photo mush. The fix is Google's own first best practice: **"Be hyper-specific."** Google's example: "Instead of 'fantasy armor,' describe it: 'ornate elven plate armor, etched with silver leaf patterns, with a high collar and pauldrons shaped like falcon wings.'"

The second failure mode is **fighting the API with prose**. Never write "16:9", "4K", "make 4 variants", or a `--flag` into the prompt text. Those are fields (`aspect_ratio`, `resolution`, `num_images`), and on fal the default `limit_generations: true` actively suppresses any "make me N images" instruction inside the prompt anyway.

## Prompt templates

**There is no fal "Default prompt template" for this model.** All six fal pages for `nano-banana-pro` and `gemini-3-pro-image-preview` were checked and none exists. Do not invent one and do not present one as fal's.

Google, the originating lab, does publish templates in its image-generation guide, framed as: "This section provides prompt examples and templates for common image generation and editing workflows." Reproduced verbatim below. Pick the one that matches the job, **fill every bracket that describes the picture and delete every bracket that names an API field**, then let the sentence breathe — these are starting shapes, not rigid forms. (Templates 4 and 5 end with `[Aspect ratio].` — that is a field here, so it is one of the brackets you delete. See the bracket glossary.)

### Generating images

**1. Photorealistic scenes** — Google: "Describe a scene in rich detail. The more specific you are, the more control you have over the results."

```
A photorealistic [type of shot] of a [subject description] in a [setting
description]. [Description of the light]. Shot from a [camera angle]
with a [lens type].
```

**2. Stylized illustrations & stickers**

```
A [style] of a [subject, with details about accessories or actions]
doing [activity]. The design features [visual qualities, e.g., bold outlines,
cel-shading, etc.] and [color/background preference].
```

**3. Accurate text in images**

```
Create a [image type] for [brand/concept] with the text "[text to render]"
in a [font style]. The design should be [style description], with a
[color scheme].
```

**4. Product mockups & commercial photography**

```
A high-resolution, studio-lit product photograph of a [product description]
on a [background surface/description]. The lighting is a [lighting setup,
e.g., three-point softbox setup] to [lighting purpose]. The camera angle is
a [angle type] to showcase [specific feature]. Ultra-realistic, with sharp
focus on [key detail]. [Aspect ratio].
```

**5. Minimalist & negative space design**

```
A minimalist composition featuring a single [subject] positioned in the
[bottom-right/top-left/etc.] of the frame. The background is a vast, empty
[color] canvas, creating significant negative space. Soft, subtle lighting.
[Aspect ratio].
```

**6. Sequential art (comic panel / storyboard)**

```
Make a 3 panel comic in a [style]. Put the character in a [type of scene].
```

### Editing images

Google: "These examples show how to provide images alongside your text prompts for editing, composition, and style transfer."

**1. Adding and removing elements**

```
Using the provided image of [subject], please [add/remove/modify] [element]
to/from the scene. Ensure the change is [description of how the change should
integrate].
```

**2. Inpainting (semantic masking)**

```
Using the provided image, change only the [specific element] to [new
element/description]. Keep everything else in the image exactly the same,
preserving the original style, lighting, and composition.
```

**3. Style transfer**

```
Transform the provided photograph of [subject] into the artistic style of [artist/art style]. Preserve the original composition but render it with [description of stylistic elements].
```

**4. Advanced composition: combining multiple images**

```
Create a new image by combining the elements from the provided images. Take
the [element from image 1] and place it with/on the [element from image 2].
The final image should be a [description of the final scene].
```

**5. High-fidelity detail preservation**

```
Using the provided images, place [element from image 2] onto [element from
image 1]. Ensure that the features of [element from image 1] remain
completely unchanged. The added element should [description of how the
element should integrate].
```

**6. Bring something to life**

```
Turn this rough [medium] sketch of a [subject] into a [style description]
photo. Keep the [specific features] from the sketch but add [new details/materials].
```

**7. Character consistency: 360 view**

```
A studio portrait of [person] against [background], [looking forward/in profile looking right/etc.]
```

### What the bracket labels are actually asking for

Several are routinely misread:

- **`[type of shot]`** is framing — close-up, medium shot, wide establishing shot, macro, overhead flat lay. Not "cinematic".
- **`[Description of the light]`** wants a light *source and behaviour*: "hard low winter sun raking from camera left, long shadows". Not "dramatic lighting".
- **`[lens type]`** is a real lens: "85mm portrait lens", "24mm wide-angle", "100mm macro". Google's own advice: "Use photographic and cinematic language... Terms like `wide-angle shot`, `macro shot`, `low-angle perspective`."
- **`[Aspect ratio].`** in templates 4 and 5 is Google's own convention of stating the ratio *in plain English inside the prompt text* ("Aspect ratio 16:9."). Every provider here exposes a real `aspect_ratio` field instead. **Delete this bracket and set the field.** Never write the ratio into the prompt text — that is core rule 4, and it has no exception.
- **`[element from image 1]` / `[element from image 2]`** are positional: image 1 is the first entry in `image_urls` / `image_input` / `images_list`. Reordering the array silently rewrites what every reference means. State the mapping when you write one.
- **`[style description]`** in "Bring something to life" is the *destination* medium ("photorealistic product render", "watercolour"), not the sketch's style.

**Drop any template section that has nothing real to say.** An unfilled bracket left in the prompt is worse than an omitted clause.

fal's schema example prompts are illustrative single-sentence samples, not a template shape — do not treat them as one. For reference, fal's t2i example is: "An action shot of a black lab swimming in an inground suburban swimming pool. The camera is placed meticulously on the water line, dividing the image in half, revealing both the dogs head above water holding a tennis ball in it's mouth, and it's paws paddling underwater." (fal's typos included.)

## Text-to-image vs. editing — which mode

| Use | When |
|---|---|
| **Text-to-image** (no image input) | Nothing exists yet. Prompt carries the whole scene. |
| **Editing** (one or more images in) | Any change to an existing picture, style transfer, compositing references, sketch-to-photo, character/product consistency. |

The endpoints differ by provider:

- **fal** — `fal-ai/nano-banana-pro` (t2i) vs `fal-ai/nano-banana-pro/edit` (requires `image_urls`). `fal-ai/gemini-3-pro-image-preview` and `.../edit` are aliases with byte-identical input schemas.
- **Gemini native (in-app)** — one path; images are attached as `inlineData` parts after the prompt text. Connecting an image switches it to editing.
- **kie / Replicate** — one model each; passing `image_input` switches to editing.
- **muapi** — separate `nano-banana-pro-edit` slug for editing.

**In editing mode, the prompt is a change order, not a scene description.** If a clause would still be true of the input image alone, it is wasted. Say what changes and what must not. See **Worked example 2** at the end for this applied to a two-reference edit.

## Parameters

### fal — `fal-ai/nano-banana-pro` and `/edit`

Verified against this app's schema route, which is authoritative for what the node sends.

| Param | Type | Default | Enum / range | Notes |
|---|---|---|---|---|
| `prompt` | string | — | — | **required** |
| `image_urls` | list\<string\> | — | — | **required on `/edit` only** |
| `aspect_ratio` | enum | `1:1` (t2i) / **`auto`** (edit) | `auto, 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16` | only the default differs between the two |
| `resolution` | enum | `1K` | `1K, 2K, 4K` | **the cost lever — see below** |
| `num_images` | integer | `1` | 1–4 | use this, never a prompt instruction |
| `output_format` | enum | `png` | `jpeg, png, webp` | `webp` exists only on fal |
| `seed` | integer | none | — | set it to iterate on one composition |
| `system_prompt` | string | `""` | — | "Optional system instruction that steers the model's persona and output style across the request." |
| `limit_generations` | boolean | **`true`** | — | fal: "limit the number of generations from each round of prompting to 1... disregard any instructions in the prompt regarding the number of images to generate" |
| `enable_web_search` | boolean | `false` | — | Google Search grounding |
| `safety_tolerance` | enum (string) | `"4"` | `"1"`–`"6"` | "1 is the most strict... 6 is the least strict." fal notes it is API-only; the node still sends it |
| `sync_mode` | boolean | `false` | — | returns a data URI, omits from request history |

#### Using `system_prompt` (and the other three listed-but-inert fields)

`system_prompt` is a real prompt-authoring lever, not a footnote. Split content by **lifespan**:

- **`system_prompt`** holds constraints that persist across a *series* of images — house style, brand palette and typeface, "photography only, never illustration", "never render text unless the prompt asks for it", "no visible logos". Write it once, reuse it across every generation in the batch.
- **`prompt`** holds this image's subject, composition, light and copy. It changes every run.

Put a constraint in `system_prompt` only if it would be true of the next ten images too; otherwise it belongs in the prompt. It exists on **fal and Gemini native only** — on kie, Replicate and muapi there is no such field, so those standing constraints must be folded into the prompt text itself, repeated on every run.

The other three are set-and-forget, not creative controls: **`output_format`** — `png` unless the user needs a small file (`jpeg`) or fal-only `webp`; **`safety_tolerance`** — leave at `"4"`, raise only if a legitimate brief is being blocked, and say so; **`sync_mode`** — leave `false`; `true` only matters if the caller needs a data URI back and wants the result kept out of fal's request history.

### Gemini native (in-app `nano-banana-pro`)

The schema route 404s for this provider (`No schema available for gemini:nano-banana-pro`); these come from app source, which is authoritative for what is sent.

| UI control | Wire field | Default | Values |
|---|---|---|---|
| aspect ratio | `config.imageConfig.aspectRatio` | **`1:1`** | `auto, 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9` |
| resolution | `config.imageConfig.imageSize` | `1K` | `1K, 2K, 4K` |
| seed | `config.seed` | none | integer |
| system prompt | `config.systemInstruction` | none | sent only when non-blank |
| num images | `config.candidateCount` | 1 | 1–4; **only sent when > 1** |
| safety | `config.safetySettings[]` | `default` (omitted) | Block none / Block few (high only) / Block some (medium+) / Block most (low+) |
| thinking | `config.thinkingConfig.thinkingLevel` | `default` (omitted) | `default, low, high` |
| Google Search | `tools: [{ googleSearch: {} }]` | off | boolean |

**`auto` is available but is NOT the node default** — a fresh in-app node seeds `aspectRatio: "1:1"` (`DEFAULT_GENERATE_IMAGE_SETTINGS` in `src/store/utils/localStorage.ts`), so it will force a square onto your input image unless you change it. Selecting `auto` omits the aspect-ratio constraint entirely — the native Gemini API rejects `auto` as a literal value, so the app drops the field. With it omitted, Google says: "By default, the model matches the output image size to that of your input image, or otherwise generates 1:1 squares." **Choose `auto` explicitly when editing**, or the node reframes the input. **Pro does not get the extended `1:4 / 1:8 / 4:1 / 8:1` ratios** — those are Nano Banana 2 only. Image Search grounding is likewise Nano Banana 2 only and is ignored for Pro.

**On thinking level: leave it at `default` for Pro.** The app offers `low`/`high`, but Google documents `thinking_level` only "With Gemini 3.1 Flash Image", with values `minimal` and `high`, and states Pro's thinking "cannot be disabled in the API". Whether Pro accepts the field at all is unverified. Do not recommend changing it.

### Other providers — the defaults are NOT uniform

| | fal | Gemini native | kie | Replicate |
|---|---|---|---|---|
| `resolution` default | `1K` | `1K` | `1K` | **`2K`** |
| output format default | `png` | — | `png` | **`jpg`** |
| aspect default | `1:1` (t2i) / `auto` (edit) | `1:1` | `1:1` | **`match_input_image`** |
| image input key | `image_urls` | inline parts | `image_input` | `image_input` |

Same prompt, different provider, different bill and different framing. Replicate additionally has `safety_filter_level` (`block_low_and_above` / `block_medium_and_above` / `block_only_high`, default `block_only_high`) and `allow_fallback_model` (default `false`) — "Fallback to another model (currently bytedance/seedream-5) if Nano Banana Pro is at capacity", which materially changes both output and price. Replicate has **no** `num_images`, `seed`, `system_prompt`, `limit_generations`, `sync_mode` or web-search field. **kie: the app exposes less than kie does.** kie's own docs list 11 aspect ratios (`1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, auto`, default `1:1`), `1K/2K/4K` (default `1K`) and `png|jpg` (default `png`). This app's schema exposes only a subset — `1:1, 2:3, 3:2, 4:3, 16:9, 9:16, 21:9, auto` — so **3:4, 4:5 and 5:4 are reachable on kie's API but not through the node.** Don't propose them for a kie node.

muapi's `nano-banana-pro` (text-to-image) has **no real vendor schema** — the served response carries the warning `muapi slug-fallback: text-to-image default` and a hand-written shape (`aspect_ratio` `1:1, 4:3, 3:4, 16:9, 9:16` only; `resolution` `1k/2k/4k`; `seed`). Treat every muapi t2i parameter claim as a guess, and never propose `2:3`, `3:2`, `21:9`, `4:5` or `5:4` there. `nano-banana-pro-edit` is different: it resolves against muapi's real OpenAPI spec (no fallback warning) and serves `prompt` + `images_list` (both required), `aspect_ratio` (`1:1, 3:4, 4:3, 9:16, 16:9, 3:2, 2:3, 5:4, 4:5, 21:9` — no `auto`), and `resolution` `1k/2k/4k` default `1k` **lowercase** — muapi's own convention, not Gemini's, which rejects lowercase. muapi-edit has **no** `seed`, `num_images` or web-search field.

### Picking the route

Seven routes serve one model at three prices with different capability sets. If the user has not said which node they are on, pick by need and **state which route you assumed in one line**:

- **Default to the Gemini native in-app path.** Cheapest ($0.134 vs $0.15), and the only route with thinking level, safety settings and `candidateCount`. Remember its aspect default is `1:1`, so set the field deliberately.
- **fal** when you need `num_images` > 1 sharing one seed, `webp` output, or `system_prompt` with a non-Google key. Note `limit_generations: true` by default.
- **kie** when the user is already there — parameter-poor (aspect/resolution/format only, no seed), and the node hides three of kie's ratios. Set only what exists and say so.
- **muapi** likewise parameter-poor; t2i is a guessed schema, so prefer muapi's `-edit` slug, which is real.
- **Avoid Replicate unless the user is already there.** Its 2K default quietly doubles the pixel count versus every other route, and `allow_fallback_model` can silently substitute a different model (`bytedance/seedream-5`) at $0.035 — different output, different look. If they are on Replicate, confirm `allow_fallback_model: false` for anything brand-critical.

## Cost

**Google Developer API: $0.134 per 1K or 2K image, $0.24 per 4K image.** This app's cost table matches exactly. There is no free tier — Google lists "Not available" on every free-tier row.

**1K and 2K cost the same.** Both consume 1120 output tokens; 4K consumes 2000. So:

- **Resolution is the only real cost lever, and it is a two-step lever, not three.** Going 1K → 2K is free. Going 2K → 4K nearly doubles the bill.
- **Default to 2K, not 1K.** Same price, four times the pixels. Only drop to 1K if a downstream node needs the smaller file.
- Reach for 4K only when the output is a final deliverable at print or large-display size. Say so when you propose it.
- `num_images` multiplies the cost. Four variants at 4K is $0.96, not $0.24.

fal charges **$0.15 per image / per edit** (its own markup over Google), and states "4K outputs will be charged at double the standard rate" — spelled out as **$0.30** on its preview-edit page. Replicate: **$0.15** at 1K and 2K, **$0.30** at 4K, and **$0.035** if `allow_fallback_model` kicks in — note Replicate's 2K *default*, so its baseline is a 2K image at 1K's fal price. kie publishes no price in fetchable form.

Grounding with Google Search bills separately: "5,000 free search requests per month (shared across all Gemini 3.x models), then $14 per 1,000 requests."

## Core rules

1. **Be hyper-specific.** Replace every abstract adjective with a describable fact. "Fantasy armor" → the falcon-wing pauldrons. "Modern office" → what's on the desk.
2. **State the purpose.** Google: "Explain the purpose of the image... 'Create a logo for a high-end, minimalist skincare brand' will yield better results than just 'Create a logo.'" This model reasons about intent; give it one.
3. **Use semantic negative prompts.** There is no negative-prompt field. Google: "Instead of saying 'no cars,' describe the intended scene positively: 'an empty, deserted street with no signs of traffic.'" Saying "no X" tends to summon X.
4. **Never put API fields in the prompt.** No `--ar`, no "4K", no "generate 4 versions". Set `aspect_ratio`, `resolution`, `num_images`. **Choosing the ratio:** posters and print → `2:3` or `3:4`; social feed → `4:5`; stories/reels → `9:16`; web hero and presentation slides → `16:9`; cinematic → `21:9`; product-on-white and avatars → `1:1`. **When editing, leave `auto`** unless the user actually wants a reframe — `auto` inherits the input's ratio, and any other value crops or pads their image.
5. **Quote text to be rendered exactly, in straight double quotes**, and name the typographic style. Pro's headline strength is legible typography — but only if you tell it the exact string, the font character, and the hierarchy.
6. **Generate the copy before the image.** Google, verbatim: "When generating text for an image, Gemini works best if you first generate the text and then ask for an image with the text." If the user hasn't settled the wording, settle it first, then write the image prompt around the final string.
7. **Use step-by-step instructions for complex scenes.** Google: "For complex scenes with many elements, break your prompt into steps." Numbered layout instructions beat one long sentence for **infographics, data-viz, and multi-panel layouts** — jobs where many independent elements must each land in a specific place. A single-subject image, including a single-subject poster, stays prose: there is one hero and one type block, and breaking that into steps just fragments a description the model reads better whole.
8. **In editing mode, name what must not change.** "Keep everything else in the image exactly the same, preserving the original style, lighting, and composition" is Google's own inpainting line and it works. Without it, the model re-renders the whole frame.
9. **Never invent assets.** If a composition needs a reference image the user hasn't supplied, say what they need to provide rather than writing a prompt that assumes it.
10. **Don't promise an exact image count.** Google: "The model won't always follow the exact number of image outputs that the user explicitly asks for."

## Reference images

Google: "`gemini-3-pro-image` supports 5 images with high fidelity, and up to 14 images in total." Its reference-image budget table for Gemini 3 Pro Image:

- Up to **6** images of objects with high-fidelity to include in the final image
- Up to **5** images of characters to maintain character consistency
- Up to **3** images to be used as style references

**Google contradicts itself on the high-fidelity count** — the Limitations bullet says 5, the table says 6, on the same page. Plan for 5 to be safe. The 14-image total and the 5-character / 3-style slots are stated consistently.

fal also contradicts itself on the edit endpoint's cap: its `/edit` page claims "Combine up to 14 images in single composition" while the `gemini-3-pro-image-preview/edit` page says "2 images max" / "Up to 2 reference images". The schema declares `image_urls` with no stated maximum. Replicate's field description says "supports up to 14 images". Google's 14-total / 6-object / 5-character / 3-style budget is the reliable figure. kie documents `image_input` as "supports up to 8 images" with `maxItems: 8` in its own schema; this app's registry entry repeats kie's figure faithfully. It is kie's platform cap, lower than Google's 14-image total — so on a kie node, plan for 8.

When you use multiple references, **say in the prompt what each one is for**: "Take the jacket from image 1 and the model's face from image 2." Otherwise the model has to guess which reference is subject, which is style, and which is prop.

## Web search grounding

Turn on `enable_web_search` (fal) / the Google Search toggle (native) only when the image depends on **facts that change** — Google: "generate images based on real-time information, such as weather forecasts, stock charts, or recent events." It bills per search request and adds latency.

Caveat, from Google: "when using Grounding with Google Search with image generation, image-based search results are not passed to the generation model and are excluded from the response." Search brings *facts*, not *pictures*. Do not enable it hoping for visual reference.

## When Pro is the wrong model

Reach for Pro when the job needs: factual grounding via Search; brand consistency and precision creative control; up to 5 characters of resemblance plus up to 3 dedicated style references; interleaved text-and-image output (Pro can "generate interleaved content — like stories or instructional guides containing both text blocks and illustrations inside the same response"); or complex graphic design, infographics and data-viz with accurate typography.

Reach for **Nano Banana 2** (`gemini-3.1-flash-image`) instead when you need speed and cost ($0.067 vs $0.134 at 1K), 512px output, video-to-image input, Google *Image* Search grounding, a controllable thinking level, more high-fidelity object slots (10 vs 6), or the extreme `1:4 / 1:8 / 4:1 / 8:1` ratios Pro does not expose here. Reach for the original **Nano Banana** (`gemini-2.5-flash-image`) for rapid iteration on simple edits — fal prices it at $0.039.

## Other constraints worth knowing

- **No audio or video input.** Google: "Image generation does not support audio inputs. Video inputs are only supported for Gemini 3.1 Flash Image."
- **Languages.** Google: "For best performance, use the following languages: EN, ar-EG, de-DE, es-MX, fr-FR, hi-IN, id-ID, it-IT, ja-JP, ko-KR, pt-BR, ru-RU, ua-UA, vi-VN, zh-CN." Write prompts in English unless the user needs otherwise.
- **Every output carries a SynthID watermark.** Non-negotiable, on all providers.
- **Exact pixel dimensions** (Google's table): 1:1 → 1024²/2048²/4096²; 16:9 → 1376×768 / 2752×1536 / 5504×3072; 21:9 → 1584×672 / 3168×1344 / 6336×2688; 9:16 → 768×1376 / 1536×2752 / 3072×5504; 4:3 → 1200×896 / 2400×1792 / 4800×3584; 3:2 → 1264×848 / 2528×1696 / 5056×3392; 4:5 → 928×1152 / 1856×2304 / 3712×4608. (Google heads this table "3.1 Pro Image" while listing no such model id anywhere — read as Pro's, but flagged.)
- **`image_size` is case-sensitive on the native API.** Google: "You must use an uppercase 'K'... Lowercase parameters (e.g., 1k) will be rejected."
- **No published latency figures.** fal: "Generation times not publicly benchmarked by Google; model optimized for quality rather than speed metrics." Do not quote a generation time.

## Workflow

1. **Read what exists.** Text-to-image or editing? How many reference images, and what is each one *for*? Which provider is the node pointed at (defaults differ)?
2. **Settle any text copy first.** If words will be rendered in the image, agree the exact string before writing the prompt.
3. **Pick a template** from Google's list, or write prose if none fits. Say which you chose.
4. **Write it specifically.** Every abstract adjective replaced by a fact. Purpose stated. Negatives expressed positively.
5. **Cut every clause that belongs in a field** — ratio, resolution, image count, format.
6. **Report only the settings the chosen provider actually exposes** — reporting a field the user's node cannot set is noise:
   - **fal** — `aspect_ratio`, `resolution`, `num_images`, `seed`, `output_format`, `system_prompt`, `enable_web_search`, `limit_generations`, `safety_tolerance`, `sync_mode`
   - **Gemini native** — aspect ratio, resolution, seed, system prompt, num images, safety, thinking, Google Search. **No `output_format`.**
   - **kie** — `aspect_ratio`, `resolution`, `output_format` only. No seed, no `num_images`, no web search.
   - **Replicate** — `aspect_ratio`, `resolution`, `output_format`, `safety_filter_level`, `allow_fallback_model`. No seed, no `num_images`.
   - **muapi-edit** — `aspect_ratio`, `resolution`, `images_list` only. **muapi t2i** — `aspect_ratio`, `resolution`, `seed` (guessed schema).

   Then give the cost: $0.134 (1K/2K) or $0.24 (4K) per image on the Google path, $0.15 / $0.30 on fal and Replicate.

Ask at most three questions, and only where the answer changes the prompt. If the brief is already actionable, write it and list your assumptions in one line.

## Worked example 1 — text-to-image poster

**Brief:** "a poster for our coffee shop's new cold brew, needs to look premium"

**Weak** — tag soup with API fields smuggled into the text:

> coffee poster, premium, cold brew, minimalist, 8k, ultra detailed, professional, beautiful typography, --ar 2:3, no clutter, 4 variations

Everything wrong with it: no purpose, no described subject, no light, "beautiful typography" without a single letter of actual copy, an aspect flag the model will read as literal text, a "no clutter" negative that invites clutter, and a variant request the fal default will suppress.

**Strong** — Google's product-mockup template, filled, with the copy settled first:

```
A high-resolution, studio-lit product photograph for a specialty coffee shop's
cold brew launch poster. A single 12oz clear glass bottle of black cold brew
coffee, condensation beading on the glass, sits on a wet slate-grey stone slab.
The lighting is a three-point softbox setup with a hard rim light from behind
to separate the bottle from the background and make the ice inside glow amber.
The camera angle is a low three-quarter view to make the bottle read tall and
monolithic. Ultra-realistic, with sharp focus on the condensation and the
label's foil edge.

Overlay the text "SLOW COLD" in a wide, high-contrast sans-serif, all caps,
letter-spaced generously, sitting in the upper third. Below it in small
lowercase serif: "18 hours. no heat. no hurry." Both in warm off-white.
The background is a deep charcoal seamless, uncluttered and empty apart from
the bottle and the type.
```

**Settings**, reported for whichever route the node is on — the same prompt bills differently:

- **Gemini native (in-app)** — aspect ratio `2:3`, resolution `2K`, num images `1`. No output-format field on this path. **$0.134**.
- **fal `fal-ai/nano-banana-pro`** — `aspect_ratio: "2:3"`, `resolution: "2K"`, `num_images: 1`, `output_format: "png"`. **$0.15**.

`2:3` because it is a printed poster (rule 4's ratio mapping). Note `2:3` is *not* available on muapi t2i — if the node is pointed there, this brief needs a different route.

**What changed and why:**

- **Purpose named** in the first sentence ("for a specialty coffee shop's cold brew launch poster") — rule 2. The reasoning core now knows it is laying out a poster, not shooting a still life.
- **Every adjective made concrete.** "Premium" became a rim light, condensation, a low three-quarter angle and a foil-edged label. "Minimalist" became a deep charcoal seamless.
- **The copy is written out, in quotes, with a stated hierarchy** — headline weight and case, sub-line weight and case, and where each sits. This is the whole reason to use Pro over a cheaper model, and it does nothing unless you supply the literal string.
- **"no clutter" became "uncluttered and empty apart from the bottle and the type"** — Google's semantic-negative rule.
- **`--ar 2:3` and "8k" left the prompt entirely** and became the `aspect_ratio` field and a `resolution` choice.
- **Resolution set to 2K, not 1K** — identical price, 2048px wide, and a poster needs the pixels. Not 4K, because at $0.24 it doubles the bill for an unapproved first draft; propose 4K for the final once the layout is signed off.
- **`num_images` stayed at 1.** Variants come from re-running with a fixed `seed` and one changed clause, which is how you actually iterate — Google: "Use the conversational nature of the model to make small changes."
- **Written as prose, not numbered steps** — rule 7 deliberately. This is a single hero object plus one type block, not an infographic with many independently-placed elements. Two paragraphs (the photograph, then the typography) give the reasoning core a whole description to compose from. Break into numbered steps when there are five things that each need their own position.

## Worked example 2 — editing with two references

**Brief:** "put the jacket from the first photo on the model in the second one"

Two images in, so this is the **edit** endpoint (`fal-ai/nano-banana-pro/edit`, or an image connected to the in-app node).

**Weak** — re-describes the input images instead of ordering a change:

> A photorealistic studio portrait of a young woman with shoulder-length dark
> hair standing against a pale grey seamless backdrop, soft three-point
> lighting, wearing a cropped olive-green bomber jacket with ribbed cuffs.
> High quality, detailed fabric, 8k.

Everything wrong with it: every clause is *already true* of image 2 (the model, her hair, the backdrop, the light) or image 1 (the jacket) — so it spends the whole prompt describing what the model can already see, and says nothing about what should *change*. It never says which image contributes what, so the model must guess whether the jacket is subject, style or prop. And because nothing is marked as must-not-change, the model re-renders the whole frame: a new face, a new backdrop, a new pose.

**Strong** — Google's high-fidelity detail-preservation template, filled, with the image order swapped to match how the user supplied them (jacket first) and the mapping stated in the text:

```
Using the provided images, place the olive-green bomber jacket from image 1
onto the woman in image 2. Ensure that the woman's face, hair, pose and the
pale grey seamless backdrop of image 2 remain completely unchanged. The jacket
should sit naturally on her shoulders with the front open, the ribbed cuffs
falling at her wrists, and its folds and shadows relit to match the existing
soft three-point lighting of image 2. Keep everything else in the image
exactly the same, preserving the original style, lighting, and composition.
```

**Settings** — fal `/edit`: `aspect_ratio: "auto"` (the `/edit` default — inherits image 2's framing), `resolution: "2K"`, `num_images: 1`. **$0.15**. On the in-app Gemini path you must **select `auto` yourself**, because that node defaults to `1:1` and would crop the portrait square.

**What changed and why:**

- **It is a change order, not a scene description.** One clause moves the jacket; everything else either names the mapping or names what must be preserved. No clause is merely true of an input already.
- **The image-N mapping is written into the prompt text** — "from image 1", "the woman in image 2". Image 1 is the first entry in `image_urls`; reorder the array and this prompt silently means something else. State the order when you hand it over.
- **What must not change is named explicitly** (rule 8): face, hair, pose, backdrop — plus Google's own preservation line. Without it the model re-renders the frame.
- **The integration is specified**, not left to chance: front open, cuffs at the wrists, folds and shadows relit to image 2's existing light. This is the clause that makes a composite read as one photograph.
- **`aspect_ratio` is `auto`**, so the output inherits the input framing rather than being reframed.
