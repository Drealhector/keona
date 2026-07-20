import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Create a standing watch ("guard").
export const create = mutation({
  args: {
    name: v.string(),
    condition: v.string(),
    scope: v.string(),
    targetName: v.optional(v.union(v.string(), v.null())),
    cooldownMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("patterns", {
      name: args.name,
      condition: args.condition,
      scope: args.scope,
      targetName: args.targetName ?? undefined,
      cooldownMs: args.cooldownMs ?? 20000,
      active: true,
      lastFired: 0,
    });
  },
});

// All active watches.
export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("patterns")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map((r) => ({
      id: r._id,
      name: r.name,
      condition: r.condition,
      scope: r.scope,
      targetName: r.targetName ?? null,
      cooldownMs: r.cooldownMs,
      lastFired: r.lastFired,
    }));
  },
});

export const stop = mutation({
  args: { id: v.id("patterns") },
  handler: async (ctx, args) => { await ctx.db.patch(args.id, { active: false }); },
});

export const markFired = mutation({
  args: { id: v.id("patterns"), at: v.number() },
  handler: async (ctx, args) => { await ctx.db.patch(args.id, { lastFired: args.at }); },
});

// Fire a guard atomically: the cooldown check, the lastFired stamp, and the
// alert insert happen in ONE transaction, so overlapping watch passes can
// never double-alert for the same sighting.
export const fire = internalMutation({
  args: { id: v.id("patterns"), eyeName: v.string(), summary: v.string() },
  handler: async (ctx, args) => {
    const g = await ctx.db.get(args.id);
    if (!g || !g.active) return false;
    const now = Date.now();
    if (now - g.lastFired <= g.cooldownMs) return false;
    await ctx.db.patch(args.id, { lastFired: now });
    await ctx.db.insert("alerts", {
      guardName: g.name,
      eyeName: args.eyeName,
      summary: args.summary,
      at: now,
    });
    return true;
  },
});
