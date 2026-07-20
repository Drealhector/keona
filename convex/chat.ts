import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Recent conversation with Keona, persisted so she remembers across deploys.
export const recent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_at")
      .order("desc")
      .take(16);
    return rows.reverse().map((r) => ({ role: r.role, text: r.text }));
  },
});

export const append = internalMutation({
  args: { role: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("conversations", {
      role: args.role,
      text: args.text,
      at: Date.now(),
    });
    return null;
  },
});
