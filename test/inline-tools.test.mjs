import assert from "node:assert/strict"
import test from "node:test"
import { onProvider } from "../dock-tools.middleware.js"
import { rewriteInlineTools } from "../lib/inline-tools.mjs"

const explore = {
  name: "mcp__codegraph__codegraph_explore",
  description: "explore",
  input_schema: { type: "object", properties: { query: { type: "string" } } },
}

function addition(definition = explore) {
  return { type: "tool_addition", tool: { type: "tool_definition", definition } }
}

test("tool_addition tool_definition becomes tool_reference and the schema is hoisted", () => {
  const body = {
    tools: [{ name: "Bash", description: "shell" }],
    messages: [{ role: "system", content: [{ type: "text", text: "keep" }, addition()] }],
  }
  assert.equal(rewriteInlineTools(body), true)
  assert.deepEqual(body.messages[0].content[1], {
    type: "tool_addition",
    tool: { type: "tool_reference", tool_name: explore.name },
  })
  assert.equal(body.messages[0].content[0].text, "keep")
  assert.equal(body.tools.length, 2)
  assert.equal(body.tools[1], explore)
})

test("an existing tool of the same name is kept", () => {
  const existing = { name: explore.name, description: "already declared" }
  const body = { tools: [existing], messages: [{ role: "system", content: [addition()] }] }
  rewriteInlineTools(body)
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0], existing)
  assert.equal(body.messages[0].content[0].tool.tool_name, explore.name)
})

test("a tool_definition nested in tool_result is hoisted and rewritten", () => {
  const body = {
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: [addition().tool, { type: "text", text: "ok" }] }],
    }],
  }
  rewriteInlineTools(body)
  assert.deepEqual(body.messages[0].content[0].content[0], { type: "tool_reference", tool_name: explore.name })
  assert.equal(body.messages[0].content[0].content[1].text, "ok")
  assert.equal(body.tools[0].name, explore.name)
})

test("a body with no inline definition is left alone", () => {
  const body = {
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }
  assert.equal(rewriteInlineTools(body), false)
  assert.equal(body.messages[0].content[0].text, "hi")
  assert.equal(Object.hasOwn(body, "tools") && body.tools.length, 1)
})

test("onProvider rewrites only the dock anthropic try", () => {
  const dock = { messages: [{ role: "system", content: [addition()] }] }
  assert.equal(onProvider(dock, { provider: { id: "dock" }, protocol: "anthropic" }), dock)
  assert.equal(dock.messages[0].content[0].tool.type, "tool_reference")

  const other = { messages: [{ role: "system", content: [addition()] }] }
  assert.equal(onProvider(other, { provider: { id: "zcode" }, protocol: "anthropic" }), undefined)
  assert.equal(other.messages[0].content[0].tool.type, "tool_definition")

  const chat = { messages: [{ role: "system", content: [addition()] }] }
  assert.equal(onProvider(chat, { provider: { id: "dock" }, protocol: "chat" }), undefined)
  assert.equal(chat.messages[0].content[0].tool.type, "tool_definition")
})
