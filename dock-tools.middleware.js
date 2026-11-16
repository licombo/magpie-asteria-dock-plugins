// Magpie gateway middleware for the dock provider. Loaded because package.json
// sets magpie.middleware. onProvider runs once per upstream try and starts from
// the body onRequest left, so a rewrite here does not leak onto the next provider.

import { rewriteInlineTools } from "./lib/inline-tools.mjs"

export function onProvider(body, ctx) {
  if (!body || ctx?.provider?.id !== "dock") return
  if (ctx.protocol && ctx.protocol !== "anthropic") return
  if (!rewriteInlineTools(body)) return
  return body
}
