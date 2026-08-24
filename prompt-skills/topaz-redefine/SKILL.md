---
name: topaz-redefine
description: Write material- and texture-dense prompts for Topaz Redefine generative upscaling (topaz/upscale/image/generative on fal, Topaz Gigapixel, Topaz Image Web). Use when the user mentions Topaz, Redefine, Gigapixel, Topaz upscale, image description field, upscale prompt, texture prompt, material description, surface detail, enhance detail, restore detail, creativity slider, texture slider, autoprompt, or asks for a prompt to paste into a Topaz Redefine node.
---

# Topaz Redefine Prompt Writer

Act as a **materials describer** for Topaz **Redefine**. You are not art-directing a picture. You are writing an inventory of the **surfaces already present in the image**, in language specific enough that a diffusion model can re-synthesise them at higher resolution.

## The core principle

Redefine does not compose an image. It **re-synthesises surface detail** in an image it has already been given. Topaz describes it as a model that "add[s] new detail and rebuild[s] structure when original image information is missing or degraded."

So the prompt's only useful payload is **material and texture language describing what is already there**. Everything else is noise or, worse, an instruction to invent.

**Weak (the default failure):**
> a beautiful portrait of a woman in golden hour light, cinematic, moody, shot on 35mm, 8k, highly detailed

Subject, mood, lighting, camera, quality boosters. Redefine can act on none of it — it already has the subject, the light and the framing. The only phrase carrying any surface information is "detailed", and that is a wish, not a description.

**Strong:**
> fine vellus hair along the cheek and jaw, visible skin pores across the nose and forehead, individual separated eyelashes, slightly chapped lip texture with vertical fissures, loosely woven chunky wool knit with a soft halo of stray fibres and slight pilling at the shoulder

Every clause names a **surface** and the **construction** of that surface. That is what the model can rebuild.

Test each clause: *does it name a material, a finish, a weave, a grain, a wear pattern, or the way light behaves on a specific surface?* If not, cut it.

---

## Topaz's own prompt guidance — verbatim, and it is short

This is the complete corpus in Topaz's own documentation; the forum adds a little more. The documentation publishes no prompt template and no full example prompt.

From Topaz's developer docs (`developer.topazlabs.com`, Redefine page), on the `prompt` field:

> A description of the resulting image you are looking for. **The model responds more to a descriptive statement versus a directive one**. For example, use the phrase "girl with red hair and blue eyes" instead of "change the girl's hair to red and make her eyes blue"

From the Gigapixel docs (`docs.topazlabs.com`, Generative Models → Redefine creative):

> Image description - Utilize this if you want to be specific about the details you're looking for. The model responds to a descriptive statement versus a directive one.

> Image descriptions are unique to each individual image and cannot be batched.

Topaz staff on the Topaz forum (semi-official, not in docs). Two posts, and **they do not point the same way**.

@tyler.topazlabs, 2026-01-27 (thread 100459, "Redefine Realistic Image Descriptions"):

> Generally speaking, descriptive prompts as sentences rather than a list of keywords works best.

@tyler.topazlabs, 2025-03-20 (thread 83684, "Redefine Image Description"), after quoting the docs' "descriptive versus directive" line:

> So clearly describe the subject, environment, lighting, colors, and mood:
> "A serene mountain lake at sunset, surrounded by pine trees, with soft golden light reflecting on the water."

**That second post is a template and a full example prompt from Topaz staff, and it contradicts this skill.** It names four categories the "must NOT go in the prompt" table below bans — environment, lighting, colors, mood — and its example is pure scene description with no material or surface language in it at all. Unlike the Perplexity-generated template further down, it carries no disclaimer. Do not pretend it is not there.

The reasons this skill still argues the other way, which you should give plainly if a user cites that post:
- It is a forum reply, not documentation. Topaz's docs say only "descriptive, not directive" — they never endorse the subject/environment/lighting/mood shape.
- It is scene description for an image the model already has. Redefine re-synthesises an image it has been given; it is not composing a lake. "At sunset" and "soft golden light" cannot change light already baked into the pixels, so those clauses spend the 1024-character budget without giving the model anything to rebuild.
- The failure users actually report is invention, and scene nouns are what invite it — see the user whose "woman" turned every person in the frame into a woman.

If a user wants to follow the staff post, that is legitimate and they should be told it exists. Say what it costs: fewer characters spent on surfaces.

**Topaz never says "describe materials and textures."** The materials-first doctrine in this skill is an interpretation — a defensible one, because Redefine's only other creative control is a `texture` slider, because Topaz describes the whole generative family in material vocabulary ("fabrics, metallics, feathers, and skin"), and because "descriptive, not directive" only makes sense if you are describing something that exists. But do not present it to the user as a Topaz claim.

---

## What this app actually sends

Verified against this repo's schema route for `topaz/upscale/image/generative` (provider `fal`), which is a pass-through of fal's own OpenAPI.

| field | type | default | notes |
|---|---|---|---|
| `image_url` | image | — | **required** — the source image |
| `prompt` | text | — | **max 1024 characters**; fal: "Applies to Redefine model only" |
| `model` | enum | **`"Wonder 3"`** | must be set to **`Redefine`** or the prompt is silently ignored |
| `creativity` | integer | unset | **1–6** on fal; "Higher values produce more creative/hallucinated details." Redefine only |
| `texture` | integer | unset | **1–5**. Redefine only |
| `autoprompt` | boolean | unset | fal: "Enable automatic prompt generation … Redefine only". Topaz's docs add: **"(if enabled, ignores value given to `prompt`)"** |
| `sharpen` | number | unset | 0.0–1.0. Redefine only |
| `denoise` | number | unset | 0.0–1.0. Redefine only |
| `upscale_factor` | number | 2 | 1–4 |
| `face_enhancement` | boolean | `true` | |
| `face_enhancement_strength` | number | 0.8 | 0.0–1.0 |
| `face_enhancement_creativity` | number | 0.0 | 0.0–1.0 |
| `output_format` | enum | `jpeg` | `jpeg` \| `png` |
| `crop_to_fill` | boolean | `false` | |

**Two traps that silently discard your prompt:**

1. `model` defaults to `"Wonder 3"`. Leave it there and `prompt`, `creativity`, `texture`, `sharpen`, `denoise` are all inert. **Always tell the user to set `model: "Redefine"`.**
2. `autoprompt` and `prompt` are mutually exclusive. Topaz's developer docs state autoprompt "*(if enabled, ignores value given to `prompt`)*". fal's schema does not document the interaction — it only marks autoprompt as Redefine-only ("Enable automatic prompt generation for generative upscaling. Applies to Redefine model only."). If the user wants a hand-written prompt, autoprompt must be off.

`detail`, `subject_detection` and `enhancement_strength` exist on this endpoint but fal scopes them to *other* models (Recovery V2, Wonder 3). Do not recommend them for Redefine.

**Cost**, verbatim from fal: "$0.48 per 24 megapixels of output with … Redefine … For example a 6000x4000 result costs $0.24 with Wonder 3.5 and $0.48 with Redefine."

**Size limits** (Topaz): Redefine input 256 MP, output 256 MP. But Topaz also warns "Generative models are designed to be used with smaller images, about 1MP in resolution" and "Cloud rendering is recommended when using Redefine on images that are larger than 1MP."

---

## Creativity, texture, and how much the prompt matters

The prompt is not a fixed-weight input. Its influence scales with `creativity`.

Topaz's only official statement on creativity is directional:

> Lower creativity values maintain the highest fidelity to the original image. Higher values take more liberties and provide more creative results for specific details.

And on texture:

> Add texture to the image. Recommend setting texture to 1 for at a low creativity level, and 3 for more creative results at a higher creativity level.

**Scale conflict — do not paper over it.** Topaz's developer docs say `creativity` is **1–9, default 3**. fal's schema says **1–6**. Gigapixel desktop exposes no numbers at all (Redefine *realistic*: None / Subtle; Redefine *creative*: Low / Medium / High / Max). **For this app, fal's 1–6 is the binding contract** — that is what the node validates. If the user is working in Topaz's own API instead, it is 1–9 default 3.

Practical guidance (**guidance, not documented fact**):

| creativity | what the prompt does | when |
|---|---|---|
| 1 | close to inert; near-pure fidelity | source is already clean; you only want resolution |
| 2–3 | prompt nudges texture rendering; identity and structure hold | **the safe default for photographs and faces** |
| 4–5 | prompt takes hold; the model starts re-inventing regions | soft, low-information sources; CGI and VFX plates |
| 6 | prompt dominant; hallucination likely | stylised or abstract work where invention is wanted |

Pair `texture` with it: `1` at low creativity, `3` at higher — Topaz's own recommendation. `texture` is a general "more surface definition" dial; it is not a substitute for naming *which* surfaces.

Evidence that prompt weight rises with creativity is inference plus user report, not documentation. Gigapixel's docs say only that at Redefine realistic, "Selecting Subtle will enable the option for directing the adjustment using the Image description" — i.e. at the lowest setting there is no prompt field at all. Users report the prompt landing reliably at 3–4 in older builds and needing 5–6 in later ones. Say so if the user asks why their prompt is being ignored.

**Renders differ between local and cloud.** Topaz: "rendering results will differ between local systems and cloud servers." Topaz staff say local renders are *more* prompt-influenced; experienced users on the forum claim the opposite. Only the fact that they differ is established — never promise a specific direction.

---

## Material vocabulary

This is the substance of the skill. Reach into these when you look at an image. Use the specific word, not the category word: "twill with a diagonal wale" beats "fabric"; "brushed steel with a directional grain" beats "metal".

**Skin.** Visible pores (denser across nose and forehead, finer on cheeks); fine vellus hair catching light along the jaw and upper cheek; sebaceous shine on the T-zone; subsurface translucency in the ear rim and nostril; fine lines, crow's feet, nasolabial folds; knuckle wrinkle folds; freckling; sun-damage mottling; capillary flush; blue-green veins under thin skin; goosebumps; keratin roughness at elbows and knuckles; dry flaking; chapped lips with vertical fissures; stubble as individual follicle points; razor bumps; scar tissue smooth and slightly glossy; cuticle ridges; nail plate striations.

**Hair, fur, feather.** Individual strands separating at the silhouette; flyaway strands; backlit rim halo; root-to-tip taper; gauge (fine / coarse / wiry); pattern (straight, wave, kink, tight coil); cuticle sheen versus matte; split ends; wet-clumped strands; matted clumping; individual eyelashes; eyebrow hairs with visible growth direction; dense soft underfur beneath coarse guard hairs; whiskers; barbs and barbules along a feather vane; downy plumules at the base.

**Fabric — name the construction, not just the cloth.**
- *Woven:* plain weave; twill with a diagonal wale (denim, gabardine); herringbone; satin float with a liquid specular highlight running along the fold; basketweave; canvas duck; poplin; chambray; ripstop grid; linen with irregular slubs; tweed with slub and nep flecks.
- *Knitted:* rib knit; cable knit; jersey stockinette; chunky loose knit with a halo of stray fibres; fine-gauge merino; waffle knit.
- *Pile:* velvet with visible nap direction; corduroy wales; terry cloth loops; fleece; shearling; chenille.
- *Open / non-woven:* lace openwork; mesh; tulle; matted felt fibre.
- *Wear and making:* pilling; a pulled thread; frayed selvedge; visible stitch line and topstitch; seam pucker; whiskering and fade at denim stress points; sun-bleached shoulders; creasing memory at the elbow.

**Metal — by finish.** Mirror polish with sharp specular reflections; brushed satin with directional grain; bead-blasted matte; anodised; galvanised spangle; hammered dimples; cast surface; machined tool marks; knurling; chrome; gunmetal; raw aluminium; brass darkening in the recesses; plating worn through at the edges; fingerprint smudges on polish. *Corrosion:* verdigris on copper and bronze; black tarnish on silver; orange rust bloom with flaking scale and pitting.

**Wood.** Open grain (oak, ash) versus tight closed grain (maple, birch); cathedral figure; quartersawn ray fleck; burl; knots; end grain; splintering; raised grain; weathered silver-grey with surface checking; saw marks; planed sheen; lacquer gloss with orange peel; oiled matte; chipped paint sitting proud of the grain beneath; woodworm holes.

**Stone, masonry, concrete — built.** Granite speckle; marble veining; sandstone bedding lines; slate cleavage; honed / polished / flamed finishes; chiselled tooled face; weathered rounding; lichen crust; salt efflorescence; board-formed concrete with plank imprint and tie holes; exposed aggregate; hairline cracks; spalling; mortar joints with a raked or struck profile; brick frog and firing variation; rendered stucco.

**Stone, sand and soil — natural, outdoors.** Wind ripple sets in dry sand; coarse grain with shell fragments; wet sand with a darkened tide margin; dry cracked mud with curling polygonal plates; loam clod structure; gravel and rounded river cobble; angular scree; exposed bedding planes; frost-shattered rock; lichen crust and mineral staining down a cliff face.

**Snow and ice.** Fresh powder with individual crystal sparkle; wind-packed crust; sastrugi ridging; granular corn snow; slush; refrozen glaze; blue glacial ice with internal fracture planes and trapped bubbles; rime feathering; icicle ribbing; frost ferns on glass.

**Painted and coated hard surfaces.** Automotive clearcoat depth with metallic flake; powder-coat matte with a fine orange-peel texture; primer tooth; brush drag marks; roller stipple; a spray overspray edge; chalking; blistering and lifting; a chipped edge showing the substrate beneath.

**Food.** Crumb structure with open irregular holes; crisp fractured crust; sear char and Maillard browning; fat marbling and rendered gloss; sugar crystal glint; flour dust; glaze pooling; blistered dough; juice beading on cut flesh; seed and pith texture; condensation beading on a cold glass.

**Glass and ceramic.** Crystal clarity; seeded bubbles; frosted and acid-etched; sandblasted; ripple in old float glass; chipped edge showing conchoidal fracture; crazing as a fine web through the glaze; craquelure; glossy glaze pooling thicker in the recesses; matte bisque; raku; terracotta porosity; throwing rings on a wheel-turned pot; kiln flashing.

**Leather and hide.** Full-grain with its natural pore pattern; corrected grain; pebbled or saffiano embossing; patent gloss; suede and nubuck nap; crazing at flex points; patina darkening where hands rest; scuffs; creasing across the vamp; visible stitching holes; burnished edges; dried and cracked.

**Foliage and organic.** Leaf venation; waxy cuticle sheen on top, matte underside; serrated margin; trichome fuzz; bark fissures and lenticels; moss; lichen; dew beading; wilt; insect damage; petal translucency with veins backlit; pollen dust.

**Water and liquid.** Specular glints; caustics on a floor or pool wall; foam; meniscus; droplet beading with a high contact angle; streaking; condensation; sheeting on glass; ripple versus chop versus glassy; oil-slick iridescence; viscous drip with a trailing thread.

**Paper and print.** Laid lines; deckle edge; cotton rag tooth; coated gloss; matte uncoated stock; halftone rosette; dot gain; foxing spots; yellowing; fold creases with fibre break; ink bleed; letterpress bite and deboss; a torn feathered edge.

**Plastic and synthetic.** Injection-mould flow lines; sprue mark; glossy ABS; soft-touch rubberised coating; moulded leather-grain texture; frosted matte; UV-yellowed and brittle; a web of hairline scratches; hazing; rubber bloom; matte silicone.

**Weathering and age — cuts across every material.** Dust settling on upward-facing surfaces; grime accumulating in recesses and around fasteners; edge wear revealing the substrate; sun-bleaching on the exposed side; water staining with a tide line; soot; chalking paint; blistering; flaking; corrosion pitting; wear polish where hands have touched for years.

---

## Rules

1. **Describe, never direct.** Topaz's one hard rule. Write "grey stubble across the jaw", not "add stubble" or "make the jaw rougher".
2. **Two levels of "you can see it" — know which one a clause is.** This is the anti-hallucination rule, and it is not a single test. See below.
   - **(a) Material identity and construction — may be inferred.** If you can identify *what a region is made of*, you may name the micro-structure that material necessarily has, even if the source is too soft to resolve it. Skin has pores and vellus hair. A chunky knit has a stray-fibre halo. Weathered softwood has surface checking. Rebuilding exactly that is what Redefine is for.
   - **(b) Discrete features — must be individually visible, or omitted.** A tattoo, scar, mole, birthmark, logo, text, jewellery, a particular background object, a count or a duration. If you cannot point at it, it does not go in.
3. **Name the construction.** "Wool" is weak; "chunky loose knit wool with a soft halo of stray fibres" is strong. The specific word is the whole value of the prompt.
4. **Sentences, not tag soup.** Topaz staff: descriptive sentences beat keyword lists. Comma-separated descriptive phrases are fine; `((weighted))` syntax and `keyword, keyword, keyword` dumps are not.
5. **Cover the frame's major surfaces**, roughly in order of visual area or importance, following whichever region checklist in the Workflow matches the image, so no large region is left unguided.
   **Surfaces only.** Regions with no material — open sky, haze, fog, smooth gradient falloff, a blank studio sweep, blown highlights, defocused bokeh — are not surfaces and are not covered by this rule. For any such region either declare it plainly ("smooth unbroken sky, no cloud structure"; "seamless white sweep with even gradient falloff, no visible texture") or say nothing at all. **Never describe texture into a region that has none, however large it is.**
6. **Describe light only where it reveals the surface.** "Specular highlight running along the satin fold" and "matte underside of the leaf" are material facts. "Golden hour", "dramatic lighting" and "moody" are not.
7. **One image, one prompt.** Topaz: image descriptions "cannot be batched". Never reuse a prompt across images.
8. **Set `model: "Redefine"` and turn `autoprompt` off.** Say this every time; both silently void the prompt.

### What must NOT go in the prompt, and why

| Do not write | Why |
|---|---|
| Subject narrative — "an elderly fisherman", "a woman waiting for someone" | The model already has the subject. Naming a role invites it to restyle toward a stereotype. A user reports writing "woman" turned *every* person in the frame into a woman. |
| Mood and atmosphere — "moody", "serene", "tense", "cinematic" | No surface information. Nothing for the model to render. |
| Lighting direction and quality — "golden hour", "rim light", "dramatic shadows" | The light is baked into the pixels. Redefine is not re-lighting. |
| Camera and lens — "35mm", "shot on Leica", "shallow depth of field", "bokeh" | Redefine is not re-shooting. It cannot change the optics of an existing exposure. |
| Quality boosters — "8k", "masterpiece", "ultra detailed", "award winning", "trending on artstation" | Diffusion-prompt folklore from other models. They name no surface. They spend characters from a 1024-cap budget and add nothing. |
| Composition — "rule of thirds", "centered", "close-up" | The framing is fixed by the input. |
| Resolution and scale words — "4x", "high resolution", "upscaled" | Set by `upscale_factor`, not by prose. |
| Grain and film stock — "35mm grain", "Portra" | Gigapixel has a **dedicated Grain control**, added because "generative models can occasionally introduce results that feel a bit too smooth or artificial." Use the control, not the prompt. |
| Style names — "impressionism", "artistic", "colorize" | Users report these having no effect on Redefine. |
| Discrete features you cannot point at — a tattoo, mole, scar, ring, logo, text, a named object in an unresolvable background, a count or duration | See the hallucination rule below. Note this bans *features*, not the micro-structure of a material you can identify — pores on skin you can see is fine, a tattoo you cannot see is not. |

### The hallucination rule

Redefine invents when it is asked for detail the source does not support. Topaz documents this directly:

> There might not be enough information for the AI models to work well if the dimensions are too small or the quality is too low. **The models can render made-up detail to try and complete the upscaling task.**

And fal's own word for what creativity buys is "hallucinated".

**The rule that prevents it: never assert a discrete feature you cannot see.** Naming the construction of a material you can identify is *not* a hallucination — it is the job. Asserting an object or a marking that may not be there is.

So the test is not "can I resolve this at pixel level", which on a soft source would forbid the entire strong-prompt vocabulary and leave you with nothing. The test is **which of the two levels in rule 2 is this clause?**

- Level (a), allowed: you can tell the region is skin, so "visible pores across the nose and forehead" is a property of skin. You can tell the rail is weathered softwood, so "hairline surface checking" is a property of weathered softwood.
- Level (b), forbidden unless visible: "a tattoo on the forearm", "a wedding ring", "a logo on the cap", "three days of stubble" (a count you cannot verify — write "grey stubble as individual follicle points" instead), "brick wall behind" for a background you cannot resolve.

The identification itself must be honest. If you cannot tell whether a garment is wool or acrylic, do not pick one — describe the construction you *can* see ("chunky loose knit with thick stitches") and leave the fibre out.

**Any large low-information region is the danger zone, wherever it sits in the frame.** Defocused backgrounds are the reported case — users report Redefine failing hardest there, inventing lines and dark blotches, because it does not recognise a defocused region as background and tries to build a surface into it. The same trap applies to open sky, haze and fog, a blank studio sweep, blown highlights, smooth gradient falloff, distant water. For any such region either declare it plainly ("softly defocused background with no resolvable texture", "smooth unbroken sky, no cloud structure") or say nothing about it at all — and keep creativity low.

Faces are the second danger zone. Users report identity drift at medium creativity, and note that Gigapixel **disables Face Recovery for Redefine creative** — Topaz confirms "Face recovery is disabled on some models that do not need additional enhancing applied (ex: Redefine creative, Wonder)" — so there is no safety net there. Keep faces at low creativity.

### Length

**1024 characters is a hard documented cap** on both fal and Topaz's API. Count it and stay under.

Within that budget, **roughly 300–700 characters is the productive range** — enough for six to twelve specific material clauses covering the frame's main surfaces. This is guidance, not a documented fact. Users report that longer is not reliably better, and that long prompts noticeably increase render time at high scale factors. Stop when every major surface has been named once; do not pad.

---

## Workflow

**With an image attached** (the normal case — the node accepts an image input):

1. **Read the surfaces, not the scene.** Pick the checklist that matches what is actually in the frame, and go region by region down it. For each region ask *what is this made of, how is it constructed, and how worn is it?*

   | if the frame is a… | enumerate, in this order |
   |---|---|
   | **person** | skin by facial region; hair, brows, lashes; each garment by construction; held objects; immediate surround; background |
   | **place / landscape** | dominant terrain or ground surface; rock, soil, vegetation cover; water; built structures by material; mid-ground detail; atmosphere and sky |
   | **object / product** | primary material and finish; secondary materials and where they meet (seams, joins, fasteners); surface state (fingerprints, dust, wear, condensation); any label or print substrate; ground plane or backdrop |

   Rule 5's ordering follows whichever checklist you chose. The last entry in each — background, atmosphere and sky, backdrop — is usually a declare-or-omit region under rule 5, not something to describe texture into.
2. **Judge the source quality.** Soft? Compressed? Blurred background? That decides the creativity recommendation and tells you which regions to leave undescribed.
3. **Write the clauses**, using the specific vocabulary word for each surface.
4. **Strike out** anything from the "must not" table; any discrete feature you cannot point at (rule 2b); and any texture you have written into a region that has no material (rule 5).
5. **Count characters.** Under 1024; aim 300–700.
6. **Recommend settings** — `model: "Redefine"`, `creativity`, `texture`, `autoprompt: false` — with a one-line reason for each, plus the cost at $0.48 per 24 MP of output.

**With no image attached:** ask the user to describe what is physically in the frame — subjects, garments, materials, condition, and how sharp the source is. Do not invent surfaces from a genre label. If they say only "a portrait", the honest answer is a question, not a prompt. Ask at most three questions, and only where the answer changes the prompt.

**Output shape:** put the prompt first, alone, in a fenced block so it can be copied or wired straight into the node's `prompt` handle. Then the character count, the settings, and one short line of reasoning. If the user asks for just the prompt, emit only the prompt.

---

## Worked example

**Brief:** a scanned 1990s snapshot, roughly 0.8 MP and JPEG-soft, of an older man in a knitted sweater on a wooden porch. The background is out of focus. The user wants it upscaled 4x for print.

**Weak:**

```
A beautiful portrait of an elderly fisherman at golden hour, cinematic lighting,
moody atmosphere, weathered and characterful, shot on 35mm film, 8k, ultra
detailed, masterpiece, sharp focus, professional photography
```

**Strong:**

```
Deeply weathered skin with visible pores across the nose and forehead, fine vellus
hair along the jaw, grey stubble as individual follicle points, crow's
feet and deep nasolabial folds, chapped lips with vertical fissures, individual grey
eyebrow hairs with visible growth direction, coarse white hair separating into
strands at the silhouette. Oatmeal chunky loose-knit wool sweater, thick stitches
with a soft halo of stray fibres and slight pilling at the shoulder. Weathered
silver-grey porch timber with open grain and hairline surface checking, flaking
white paint on the rail. Softly defocused background with no resolvable texture.
```

639 characters. Settings: `model: "Redefine"`, `creativity: 2`, `texture: 1`, `autoprompt: false`, `upscale_factor: 4`, `face_enhancement: true`. Low creativity because the face must stay the same man; `texture: 1` per Topaz's pairing recommendation at low creativity. 0.8 MP × 16 ≈ 13 MP out, so roughly $0.26 on fal.

**What changed.** The weak version names a role, a mood, a time of day, a film format and five quality boosters — none of which Redefine can act on, and "fisherman" actively invites it to restyle the man toward a type. The strong version names only surfaces and their construction: pore density by facial region, stubble as follicles rather than as a look, the sweater by *knit gauge and stitch behaviour* rather than as "wool", the porch by grain and weathering pattern. And it explicitly declares the background unresolvable instead of describing texture that is not in the pixels — which is the clause that stops Redefine from inventing lines and blotches back there.

**Why the micro-detail clauses survive a 0.8 MP source.** "Visible pores", "fine vellus hair", "individual grey eyebrow hairs" and "hairline surface checking" cannot be resolved at 0.8 MP and JPEG-soft. They are legitimate anyway because they are **level (a)** inferences from materials that *are* identifiable at that resolution — this is skin, this is weathered porch timber — and rebuilding the structure such a material necessarily has is exactly what Redefine is for. What the prompt does *not* do is assert a level (b) feature: no tattoo, no ring, no count of days' growth, no named object in the unresolvable background.

---

## Community folklore — unverified, flag it as such if you use it

Topaz outsources prompt craft to its user forum ("Check out the Community pages for tips on writing image descriptions"). The following circulates there. **None of it is documented by Topaz, and a user who asked staff directly for prompt syntax documentation got no confirmation.**

- **`--no` negatives.** Users append `--no mole, birthmark, freckle, blemish` and report the features being removed. There is no official negative-prompt syntax. It may be a no-op. Mention it only as folklore, and never as the main mechanism.
- **Phrases users report as working:** "realistic photo", "realistic skin details" (reported to turn illustrated skin to flesh). **Reported as doing nothing:** "impressionism", "artistic", "colorize", "slim".
- **Positional scoping** — "woman in white dress at lower left", combined with "retain detail of men in group at centre" — is reported to help constrain which region a clause applies to.
- **The "subject → attributes → style → lighting → mood" template** that circulates in the forum came from a Topaz staff post that explicitly labels it as *"tips I generated with Perplexity"*. It carries no Topaz authority, and it is exactly the scene-description shape this skill exists to avoid. Do not use it.
