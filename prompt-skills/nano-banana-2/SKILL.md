---
name: nano-banana-2
description: Write and rewrite prompts for Nano Banana 2 (Google gemini-3.1-flash-image / gemini-3.1-flash-image-preview) and Nano Banana 2 Lite (gemini-3.1-flash-lite-image), text-to-image and image editing. Use when the user mentions Nano Banana 2, nano-banana-2, nanobanana, nano banana, NB2, nano banana 2 lite, nano banana lite, Gemini 3.1 Flash Image, fal-ai/nano-banana-2, fal-ai/nano-banana-2/edit, fal google/nano-banana-2-lite, google/nano-banana-2 or google/nano-banana-2-lite on Replicate, muapi nano-banana-2 or nano-banana-2-edit, or asks about image_urls, image_input, images_list, audio_url, pdf_url, video_url / YouTube reference, aspect_ratio, match_input_image, resolution 512/0.5K/1K/2K/4K, num_images, seed, system_prompt, thinking_level, limit_generations, safety_tolerance, output_format, sync_mode, negative_prompt, enable_web_search, google_search, image_search grounding, SynthID watermark, reference images, character consistency, 360 character turnaround, inpainting, semantic mask, background replacement, outfit swap, photo restoration, combine two images, multi-image composite, style transfer, product mockup, logo or in-image text, negative space or text-overlay plate, video thumbnail, sticker, comic panel, storyboard, or wants a prompt to paste into a Nano Banana 2 node.
---

# Nano Banana 2 Prompt Writer

Act as an art director writing for **Google's `gemini-3.1-flash-image`** (fal calls it Nano Banana 2). This is not a diffusion model that weights tags. fal's own description: it "understands creative intent holistically rather than matching keywords." Google adds that Gemini 3 image models are **thinking models** — "This feature is enabled by default and cannot be disabled in the API" — that reason about composition before rendering, generating "up to two interim images to test composition and logic."

So the prompt should read like a brief to a photographer or illustrator: a described scene with stated intent, in sentences. Not `masterpiece, 8k, highly detailed, trending on artstation`.

The two failure modes this model is actually prone to:

1. **Keyword soup.** Quality tags do nothing for a reasoning model. Every token spent on `8k, cinematic, award-winning` is a token not spent describing the subject, the light, or the lens. Replace them with the specific thing they gesture at.
2. **Unstated preservation on edits.** Ask it to change one thing and it will happily re-render the rest. Google's inpainting template exists precisely for this — the sentence "Keep everything else in the image exactly the same" is load-bearing, not filler.

## Vendor prompt templates

**fal publishes no prompt template for any Nano Banana 2 endpoint** — not on `fal-ai/nano-banana-2`, `/edit`, `google/nano-banana-2-lite`, or their `/api` sub-pages. Do not invent one and attribute it to fal. (`google/nano-banana-lite` is the *first-generation* Nano Banana Lite, a different model — do not cite it as an NB2 endpoint.)

The templates below are **Google's own**, from the "Prompting guide and strategies" section of the Gemini image-generation docs. Google labels each block "Template". Reproduce the shape verbatim; fill the bracketed slots.

### Generating images

**1. Photorealistic scenes**

```
A photorealistic [type of shot] of a [subject description] in a [setting
description]. [Description of the light]. Shot from a [camera angle]
with a [lens type].
```

- `[type of shot]` — framing, not genre: *wide-angle shot, macro shot, medium close-up*.
- `[Description of the light]` — a whole sentence is expected, not one adjective. Direction, quality, source, time of day.
- `[lens type]` — an actual lens: *35mm lens, 85mm portrait lens, wide-angle lens*. Not "DSLR", not "bokeh".

**2. Stylized illustrations & stickers**

```
A [style] of a [subject, with details about accessories or actions]
doing [activity]. The design features [visual qualities, e.g., bold outlines,
cel-shading, etc.] and [color/background preference].
```

- `[color/background preference]` is where you kill the default background. Say "The background must be white" if you want a cut-out asset.

**3. Accurate text in images**

```
Create a [image type] for [brand/concept] with the text "[text to render]"
in a [font style]. The design should be [style description], with a
[color scheme].
```

- `"[text to render]"` — put the literal string in quotes, spelled exactly. This is the only slot where the model is copying, not interpreting.
- `[font style]` is descriptive prose, not a font name: *clean, bold, sans-serif*.

**4. Product mockups & commercial photography**

```
A high-resolution, studio-lit product photograph of a [product description]
on a [background surface/description]. The lighting is a [lighting setup,
e.g., three-point softbox setup] to [lighting purpose]. The camera angle is
a [angle type] to showcase [specific feature]. Ultra-realistic, with sharp
focus on [key detail]. [Aspect ratio].
```

- `[lighting purpose]` is a real slot people skip. Google's own example: "to create soft, diffused highlights and eliminate harsh shadows." State what the light is *for*.
- `[Aspect ratio]` — see the aspect-ratio note below. Prefer the `aspect_ratio` parameter.

**5. Minimalist & negative space design**

```
A minimalist composition featuring a single [subject] positioned in the
[bottom-right/top-left/etc.] of the frame. The background is a vast, empty
[color] canvas, creating significant negative space. Soft, subtle lighting.
[Aspect ratio].
```

- Use this when the image is a *plate* for overlaid text. Name the corner the subject sits in, so the empty half is predictable.

**6. Sequential art (comic panel / storyboard)**

```
Make a 3 panel comic in a [style]. Put the character in a [type of scene].
```

- Deliberately terse — Google notes these "work best with Gemini 3 Pro and Gemini 3.1 Flash Image." Character identity comes from an attached reference image, not from more adjectives.

**7. Grounding with Google Search** — no Template block published. Google's example prompt only:

```
Make a simple but stylish graphic of last night's Arsenal game in the Champion's League
```

### Editing images

**1. Adding and removing elements**

```
Using the provided image of [subject], please [add/remove/modify] [element]
to/from the scene. Ensure the change is [description of how the change should
integrate].
```

- `[description of how the change should integrate]` is the whole job. "Make it look like it's sitting comfortably and matches the soft lighting of the photo." Integration beats description.

**2. Inpainting (semantic masking)**

```
Using the provided image, change only the [specific element] to [new
element/description]. Keep everything else in the image exactly the same,
preserving the original style, lighting, and composition.
```

- **No mask input exists.** The word "only" plus the preservation sentence *is* the mask. Never drop the second sentence.

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

- Images are referenced **by position** — "the first image", "the second image". Reordering the array silently rewrites the prompt's meaning. State the ordering you assume.

**5. High-fidelity detail preservation**

```
Using the provided images, place [element from image 2] onto [element from
image 1]. Ensure that the features of [element from image 1] remain
completely unchanged. The added element should [description of how the
element should integrate].
```

- Google's instruction for this one: to protect a face or logo through an edit, "describe them in great detail along with your edit request." Describing what must *not* change is what protects it.

**6. Bring something to life**

```
Turn this rough [medium] sketch of a [subject] into a [style description]
photo. Keep the [specific features] from the sketch but add [new details/materials].
```

**7. Character consistency: 360 view**

```
A studio portrait of [person] against [background], [looking forward/in profile looking right/etc.]
```

- Iterative by design. Google: "include previously generated images in subsequent prompts to maintain consistency."

### When not to use a template

These are scaffolds, not a required format. A short, specific, well-lit sentence beats a half-filled template. Drop any slot you have nothing real for — an empty bracket is worse than an absent one. Say which template you used, or say you wrote prose.

## Which endpoint

**Establish the provider before you write anything.** The eight NB2 modes this app actually serves (verified against its live model catalogue) differ in which fields exist, so a settings report written for the wrong provider names controls the user cannot find.

| provider · model id | t2i | edit | the fields that distinguish it |
|---|---|---|---|
| **`gemini:nano-banana-2`** | yes | yes (same model) | `512` res tier, **Image Search toggle**, seed, system prompt, num images, safety, thinking. No `output_format`. |
| `fal:fal-ai/nano-banana-2` | yes | — | `0.5K`, `system_prompt`, `output_format`, `thinking_level`, `limit_generations`, `safety_tolerance`, `sync_mode` |
| `fal:fal-ai/nano-banana-2/edit` | — | yes | the above **plus** `image_urls`, `video_url`, `audio_url`, `pdf_url` |
| `fal:google/nano-banana-2-lite` | yes | — | fixed 1K: no `resolution`, no `enable_web_search`, no media inputs |
| `replicate:google/nano-banana-2` | yes | via `image_input` | `image_search` boolean; **no** seed / num_images / system_prompt / thinking_level / media inputs |
| `replicate:google/nano-banana-2-lite` | yes | via `image_input` | only `aspect_ratio` + `output_format`. Fixed 1K, no grounding at all |
| `muapi:nano-banana-2` | yes | — | `google_search`; lowercase `1k/2k/4k`; `Auto` ratio; no seed |
| `muapi:nano-banana-2-edit` | — | yes | as above plus `images_list` (array) |

**Choosing:**

- **Gemini-native** when the user is on this app's default Generate node (`GenerateImageNode` hardcodes the three Gemini image models, so this is the path unless they have deliberately switched provider), or when they need the Image Search toggle or the 512 tier.
- **fal** when you need video / audio / PDF input, `system_prompt`, `thinking_level`, or four images in one call — it is the only provider carrying all of those.
- **Replicate** when `image_search` is the only extra you need; accept the loss of seed, `num_images`, `system_prompt` and `thinking_level`.
- **MuAPI or Lite** for cheap 1K volume. **Never for character consistency** — Lite has no character-consistency support, and MuAPI exposes no seed to iterate with.

**Lite is text-to-image in this app.** The catalogue lists `fal:google/nano-banana-2-lite` and `replicate:google/nano-banana-2-lite` as text-to-image only; there is no fal `google/nano-banana-2-lite/edit` entry to select, even though fal's own API resolves that path. Replicate's lite schema does still accept `image_input`, so light editing is reachable there.

Formally, on fal's `/edit` schema **only `prompt` is required** — `image_urls` is documented "Optional when at least one of `video_url`, `audio_url`, or `pdf_url` is provided." In practice, if there is no media of any kind, you want the text-to-image endpoint.

## Parameters — fal (`fal-ai/nano-banana-2` and `/edit`)

Names, defaults and enums are verified identical between fal's embedded OpenAPI and this app's own `/api/models` schema route. Two differences to know: the length limits below come from fal's OpenAPI only — the app route carries no string-length constraints — and the app route surfaces `pdf_url` as a *parameter* rather than as an input handle alongside `video_url` / `audio_url`.

| field | type | default | range / enum |
|---|---|---|---|
| `prompt` | string | — | **required**, min 3 chars, max 50000 |
| `image_urls` | string[] | unset | `/edit` only |
| `video_url` | string | unset | `/edit` only; max 15MB inline, or a YouTube URL passed through undownloaded |
| `audio_url` | string | unset | `/edit` only; max 15MB |
| `pdf_url` | string | unset | `/edit` only; max 15MB |
| `aspect_ratio` | string | `auto` | `auto, 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 4:1, 1:4, 8:1, 1:8` |
| `resolution` | string | `1K` | `0.5K, 1K, 2K, 4K` — **the cost lever** |
| `num_images` | integer | `1` | 1–4 |
| `output_format` | string | `png` | `jpeg, png, webp` |
| `seed` | integer | unset | reuse to reproduce a result |
| `system_prompt` | string | `""` | max 50000; sent as Gemini's system instruction |
| `thinking_level` | string | unset | `minimal, high` |
| `limit_generations` | boolean | **`true`** | see below |
| `enable_web_search` | boolean | `false` | billable surcharge |
| `safety_tolerance` | string | `"4"` | `"1"`–`"6"`; fal marks it non-editable in its own UI |
| `sync_mode` | boolean | `false` | returns a data URI, no request history |

**There is no `negative_prompt` on any provider.** See "Negatives" below.

## Parameters — Gemini-native node (this app)

This node has **no published schema** (`/api/models/nano-banana-2?provider=gemini` returns `No schema available`); its controls are hardcoded, so they are listed here. Report *these* names for a user on the default Generate node.

| control | values | sent as |
|---|---|---|
| Aspect Ratio | 15: `auto, 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9` | `imageConfig.aspectRatio`; `auto` omits the constraint entirely |
| Resolution | `512, 1K, 2K, 4K` | `imageConfig.imageSize` |
| Seed | integer, blank = random | `seed` |
| Images | 1–4 | `candidateCount` |
| Safety | Default / Block none / Block few / Block some / Block most | `safetySettings` on all categories |
| Thinking | Default / Low / High | `thinkingConfig.thinkingLevel` |
| System Prompt | free text | `systemInstruction` |
| Google Search ☑ | boolean | `tools[0].googleSearch.searchTypes.webSearch` |
| Image Search ☑ | boolean | `tools[0].googleSearch.searchTypes.imageSearch` |

**Do not put fal-only fields in a settings report for this node.** `output_format`, `sync_mode`, `limit_generations`, `safety_tolerance`, and the `video_url` / `audio_url` / `pdf_url` inputs do not exist here. Note also that the Thinking dropdown offers **Low**, while Google documents the levels as `minimal` and `high` — name the dropdown label the user sees.

### Provider differences that will bite you

- **`auto` is spelled differently everywhere.** fal `auto`; Replicate `match_input_image`; MuAPI `Auto`. MuAPI's text-to-image default is `1:1`, its edit default is `Auto`, fal's is `auto`, Replicate's is `match_input_image`.
- **`output_format` default differs:** fal `png`, Replicate `jpg`, MuAPI `jpg`. Only fal offers `webp`.
- **`0.5K` is fal/Gemini-only, and the two spell it differently.** fal's enum value is `0.5K`; this app's Gemini node calls the same tier **`512`** (and its cost table is keyed on `"512"`). Reporting `resolution: "0.5K"` to a Gemini-node user names a value that is not in the dropdown — use the spelling that matches the endpoint you are reporting. Replicate's enum is `1K, 2K, 4K`; MuAPI's is `1k, 2k, 4k` (lowercase).
- **Replicate has `image_search`, fal does not.** Replicate's own note: "When enabled, web search is also used automatically." Replicate drops `num_images`, `seed`, `system_prompt`, `thinking_level`, `limit_generations`, `safety_tolerance`, and all video/audio/PDF inputs.
- **Lite drops `resolution`, `enable_web_search`, and all video/audio/PDF inputs.** Google: "Gemini 3.1 Flash Lite Image only supports 1K resolution" and grounding is "Not supported by Gemini 3.1 Flash Lite Image model."
- **This app's Gemini-native node has no published parameter schema** — its controls are hardcoded and are tabulated above under "Parameters — Gemini-native node". Note that the app currently maps `nano-banana-2` to the model id `gemini-3.1-flash-image-preview`, while Google's models page lists `gemini-3.1-flash-image` as Stable — flag it if a request against the preview id fails.

## Cost

**fal, verbatim:** "Your request will cost **$0.08** per image… 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged."

| resolution | fal / image | Google direct / image |
|---|---|---|
| 0.5K (512px) | $0.06 | $0.045 |
| 1K | **$0.08** | **$0.067** |
| 2K | $0.12 | $0.101 |
| 4K | $0.16 | $0.151 |

**The cost lever is `resolution` × `num_images`**, and they multiply: four 4K images is $0.64 on fal against $0.08 for one 1K. Draft and iterate at 1K (or 0.5K — spelled `512` on the Gemini node); go to 2K/4K only for the final. Do not silently propose 4K.

`enable_web_search` adds $0.015 on fal — fal does not state whether that surcharge is per request or per image, so do not quote a per-image web-search cost for a multi-image batch. Google direct bills grounding at $14 per 1,000 search requests after 5,000 free per month, and warns one request "may result in one or more queries." `thinking_level: "high"` adds $0.002 on fal.

Lite is token-metered, not per-image: fal quotes "$0.3125 input, $37.50 output" per 1M image tokens with "Output images… generated at a fixed 1K"; Google direct works out to $0.0336 per 1K image.

## Core rules

1. **Write sentences, not tags.** Google: "Be hyper-specific." Instead of "fantasy armor," their own counter-example describes "ornate elven plate armor, etched with silver leaf patterns, with a high collar and pauldrons shaped like falcon wings."
2. **State the purpose.** Google: "Create a logo for a high-end, minimalist skincare brand" beats "Create a logo." The model uses intent.
3. **Use semantic negatives.** There is no negative-prompt field. Google's instruction: instead of "no cars," write "an empty, deserted street with no signs of traffic." Never write `no X` or a comma-list of banned things — it can summon them.
4. **Control the camera in photographic language.** Google names `wide-angle shot`, `macro shot`, `low-angle perspective`. One named framing, not "cinematic."
5. **On any edit, name what must not change.** "Keep everything else in the image exactly the same, preserving the original style, lighting, and composition."
6. **Never ask for a number of images in the prompt.** `num_images` is a parameter. Google warns "The model won't always follow the exact number of image outputs that the user explicitly asks for," and fal's `limit_generations` defaults to `true`, which will "disregard any instructions in the prompt regarding the number of images to generate."
7. **Put aspect ratio in the parameter, not the prose.** Google's templates 4 and 5 do have an `[Aspect ratio]` slot and their example prompts say "Aspect ratio 16:9." / "Square image." — harmless, but the `aspect_ratio` parameter is the deterministic control. Use the slot only when the caller cannot set parameters.
8. **For in-image text, settle the copy first.** Google: "When generating text for an image, Gemini works best if you first generate the text and then ask for an image with the text." Bring the final string, quoted, into the prompt.
9. **Step through complex scenes.** Google endorses ordered instructions: background first, then foreground, then the hero element.
10. **Iterate conversationally.** Google: "Keep everything the same, but change the character's expression to be more serious." A follow-up edit beats a rewritten prompt.
11. **Prefer a best-performance language.** Google: "For best performance, use the following languages" — EN, ar-EG, de-DE, es-MX, fr-FR, hi-IN, id-ID, it-IT, ja-JP, ko-KR, pt-BR, ru-RU, ua-UA, vi-VN, zh-CN.
12. **Never invent an input.** If the brief needs a reference image, a logo file or a source photo the user has not supplied, say so instead of writing a prompt that assumes it.

## Reference images

Google's table, "Use up to 14 reference images" — 14 total across all types, with per-type caps:

| | 3.1 Flash Lite | **3.1 Flash (NB2)** | 3 Pro |
|---|---|---|---|
| high-fidelity objects | up to 14 | **up to 10** | up to 6 |
| character consistency | N/A | **up to 4** | up to 5 |
| style references | N/A | **N/A** | up to 3 |

Two things to act on: NB2 has **no style-reference slot** — style comes from prose, so describe it rather than promising a style image will do the work. And **Lite has no character-consistency support at all**; do not route a consistent-character job to Lite.

*Sources disagree on the character count.* fal's marketing page says "Maintain identity for up to 5 people across generations"; Google's own limitation says `gemini-3.1-flash-image` "supports character resemblance of up to 4 characters." Five is the Pro figure. **Plan for 4.**

Both Replicate endpoints describe `image_input` as supporting "up to 14 images"; fal's page says "up to 14 reference images for editing."

## Grounding

Web search grounds the image in current facts — scores, weather, recent events. Enable it only when the prompt genuinely depends on something the model cannot know, and say why, because it is billed.

Image Search is a separate search type: Google's instruction is to "configure the `google_search` tool… and specify `image_search` within the `search_types` array. Image Search can be used independently or together with Web Search."

**In this app's Gemini node it is a first-class checkbox.** Google Search and Image Search are two independent toggles, mapped to `searchTypes.webSearch` and `searchTypes.imageSearch` on the `googleSearch` tool. Tell the user to tick Image Search; **do not write "use image search" into the prompt** for this node.

On Replicate it is the `image_search` boolean, which turns web search on too. **fal exposes no image-search field** — only `enable_web_search`. Only there is the prose form the right answer, and Google's own NB2 example shows its shape: "Use image search to find accurate images of a resplendent quetzal bird. Create a beautiful 3:2 wallpaper of this bird…"

Hard limit: `gemini-3.1-flash-image` "Grounding with Google Search does not support using real-world images of people from web search at this time." Do not build a prompt around grounding to a named living person's likeness.

## Thinking

Google: the default `thinking_level` is `minimal`, and the supported levels are `minimal` and `high`. Thinking itself "is enabled by default and cannot be disabled in the API." **fal's field description says "Omit to disable," which contradicts Google** — omitting it leaves the default `minimal`, it does not turn thinking off. Raise to `high` for complex multi-element compositions or precise typography, and only then: it costs an extra $0.002 on fal and adds latency.

## Other things the schema tells you

- **`system_prompt`** (fal only, max 50000 chars) carries persona and style that should hold across a batch — house look, brand rules. Keep the per-image prompt about *this* image. Do not duplicate content between the two.
- **`seed`** reproduces a result. When a user likes one image out of four, the seed is how they iterate on it. Not available on Replicate or MuAPI's live schema.
- **`safety_tolerance`** is `"4"` by default, `"1"` strictest to `"6"` loosest — but fal marks it non-editable in its own playground, and no source documents whether an API-supplied value is honoured. Do not promise it as a fix.
- **The response includes text.** fal's output shape is `{ images, description }`, and Google notes "The model defaults to returning both text and image responses." Expect prose alongside the image; it is not an error.
- **Every output carries a SynthID watermark.** Google and fal both state this. It cannot be turned off.
- Audio input is accepted by fal's `/edit` (`audio_url`) but Google's own limitation reads: "Image generation does not support audio inputs." So: **never write a prompt whose content depends on the audio.** If the user has already attached `audio_url`, keep the prompt fully self-sufficient without it and tell them the model may ignore it. Do not propose `audio_url` as a way to supply information.
- **`pdf_url`** (fal `/edit`, max 15MB) is document context, not a page to reproduce. Use it when a brand guide or spec sheet should inform the image, and still describe in the prompt what you want rendered — do not write "use the layout from the PDF" and leave the prompt empty of that layout.
- Video input is **NB2-only** ("Video inputs are only supported for Gemini 3.1 Flash Image") and is genuinely useful for thumbnails and posters — Google frames it as "creating high-quality video thumbnails, cinematic posters, summary infographics."

## Resolution and framing

Aspect ratio is chosen, not implied. Google: "By default, the model matches the output image size to that of your input image, or otherwise generates 1:1 squares." Token cost is flat per tier regardless of ratio — 0.5K = 747 tokens, 1K = 1120, 2K = 1680, 4K = 2520 — so an extreme ratio is not more expensive, just differently shaped. Sample dimensions at 1K: `1:1` 1024x1024, `16:9` 1376x768, `9:16` 768x1376, `2:3` 848x1264, `21:9` 1584x672, `4:1` 2048x512, `1:8` 384x3072.

Note fal's marketing table lists only 11 aspect ratios; the actual schema enum has 15, adding the extreme `4:1, 1:4, 8:1, 1:8`. The schema wins. Same for 0.5K, which fal's edit-page spec table omits but the schema and the pricing string both include.

## Workflow

1. **Read what exists, and settle the provider.** Images attached? A video or YouTube URL? Then it is an edit. Text only? Text-to-image. Then pick the row in "Which endpoint" — if the user has not said, assume this app's Gemini node and say so, because the field names in your report depend on it.
2. **Pick the template** that matches the job — photoreal, illustration, text-in-image, product, negative-space, sequential, or one of the seven editing shapes. Name it.
3. **Write it in sentences.** Fill only the slots you have real answers for.
4. **Strip.** Delete every quality tag, every `no X`, every request for a number of images, every aspect-ratio phrase that duplicates the parameter.
5. **On edits, add the preservation clause** naming exactly what must survive.
6. **Report the settings** — **name the endpoint first**, then `aspect_ratio`, `resolution`, `num_images`, seed if set, and any thinking / search setting — with the cost. Use only fields that exist on that endpoint, spelled as that endpoint spells them.

Ask at most three questions, and only where the answer changes the prompt. If the brief is actionable, write it and list your assumptions in one line.

## Worked example

**Brief:** "product shot of our matte black ceramic mug, make it look premium"

**Weak** — keyword soup with a self-defeating negative:

> matte black ceramic mug, premium, luxury, 8k, ultra detailed, professional product photography, studio, cinematic lighting, sharp, masterpiece, no clutter, no background

Nothing here is a decision. "Premium" and "luxury" are outcomes, not instructions. "Studio" and "cinematic lighting" contradict each other. "8k" is not a resolution the model reads — `resolution` is. And "no clutter, no background" is exactly the negative phrasing Google warns against; it names the things you do not want.

**Strong** — Google's product-mockup template, every slot answered except `[Aspect ratio]`, which moves to the parameter (rule 7), plus one appended sentence carrying the semantic negative:

```
A high-resolution, studio-lit product photograph of a minimalist matte black
ceramic mug with a thin, unglazed rim, on a polished light-grey concrete
surface. The lighting is a three-point softbox setup with a large key from
camera-left, positioned to wrap the matte glaze in a soft gradient and
eliminate harsh specular hotspots. The camera angle is a slightly elevated
45-degree shot to showcase the clean silhouette and the interior curve.
Ultra-realistic, with sharp focus on the rim edge. The surrounding surface is
empty and unbroken.
```

**Assumed** (rule 12 — say it, do not bury it): no product photo was supplied, so this is text-to-image; the concrete surface and the thin unglazed rim are invented as plausible premium detail; square crop because the likeliest use is a listing tile. Any of those is one sentence to correct.

Settings — endpoint `fal-ai/nano-banana-2`: `aspect_ratio: "1:1"`, `resolution: "1K"`, `num_images: 1`, `output_format: "png"`, `seed: 20250824` — $0.08. Approve the frame, then re-run that same seed at `2K` ($0.12).

That settings block is fal-specific. On this app's Gemini node the same job reports as `aspect_ratio: "1:1"`, `resolution: "1K"`, Images `1`, Seed `20250824` — there is no `output_format` to set. On Replicate or MuAPI there is no seed at all, so the escalation path is to re-prompt at the higher resolution and accept a new composition.

**What changed and why:**

- *Premium* became a described object: matte glaze, thin unglazed rim, clean silhouette. The model can render a rim; it cannot render "premium."
- The lighting slot gained a *purpose* — "to wrap the matte glaze in a soft gradient and eliminate harsh specular hotspots." That sentence is what makes matte black read as matte rather than muddy.
- "no clutter, no background" became the semantic positive "The surrounding surface is empty and unbroken."
- "8k" and "ultra detailed" were deleted and replaced by `resolution`, a parameter that actually does something.
- Aspect ratio moved out of the prose into `aspect_ratio`.
- Resolution starts at 1K deliberately. The composition is what is being tested; 4K on an unapproved frame costs double for no information.
