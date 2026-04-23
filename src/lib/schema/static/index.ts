/**
 * Single entry point for static schemas. Each provider's static helper is
 * exposed; the warmer calls these as a fallback after the dynamic path fails.
 */

export { getKieStaticSchema } from "./kie";
export { getGeminiStaticSchema } from "./gemini";
export { getWaveSpeedStaticSchema } from "./wavespeed";
export { getMuapiSlugSchema } from "./muapi";
