"use strict";

// Drive the settings command's apply path without rendering a terminal. The menu
// itself is covered separately with real keyboard events and rendered frames.
module.exports = async function settingsTestHelpers(jiti, root) {
  const path = require("node:path");
  const config = await jiti.import(path.join(root, "extensions/lib/config.ts"));
  const { capDescription } = await jiti.import(path.join(root, "extensions/index.ts"));
  const updateSettings = async (ext, ctx, changes, scope = "session") => {
    await ext.commands["compact-settings"].handler("", { ...ctx, mode: "tui", hasUI: true,
      isIdle: ctx.isIdle ?? (() => true), hasPendingMessages: ctx.hasPendingMessages ?? (() => false),
      reload: ctx.reload ?? (async () => {}),
      ui: { ...ctx.ui, custom: async () => ({ changes, scope }) },
    });
  };
  const preferences = (ctx, settings = {}) => config.sessionPreferences(typeof settings === "function" ? settings() : settings, ctx.sessionManager.getBranch());
  const capControl = (ext, settings = {}) => ({ handler: async (args, ctx) => {
    const previous = preferences(ctx, settings), words = args.trim().split(/\s+/).filter(Boolean);
    const mode = ["on", "off", "warn"].includes(words[0]) ? words.shift() : previous.capMode;
    const budget = words.length === 0 ? previous.capBudget : words.length === 1 ? config.parseCapBudget(words[0]) : undefined;
    if (!budget) { ctx.ui.notify("Invalid cap budget", "error"); return; }
    const changes = {};
    if (mode !== previous.capMode) changes.capMode = mode;
    if (JSON.stringify(budget) !== JSON.stringify(previous.capBudget)) changes.capBudget = budget;
    if (Object.keys(changes).length) await updateSettings(ext, ctx, changes);
    const next = preferences(ctx, settings);
    ctx.ui.notify(capDescription({ mode: next.capMode, budget: next.capBudget }, ctx.model?.contextWindow), "info");
  } });
  return { updateSettings, preferences, capControl, config };
};
