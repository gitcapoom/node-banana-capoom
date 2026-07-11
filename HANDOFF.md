# Project Handoff — Node Banana

_Last updated: 2026-07-10. Written to preserve context across a token-limit boundary._

## Repo / deploy topology
- **Dev repo:** `C:\Users\capoom\node-banana-capoom` — branch `develop`, `npm run dev` (:3000).
- **Deploy repo:** `C:\Users\capoom\node-banana-capoom-deploy` — branch `master` (:3001). Same GitHub remote (`gitcapoom/node-banana-capoom`).
- **Git workflow (IMPORTANT):** Work directly on `develop` (no feature branches/PRs this project). Deploy = **cherry-pick** `develop`'s commits onto the deploy repo's `master`, **never merge**.
- **Verified deploy procedure (used this session):**
  1. In dev: `git push origin develop`
  2. In deploy repo: `git fetch origin`, then `git cherry-pick <oldMaster>..<devHead>` (range of new commits)
  3. Verify content parity by **tree hash**: `git -C <dev> rev-parse develop^{tree}` **must equal** `git -C <deploy> rev-parse master^{tree}`
  4. `git -C <deploy> push origin master`
  - `git cherry -v origin/master origin/develop` may show pre-existing subtree-squash commits (image2GS / splat-viewer) as `+` — those are patch-id artifacts, not missing content; the tree-hash equality is the source of truth.
- Commit trailer used: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `.planning/` is untracked — never commit it.

## Current git state
- `develop` @ `b37dddc`, deploy `master` @ `3376c79` — **trees identical** (`479b216…`), fully synced. Loopback feature is live on both.

---

## 1. DONE this session — Loopback conversation mode (LLM Generate node) — DEPLOYED
A third mode on the LLM Generate node for iterative image refinement. Fully built, verified, and deployed (27 commits `a3b93c6…b37dddc`). Final design after heavy iteration:

- **One "Send" button** (chatbot-style) — no more Assess/Converse split. Adapts: typed direction → apply it; empty → full assessment; no render yet → draft from goal+references.
- **In-node compose box** that clears after each send (`composeInput` field) — prevents silently re-firing the previous prompt.
- **Diagnostic-only render:** the loopback/feedback image is shown to the LLM (to assess) but **never sent to the image generator** — the generator regenerates fresh from references + the prompt. This is the key anti-drift decision.
- **Anti-drift anchoring** (appended to the LLM's system context each turn):
  - `# THE SPEC` = original request + **canonical initial prompt** (`initialPrompt` field, captured on a conversation's first turn; a fresh conversation replaces it).
  - `# CURRENT WORKING PROMPT` = last turn's prompt (`outputPrompt`) — the model refines this forward (textual carry-forward) while THE SPEC keeps it anchored.
- **References passthrough:** LLM node has an `images` output (`Images →`) forwarding the references (Image 1,2,…) to the generator through one edge; positions stay aligned. Feedback image is diagnostic-only (never in the passthrough).
- **Handles (loopback only):** `image-feedback` input (fuchsia), `text`/`prompt`/`images` outputs. `image-feedback` is excluded from pin migration (`pinMigration.ts`) so it survives reload.
- **Fresh-conversation guard:** empty conversation ignores whatever's on the feedback pin (stale render).
- **maxTokens:** node default raised to 8192; enabling loopback bumps to ≥16384; UI cap 32768; API fallback 4096. (maxTokens is a ceiling, not a cost.)
- **Skill:** `src/store/execution/loopbackSkill.ts` — always sent fresh when `promptSkillName === LOOPBACK_SKILL_NAME` (no re-toggle needed for skill updates). Editing the system prompt clears that marker (respects user edits).
- **Key files:** `src/store/execution/llmGenerateExecutor.ts`, `loopbackSkill.ts`, `src/components/nodes/LLMGenerateNode.tsx`, `ControlPanel.tsx`, `src/store/utils/connectedInputs.ts`, `src/store/utils/pinMigration.ts`, `src/components/WorkflowCanvas.tsx`.

**User note for existing loopback nodes:** start a **fresh conversation** (Clear history → Send) so it captures the canonical initial prompt anchor.

**Open follow-up (not built):** optionally pin the image generator's **seed** for stability across iterations (recommended default + a re-roll escape hatch). Seed lives on the generator node's params, not the LLM node — only if the model exposes `seed`.

---

## 2. PENDING — Roto node sporadic bugs (INVESTIGATION IN PROGRESS)
User reports two sporadic Roto-node bugs:

- **(A) Node lost.** Refined repro (from user, Turkish): it happens **not on the first mask**, but when you **re-open an existing Roto node that already has mask state** — go back to edit an existing mask, OR add a NEW mask to the same node, make it, and **exit** → the node **disappears** from the canvas. → Strongly implicates the modal opening with existing roto state and **clobbering/losing the node on write-back at close** (stale `nodes` snapshot), or an **undo-snapshot desync**.
- **(B) Stale input.** After rewiring the Roto node's input to a different upstream, the **old input image still shows** inside the node/modal. → Likely a `sourceImage` cached on `node.data` that isn't refreshed on input change (or a modal reading a snapshot from open time).
- Both are intermittent.

**Unanswered diagnostic question for the user:** when the node is lost, does **Ctrl/Cmd+Z (undo)** bring it back? (Back = undo-snapshot desync; gone for good = stale-snapshot clobber on close.)

**Relevant files:** `src/components/RotoModal.tsx`, `src/components/nodes/RotoNode.tsx`, `src/store/rotoStore.ts`, `src/types/roto.ts`, `src/utils/rasterizeRoto.ts`. Touchpoints: `src/store/workflowStore.ts` (updateNodeData / addNode / pushUndo / undo / autosave / save-load), `src/store/utils/connectedInputs.ts` (roto input resolution), `src/store/utils/nodeDefaults.ts`, `src/store/execution/executeNode.ts` + `simpleNodeExecutors.ts`.

**Lead / precedent:** earlier this project had a "mesh lost after keyframing + undo" bug caused by `pushUndo` NOT snapshotting a field (`cameraPath`) → desync/loss on undo. Check whether `pushUndo`/undo snapshots ALL roto fields, and whether the modal's close write-back uses a stale `nodes` array captured at open.

**Investigation workflow (STOPPED — resume it):**
- Script: `…/workflows/scripts/roto-bug-investigation-wf_d864554a-d51.js`
- Resume: `Workflow({ scriptPath: "<that path>", resumeFromRunId: "wf_d864554a-d51" })` — completed agents return cached; map/diagnose/verify/synthesize phases. If cache is gone, just re-run the script (it's self-contained: maps 4 areas, diagnoses each symptom, adversarially verifies, synthesizes).

---

## 3. NEW REQUEST — "Sphere Light Render" node (spec from screenshot)
A self-contained **lighting-reference generator**: renders a grey matte sphere lit by a single light from a user-set direction, on a neutral grey backdrop with a cast shadow. Output feeds downstream as a light-direction reference (e.g., control/reference image for generation, or relighting).

**From the screenshot:**
- Title "Sphere Light Render" (sun/light icon). Render-time badge (e.g. `0.048s`) — fast local render.
- **No inputs.** One output handle **`render`** (image, right side).
- **Three slider params** (defaults = screenshot values):
  - `rotation` (light azimuth), default **-36**, range ~ -180..180
  - `elevation` (light vertical angle), default **27**, range ~ -90..90
  - `intensity`, default **3.0**, range ~ 0..10 (float)
- Live preview of the rendered sphere fills the node body; re-renders on slider change.

**Recommended implementation:** offscreen **Three.js** render (project already uses three + react-three) — `SphereGeometry` + grey `MeshStandardMaterial`, a `DirectionalLight` positioned from (azimuth=rotation, elevation) at `intensity`, a ground plane with shadows enabled, `WebGLRenderer` → `canvas.toDataURL()` → store as `outputImage`. (A 2D-canvas Lambert-shading + projected-shadow-ellipse fallback is possible but shadows are worse.)

**Add-node SOP (from CLAUDE.md "Adding New Node Types"):**
1. Data interface in `src/types/index.ts`: `SphereLightRenderNodeData { rotation:number; elevation:number; intensity:number; outputImage:string|null; ... }`
2. Add `sphereLightRender` to the `NodeType` union.
3. `createDefaultNodeData()` in `workflowStore.ts` (rotation:-36, elevation:27, intensity:3.0, outputImage:null).
4. `defaultDimensions` in `workflowStore.ts`.
5. Component `src/components/nodes/SphereLightRenderNode.tsx` — 3 sliders + Three.js offscreen render + preview + `render` output `<Handle>` (image type; use id `render` or `image`).
6. Export from `src/components/nodes/index.ts`.
7. Register in `nodeTypes` in `WorkflowCanvas.tsx`; add a minimap color.
8. `getSourceOutput()` in `src/store/utils/connectedInputs.ts`: `sphereLightRender` → `{ type:"image", value: data.outputImage }`.
9. Execution: render in-component on param change (updateNodeData({ outputImage })) and/or on Run; add a case in the executor if a Run path is needed.
10. Add to `ConnectionDropMenu.tsx` source lists.
11. Keyboard shortcut (optional) + docs in CLAUDE.md.

---

## Conventions & gotchas
- `getConnectedInputs()` returns `{ images, videos, audio, model3d, text, dynamicInputs, easeCurve, feedbackImage }`. Multi-output nodes dispatch by `sourceHandle` in `getSourceOutput`.
- Dynamic pins vs classic pins: classic image handle carries an array; dynamic pins are one-value-per-slot (`dynpin__{type}__{field}__{slot}`). Generators build from `dynamicInputs`; **Fal ignores the generic `images[]` when dynamicInputs are present** (Kie falls back to `images[]`).
- Memory dir: `C:\Users\capoom\.claude\projects\C--Users-capoom-node-banana-capoom\memory\` (see `MEMORY.md`). Key feedback memory: user wants one-button automation that is **legible** (visible reasoning), not silent or gated.
- Windows shell: Git Bash available; use `git -C <path>` to avoid `cd` permission prompts.

---

## Splat viewer distribution — DECISION (2026-07-11): move to Option A (reverse-proxy). NOT YET IMPLEMENTED.

**Decision:** stop compiling the splat viewer into node-banana. Instead consume the ONE hosted build (served by the render-tracking-viewer's Caddy on OTOSERVE10) by **reverse-proxying it under node-banana's own origin**. Same-origin is preserved, so `blob:` splat URLs, the `sessionStorage` handoff, and `postMessage` capture-back keep working unchanged. This supersedes the current git-dependency setup, which stays in place and working until the switch is made.

Why the reverse-proxy (not a plain iframe to the OTOSERVE10 URL): a cross-origin viewer can't read node-banana's `blob:` URLs / `sessionStorage` and can't `postMessage` back without an origin-allowlisted protocol. The proxy makes the hosted viewer appear to come from node-banana's own origin, so all of that keeps working with zero viewer changes.

### Topology (the shared model)
- **Host:** render-tracking-viewer's Caddy serves `D:/Projects/AD` at `http://OTOSERVE10:8080`. The splat-viewer build lives at `D:/Projects/AD/_viewer/` → `http://OTOSERVE10:8080/_viewer/`.
- **Build/deploy clone:** `C:\caddy\splat-viewer-src` (a clone of `gitcapoom/splat-viewer`) → `git pull` + `npm run build` → copy `dist/*` to `D:/Projects/AD/_viewer/`.
- **render-tracking-viewer** already consumes `/_viewer/` same-origin (its `viewer.html` overlay). node-banana is the only consumer that still needs migrating.
- Same pattern is planned for the **vp-projector** viewer at `/_projector/` (not served yet).

### Implementation steps (future session)
1. `next.config.ts` — add a rewrite so node-banana serves the hosted viewer under its own origin:
   ```ts
   async rewrites() {
     return [{ source: "/viewer/:path*", destination: "http://OTOSERVE10:8080/_viewer/:path*" }];
   }
   ```
   **Caveat:** node-banana's OWN routes `/viewer/pano` and `/viewer/[worldId]` must keep working. Next checks filesystem routes before `afterFiles` rewrites, so those app routes win; only bare `/viewer` (+ its asset subpaths) should hit the proxy. So **remove `src/app/viewer/page.tsx`** to un-shadow the root `/viewer`. The viewer build uses relative asset paths (`base: "./"`), so `/viewer/assets/*` proxies to `/_viewer/assets/*` correctly.
2. Confirm a splat still loads: `window.open('/viewer?url=blob:...')` opens same-origin (node-banana) → `blob:` fetchable, capture-back `postMessage` still same-origin.
3. Once confirmed, remove the git-dependency wiring (keep until step 2 passes, as fallback):
   - `"splat-viewer"` from `package.json` dependencies
   - `transpilePackages: ["splat-viewer"]` from `next.config.ts`
   - `@source ".../node_modules/splat-viewer/src"` from `src/app/globals.css`
4. The deploy repo (`master`) needs the same rewrite; no npm dependency after removal.

### Tradeoff to remember
Shared build = a viewer regression hits all consumers at once. Use versioned host paths (`/_viewer/vN/`) so an app can pin a known-good build.
