import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const add = mutation({
  args: { guardName: v.string(), eyeName: v.string(), summary: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("alerts", args);
  },
});

// Alerts newer than a timestamp (id = at, so the control room can poll for new ones).
export const since = query({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_at", (q) => q.gt("at", args.since))
      .collect();
    return rows.map((r) => ({ id: r.at, guardName: r.guardName, eyeName: r.eyeName, summary: r.summary, at: r.at }));
  },
});
