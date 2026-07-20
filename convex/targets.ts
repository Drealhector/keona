import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

// Save (or replace) a taught reference under a name. The old stored file is
// deleted on replace so each name owns exactly one image.
export const save = internalMutation({
  args: { name: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("watch_targets")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (existing) {
      await ctx.storage.delete(existing.storageId);
      await ctx.db.patch("watch_targets", existing._id, { storageId: args.storageId });
    } else {
      await ctx.db.insert("watch_targets", { name: args.name, storageId: args.storageId });
    }
    return null;
  },
});

export const known = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("watch_targets").take(200);
    return rows.map((r) => r.name);
  },
});

// Case-insensitive lookup (matches the old server's behavior).
export const byName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("watch_targets").take(200);
    const hit = rows.find((r) => r.name.toLowerCase() === args.name.toLowerCase());
    return hit ? { name: hit.name, storageId: hit.storageId } : null;
  },
});
