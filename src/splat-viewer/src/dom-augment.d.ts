// Ambient DOM augmentations for the shared viewer source.
//
// `MediaStreamVideoTrack` is defined by the W3C MediaStreamTrack Insertable
// Media Processing (mediacapture-transform) spec but is not yet part of
// TypeScript's bundled lib.dom.d.ts. videoExport.ts casts a captured track to
// it to reach the non-standard `requestFrame()`. Declaring it as a plain
// MediaStreamTrack alias keeps that cast type-checking in any consumer (the
// standalone Vite build and node-banana's Next build alike) without touching
// the viewer logic.
interface MediaStreamVideoTrack extends MediaStreamTrack {}
