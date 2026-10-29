"use strict";
const assert = require("node:assert/strict");

// Invoked in fresh processes, without the integration suite's two-turn override.
module.exports = async function lookupBudgetTests(h) {
  const { ext, SessionManager, root, makeContext, assistant, text, toolCall, toolText, user, expected } = h;
  console.log(`== Lookup budget: ${expected} substantive turns, ${expected * 3} total model calls ==`);
  const manager = SessionManager.inMemory(root);
  manager.appendMessage(user("SEARCH_TARGET\n" + Array.from({ length: expected * 3 + 5 }, (_, i) => `PAGE_MATCH_${i}`).join("\n")));
  const ctx = makeContext(manager, root);
  const run = async (script) => {
    let calls = 0;
    const result = await ext.tools.context_lookup.execute("budget-query", { question: "Recover earlier evidence" }, undefined, undefined, {
      ...ctx, modelRegistry: { complete: async (_model, context) => script(++calls, context) },
    });
    return { answer: toolText(result), calls };
  };
  const response = (call) => assistant([call], "toolUse");
  const writeup = (context) => {
    const tools = context.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []);
    assert.equal(tools.length, 0, "one final tool-free write-up follows the configured ceiling");
    assert(JSON.stringify(context.messages.at(-1)).includes("incomplete search does not establish absence"));
    return assistant([text("Budget-limited findings.")]);
  };

  const substantive = await run((turn, context) => turn <= expected
    ? response(toolCall("grep", { pattern: "^SEARCH_TARGET$", before: 0, after: 0 }, `search-${turn}`))
    : writeup(context));
  assert.equal(substantive.calls, expected + 1);
  assert(substantive.answer.includes(`${expected}-turn limit`));
  assert(substantive.answer.includes("context_show_entry"));

  // One substantive query followed only by legitimate continuation pages still
  // stops at 3x the configured budget, plus the single write-up call.
  const grep = { pattern: "^PAGE_MATCH_", before: 0, after: 0, maxMatches: 1 };
  const paged = await run((turn, context) => {
    if (turn > expected * 3) return writeup(context);
    let next = {};
    if (turn > 1) {
      const last = context.messages.filter((m) => m.role === "toolResult").at(-1);
      const match = /Continue with the same parameters and offset=(\d+)(?:, charOffset=(\d+))?(?:, throughEntry="([^"]+)")?\.\]$/.exec(toolText(last));
      assert(match, "paging follows only issued cursors");
      next = { offset: Number(match[1]), ...(match[2] !== undefined ? { charOffset: Number(match[2]) } : {}), ...(match[3] ? { throughEntry: match[3] } : {}) };
    }
    return response(toolCall("grep", { ...grep, ...next }, `page-${turn}`));
  });
  assert.equal(paged.calls, expected * 3 + 1);
  assert(paged.answer.includes(`${expected * 3}-call total limit`));
  assert(paged.answer.endsWith("rather than immediately repeating context_lookup."));
};
