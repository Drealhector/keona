import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

// Persistent chat feed. No `since` -> the last 16 messages (page load).
// With `since` -> everything newer (the control room polls this, so Keona's
// alert messages arrive as chat bubbles).
export const history = query({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.since !== undefined) {
      const since = args.since;
      const rows = await ctx.db
        .query("conversations")
        .withIndex("by_at", (q) => q.gt("at", since))
        .take(100);
      return rows.map((r) => ({ role: r.role, text: r.text, at: r.at }));
    }
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_at")
      .order("desc")
      .take(16);
    return rows.reverse().map((r) => ({ role: r.role, text: r.text, at: r.at }));
  },
});

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
    const at = Date.now();
    await ctx.db.insert("conversations", {
      role: args.role,
      text: args.text,
      at,
    });
    return at;
  },
});
