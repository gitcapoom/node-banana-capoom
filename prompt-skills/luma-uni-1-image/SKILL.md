---
name: luma-uni-1-image
description: Write and rewrite prompts for Luma Agents image models — uni-1 and uni-1-max (agents.lumalabs.ai, Luma Agents API, type image and image_edit). Use for text-to-image and image editing: photoreal scenes, editorial and cinematic shots, posters and magazine covers, infographics and data-viz, storyboards and multi-panel sequences, manga and cultural styles, product photography, photo restoration, text rendering inside images, character consistency across scenes, and multi-reference style/character/composition fusion. Also use when the user says Luma, Luma Agents, Uni-1, uni-1-max, Ray 3.2, make this photo look like, change the background, keep everything else the same, edit this image, create vs modify, reference image, style reference, character reference, or mentions aspect_ratio, image_ref, style manga, output_format png/jpeg, web_search grounding, source, file_id, generation_id, layering, or asks for a prompt to paste into a Luma node.
---

# Luma Uni-1 Prompt Writer

Write for **Uni-1** (`uni-1`, and `uni-1-max` for higher-quality output at a
higher per-image price — same wire format, same parameters, same prompts).
Source: Luma's own prompting guide at
`docs.agents.lumalabs.ai/guides/images/prompt-guide`, plus the image generation
and editing parameter references.

Luma's framing, in their words: Uni-1 "doesn't pattern-match keywords — it
reasons through your intent before generating a single pixel." Their guidance
follows from that: "You don't need prompt-engineering tricks or keyword
stuffing… Think of yourself as a creative director giving a brief to a talented
artist."

**Your output is the prompt text itself, ready to paste into the node's prompt
field** — no preamble, no commentary, no markdown fences. If a parameter needs
setting (`aspect_ratio`, `style`, `image_ref`, `web_search`), say so in your
reply *around* the prompt, never inside it. Never write `16:9`, `--ar`, `png`
or "make 4 variants" into the prompt text; those are fields.

**Negative prompts are not supported.** Describe what you want, not what you
don't. "no hands", "without blur" and "avoid text" do nothing useful — worse,
they put the unwanted thing in the brief. Rewrite them as positive description.

## 1. Create or modify — the first decision

Everything starts here, and it is a *field*, not a phrasing:

| You want | `type` | What happens |
|---|---|---|
| A brand-new composition | `image` | Nothing from any input image is preserved. References only guide style/content. |
| A changed version of a specific image | `image_edit` | Composition is preserved unless you ask for a change. Needs `source`. |

Luma's rule of thumb:

- "Make this photo look like nighttime" → **modify**
- "Create a new scene in the style of this photo" → **create**
- If the output should look like a *version of* your input → **modify**
- If it should feel *inspired but new* → **create**

The trap: `image_ref` on `type: "image"` is **not** editing. The references are
guidance for a new image and none of the input pixels survive. If the user says
"keep the photo, just change X", that is `image_edit` + `source`, not
`image` + `image_ref`.

## 2. Pick a template

Luma publishes eight; they cover roughly 90% of real use. Pick one, fill the
brackets, then let it read like prose.

**1 — Fast Start.** Exploration, first ideas.

```
A [subject], in [style], with [lighting], [camera/composition],
[environment/background], mood: [emotion], details: [key specifics]
```

**2 — Cinematic Control.** Precise visual control; editorial, portfolio.

```
Subject: [who/what]
Style: [editorial / documentary / fine art / etc.]
Scene:
- Environment: [where]
- Time of day: [lighting conditions]
- Weather/atmosphere: [mood elements]
Camera:
- Shot type: [close-up / wide / medium / aerial]
- Lens: [wide angle / telephoto / macro]
- Angle: [eye level / low angle / overhead]
Details: [specific textures, colors, props]
Mood: [overall feeling]
```

**3 — Direct Edit.** Surgical fixes. Pair with `type: "image_edit"`.

```
Change [specific element] to [new version]. Keep everything else the same.
```

**4 — Multi-Reference Fusion.** Blend style + character + composition. Label
each reference's *role* so the model knows what to take from each.

```
IMAGE1 (STYLE): [description of style reference]
IMAGE2 (CHARACTER): [description of character reference]
IMAGE3 (COMPOSITION): [description of layout reference]

Create a [subject] that combines the visual style of IMAGE1, the character
from IMAGE2, in the composition/layout of IMAGE3. [Additional scene details.]
```

**5 — Layout Control.** Posters, covers, infographics. Uni-1 is unusually good
at text rendering; put exact strings in quotes.

```
Create a [format] with the following layout:
- [Position 1]: [element description]
- [Position 2]: [element description]
Text: "[exact text to render]"
Style: [overall aesthetic]
```

**6 — Storyboard.** Multi-panel with a consistent character.

```
Create a [N]-panel storyboard showing: Panel 1: [scene]. Panel 2: [scene].
Consistent character throughout: [description]. Style: [aesthetic].
```

**7 — Loose / Creative.** When the user wants to be surprised.

```
[Vibe or feeling]. [A few evocative words or an abstract concept.]
```

**8 — Structured JSON.** Maximum precision and reproducibility; good for batch
work. Serialize it into the `prompt` field — Luma notes "JSON is just one shape
of structured prose."

```
{ "subject": "...", "style": "...", "composition": "...", "lighting": "...",
  "color_palette": "...", "mood": "...", "details": ["..."],
  "text_elements": ["..."] }
```

## 3. Anatomy — the eight blocks

Cover the ones that matter for the shot; skip the rest.

| Block | What it does |
|---|---|
| Subject | Who or what is in the image |
| Style | Visual aesthetic or medium — "oil painting", "35mm film photography" |
| Composition | Camera angle and framing — "close-up portrait", "aerial view" |
| Lighting | Quality and direction — "golden hour", "dramatic side lighting" |
| Environment | Where it takes place |
| Mood | Emotional tone |
| Details | Specific textures, props, colours |
| Text | Exact words to render, in `"quotes"` |

Luma singles out one of these: **"Specify lighting. It's the single biggest
quality lever."**

## 4. Length

| Task | Words | Why |
|---|---|---|
| Text-to-image | 80–250 | Enough to guide, not so much it conflicts |
| Reference-guided | 100–300 | More words to say *how* references blend |
| Modify / edit | 30–100 | Be surgical — describe only the change |

`prompt` is hard-capped at **6,000 characters** (1 minimum).

## 5. Reference images

Up to **9** on `type: "image"`, **8** on `type: "image_edit"` (the `source`
takes its own slot). Give each a role — Luma's table:

| Role | Controls | Use when |
|---|---|---|
| Style | Aesthetic, rendering approach | "Make it look like THIS" |
| Character | Identity, face, body, clothing | Consistency across scenes |
| Composition | Layout, spatial arrangement | Matching framing |
| Colour palette | Colours and tones | Brand colours, a mood |
| Lighting | Direction and quality | Recreating a setup |
| Texture | Surface qualities | Matching material finishes |
| Mood | Emotional feeling | Capturing an atmosphere |

**Character consistency workflow:** generate one clean front-facing reference →
reuse it as `IMAGE1 (CHARACTER)` in every later scene → keep the label
identical → vary only the scene description. The character holds; the world
changes.

Each `image_ref` entry is an `ImageRef`: exactly one of `url`, `data` (base64,
and then `media_type` is required), `file_id` (from the Files API), or
`generation_id`. Limits: 50 MB and 8000 px per side. Uploading once and reusing
`file_id` avoids re-sending the same bytes every request.

## 6. Parameters you should set, and what you must not write in the prompt

| Field | Values | Notes |
|---|---|---|
| `aspect_ratio` | `3:1` `2:1` `16:9` `3:2` `1:1` `2:3` `9:16` `1:2` `1:3` | Nine for images. **Omit and the model picks one to fit the prompt** — often the right call. |
| `style` | `auto` (default), `manga` | See the constraint below. |
| `output_format` | `png`, `jpeg` | Omit → model picks. png lossless, jpeg smaller. |
| `web_search` | boolean, default `false` | Searches the web for visual references first. |
| `model` | `uni-1` (default), `uni-1-max` | Identical prompts; max is higher quality, higher price. |

**`style: "manga"` is portrait-only on `type: "image"`.** Pair it with `2:3`,
`9:16`, `1:2` or `1:3`, or omit `aspect_ratio`. Anything landscape or square is
rejected at submit with HTTP 422. On `type: "image_edit"` the constraint does
not apply, because output dimensions come from the source image.

**`aspect_ratio` is ignored on `image_edit`** — the source image's dimensions
win. Don't promise the user a reframe by setting it; that is what Ray 3.2's
`video_reframe` does for video, and for images you re-generate instead.

**Turn `web_search` on for real-world specifics** — named landmarks, public
figures, actual products. Luma's community tip: "Web search grounding is
incredible for real-world subjects." It is off by default.

## 7. Weak → strong

Luma's own before/after pairs. The shape of the improvement is the lesson.

Weak: `cat in forest`

Strong:
```
A tabby cat sitting on a mossy log in an ancient forest at golden hour, soft
dappled light filtering through oak leaves, painterly impressionist style, warm
amber tones, peaceful and serene mood
```

Weak: `product photo of sneaker`

Strong:
```
A single white running sneaker on a concrete surface, outdoor urban
environment, clean commercial photography, soft natural shadow, minimalist and
modern feel, shallow depth of field
```

## 8. Cheat sheet

**Do** — be specific about subject + style + composition · put key instructions
early · use references for consistency · describe spatial relationships
explicitly ("to the left of", "in the foreground") · quote text you want
rendered · refine iteratively · use layout descriptions for complex
compositions · specify lighting.

**Don't** — write negative prompts · use keyword soup from other tools ("8k,
ultra detailed, masterpiece") · over-constrain with conflicting instructions ·
expect one prompt to be perfect · forget mood.

That second one is worth stating plainly: if the user hands you a Midjourney or
Stable Diffusion tag string, **rewrite it as a brief**. Uni-1's reasoning core
has nothing to reason about in a tag list. Luma's advice to Midjourney users:
"ditch the style keywords. Write like you're briefing a photographer instead."

## 9. What Uni-1 is especially good at

Spatial reasoning in multi-subject scenes · readable text rendering (posters,
signs, UI mockups) · character consistency via references · infographics and
data visualisation · multi-panel layouts and storyboards · cultural styles
(manga, ukiyo-e, film noir, editorial) · photo restoration · product
photography · complex layered compositions.

Lean into these when choosing an approach. A storyboard or a poster with exact
typography is a *good* use of this model, not a stretch.

## 10. Workflow

Luma's loop is **Start → Direct → Refine → Finish**, and their strongest
process advice is not to restart:

1. Fast Start or Creative Mode — generate loose, explore.
2. Pick the best result.
3. Switch to `image_edit` + Direct Edit prompts to fix one thing at a time.
4. Iterate. "Don't restart when you get something close. Use Modify to push the
   last 20%."

When the user asks for several related images, prefer one locked character
reference plus varying scene prompts over re-rolling from scratch each time.

## 11. Adjacent modes — know when to hand off

- **`type: "layering"`** (uni-1 only) decomposes an existing image into ordered
  RGBA layers. The image rides `source`; `prompt` optionally guides how to split
  it and is capped at 500 characters there. If the user wants a PSD-like stack
  rather than a picture, that is layering, not a prompt problem.
- **Ray 3.2** (`ray-3.2`) handles video: `video`, `video_edit`, `video_reframe`.
  Image prompt craft mostly transfers, but the fields are different — don't
  write video direction into an image prompt.

## Worked example 1 — poster, text-to-image

User: *"a poster for a sci-fi thriller called SIGNAL"*

Fields: `type: "image"`, `aspect_ratio: "2:3"`, `style: "auto"`.

```
Create a movie poster for a sci-fi thriller. Title: "SIGNAL" in large
distressed metallic font at the top. Central image: a lone astronaut standing
before a massive alien structure on a barren planet, seen from behind at a low
angle so the structure dominates the frame. Colour palette: deep navy, burnt
orange, silver. Lighting: hard rim light from the structure itself, long
shadow thrown toward the viewer. Mood: awe and isolation. Tagline at the
bottom: "They weren't listening. They were waiting."
```

## Worked example 2 — surgical edit

User: *"same photo but make it sunset"*

Fields: `type: "image_edit"`, `source` = their image. No `aspect_ratio` (ignored).

```
Change the sky to a dramatic sunset with deep orange and purple clouds, and
warm the light falling on the building so it matches the new sky. Keep
everything else the same.
```

Note what this does: it names the change, names the *consequence* of the change
(the light on the building), and explicitly protects everything else. Thirty to
a hundred words, not three hundred.

## Worked example 3 — multi-reference fusion

Fields: `type: "image"`, three `image_ref` entries in this order.

```
IMAGE1 (STYLE): grainy 1970s editorial photography, muted earth tones, soft
halation around highlights
IMAGE2 (CHARACTER): a woman in her forties with close-cropped silver hair and
a weathered canvas jacket
IMAGE3 (COMPOSITION): subject small in the lower-left third, vast empty space
filling the upper right

Create a portrait of the character from IMAGE2 standing at the edge of a salt
flat at dawn, rendered in the visual style of IMAGE1, using the composition and
negative space of IMAGE3. Low horizon, pale sky gradient, her breath visible in
the cold air. Mood: solitary, resolute.
```
