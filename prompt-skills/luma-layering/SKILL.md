---
name: luma-layering
description: Write the guiding prompt for Luma Agents layer extraction — type "layering" on uni-1 (agents.lumalabs.ai), which decomposes an image into ordered RGBA layers. Use when the user wants to take an image apart rather than change it: separate subject from background, cut out an object with the hidden area filled in, build parallax or animatable layers from a still, split a poster or design comp into per-element transparent PNGs, get a PSD-like stack, or isolate people/products/text/logos onto their own layers. Also use when the user mentions Luma layering, layer extraction, layering.resolution 1k/2k, layer bounds, alpha_hint, RGBA layers, front-to-back layer order, decompose an image, or asks how to steer how an image gets split.
---

# Luma Layering Prompt Writer

`type: "layering"` on **uni-1** takes an image apart. It does not change it.
Source: Luma's layering guide at `docs.agents.lumalabs.ai/guides/images/layering`.

The image rides `source`. The `prompt` field is **required but may be empty** —
and unlike everywhere else in this API it is capped at **500 characters**. It
does not describe a picture. It steers how a planner splits the one you gave it.

**Your output is that short guiding line and nothing else** — no preamble, no
fences. If nothing needs steering, the correct output is an empty string, and
you should say so in your reply rather than inventing instructions.

## First, is this even layering?

| The user wants | Use |
|---|---|
| Subject and background as separate standalone images | `layering` |
| Parallax / animatable depth layers from a still | `layering` |
| Each design element as its own transparent PNG | `layering` |
| **To change something** — sky, colour, style, an object | `image_edit` + `source` |

"Remove the background" is layering. "Replace the background" is `image_edit`.
If the user wants the picture to look different afterwards, you are in the wrong
mode — hand off to the `luma-uni-1-image` skill.

## What the model does with your line

The server plans before it generates: a vision model reads the image, decides
how many layers to extract and what belongs in each, then renders each planned
layer as a **full RGBA image with occluded regions completed** — every layer is
a whole element, not a cutout with a hole behind it. Outputs come back
**front-to-back, and the last output is always the opaque background**. Hard cap
is **10 layers** (nine foreground plus the background).

You are steering that planner. You are not writing a manifest for it.

## The one rule: state a rule, not a manifest

Say *how* you want things grouped and let the planner apply it.

**Split by kind**
```
one layer per product on the shelf, plus the shelf and the background
```
```
split by material: metal parts, glass parts, everything else
```

**Steer coarse or fine**
```
as few layers as possible
```
```
the finest separation you can
```

**Name what to keep together** — Luma notes over-splitting is the more common
complaint, and this is the fix:
```
keep the whole figure on one layer
```

**Isolate one thing, merge the rest**
```
isolate the bottle, merge everything else into the background
```

**Two things work against you**, in Luma's words:

1. **An exhaustive numbered manifest fights the planner instead of steering it.**
   Do not write `Layer 1: … Layer 2: … Layer 3: …`. You do not choose the layer
   count; you choose the principle.
2. **Instructions about rendering have no effect.** The prompt shapes
   decomposition only — it does not restyle, recolour, or add content. "make the
   background brighter" in a layering prompt does nothing. That is an
   `image_edit`.

## Length

At most 500 characters, and it should be far shorter than that. One clause
naming the grouping rule is usually the whole job. If your line is a paragraph,
you are writing a manifest.

## Content policy — two traps specific to layering

The layering prompt passes the same pre-flight check as any other generation.
A rejection is a synchronous **HTTP 422** with `code: "content_moderated"`,
before anything is queued or billed. Two failure modes surprise people here:

1. **Protected characters.** A layer-by-layer breakdown of a character owned by
   a rights holder is still a description of that character — often a *more*
   identifying one, since it enumerates the exact visual construction that makes
   them recognisable. Rewording will not clear it. That is a licensing boundary,
   not a phrasing problem. Say so plainly and stop; do not iterate on synonyms.
2. **Detached part-by-part inventories.** A bare list of body parts and colours
   reads very differently to a text classifier than the same request with its
   subject attached. Prefer `the arms and legs of the yellow cartoon character`
   over an anatomical shopping list.

**Diagnostic:** an empty prompt is always permitted. If a request is blocked,
resubmit with `""` — if it then passes, the block was your prompt text; if it
still fails, it is the source image.

## The parameter you may need to set

`layering.resolution` — `"1k"` (default, faster, cheaper) or `"2k"` (re-renders
each layer at higher quality, **priced higher per layer**). Mention it when the
user is producing final art rather than exploring; the cost scales with layer
count, so 2k on a ten-layer split is the expensive corner.

## What comes back, so you can set expectations

Each output carries a `layer` object — `index` (front-to-back position), a short
`label`, a `description`, and an `alpha_hint` of `soft` (hair, fur, glass),
`hard` (solid edges) or `none` (the opaque background).

Layers are **cropped to their visible-alpha bounding box**, so they have
differing pixel dimensions. Each carries `bounds` with `x`, `y`, `width`,
`height`, `canvas_width`, `canvas_height`. To rebuild the original frame, paste
each layer at `(x, y)` onto a transparent `canvas_width × canvas_height` canvas,
iterating the output list **in reverse** (back-to-front).

If the user expects every layer to be full-frame, correct that expectation — the
crop is why `bounds` exists.

## Worked examples

**A product shot, for per-element retouching**

User: *"split this into the bottle, the props, and the background"*
```
isolate the bottle on its own layer, group the surrounding props together, keep the surface and backdrop as the background
```

**A poster, for a design comp**

User: *"I want the type editable separately"*
```
keep the text and logo on their own layers, group the props together
```

**A portrait, for parallax**

User: *"make this animatable, don't chop the person up"*
```
keep the whole figure on one layer, separate foreground, midground and background as few layers as possible
```

**Nothing to steer**

User: *"just break this apart however makes sense"*
```
```
(Empty. Let the planner decide — and tell the user that is what you did.)
