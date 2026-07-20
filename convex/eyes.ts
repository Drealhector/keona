import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ONLINE_MS = 15000; // an eye is "live" if it sent a frame this recently

// Create a named eye slot up front, then share its /join?eye=ID link.
export const create = mutation({
  args: { name: v.optional(v.string()), pos: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const eyeId = "eye_" + Math.random().toString(36).slice(2, 9);
    await ctx.db.insert("eyes", {
      eyeId,
      name: args.name?.trim() || "Eye",
      pos: args.pos?.trim() || "",
      online: false,
      lastSeen: 0,
    });
    return eyeId;
  },
});

// A device reports a frame for its eye. Pre-set name/position win over the
// device's defaults (same behavior as the original server). Returns whether
// any guard is active so the eye knows to record clips.
export const reportFrame = mutation({
  args: {
    eyeId: v.string(),
    name: v.optional(v.string()),
    pos: v.optional(v.string()),
    frame: v.string(),
    moving: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("eyes")
      .withIndex("by_eyeId", (q) => q.eq("eyeId", args.eyeId))
      .unique();
    // moving === false -> quiet heartbeat, keep the old motion stamp.
    // moving === true or undefined (older eye pages) -> count as movement now.
    const motionAt = args.moving === false ? (existing?.motionAt ?? 0) : now;
    if (existing) {
      await ctx.db.patch("eyes", existing._id, {
        name: existing.name || args.name || "Eye",
        pos: existing.pos ?? (args.pos || ""),
        frame: args.frame,
        frameAt: now,
        lastSeen: now,
        online: true,
        motionAt,
      });
    } else {
      // Device self-joined via /join without a pre-created slot.
      await ctx.db.insert("eyes", {
        eyeId: args.eyeId,
        name: args.name || "Eye",
        pos: args.pos || "",
        frame: args.frame,
        frameAt: now,
        lastSeen: now,
        online: true,
        motionAt,
      });
    }
    const anyGuard = await ctx.db
      .query("patterns")
      .withIndex("by_active", (q) => q.eq("active", true))
      .first();
    return { guardsActive: anyGuard !== null };
  },
});

// Attach the latest ~8s clip to an eye, deleting the previous clip file so
// storage never accumulates (each eye owns at most one stored clip).
export const setClip = mutation({
  args: { eyeId: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const eye = await ctx.db
      .query("eyes")
      .withIndex("by_eyeId", (q) => q.eq("eyeId", args.eyeId))
      .unique();
    if (!eye) {
      await ctx.storage.delete(args.storageId); // orphan upload, drop it
      return null;
    }
    if (eye.clipId) await ctx.storage.delete(eye.clipId);
    await ctx.db.patch("eyes", eye._id, { clipId: args.storageId, clipAt: Date.now() });
    return null;
  },
});

// Remove an eye completely: its card, its stored clip, everything.
export const remove = mutation({
  args: { eyeId: v.string() },
  handler: async (ctx, args) => {
    const eye = await ctx.db
      .query("eyes")
      .withIndex("by_eyeId", (q) => q.eq("eyeId", args.eyeId))
      .unique();
    if (!eye) return null;
    if (eye.clipId) await ctx.storage.delete(eye.clipId);
    await ctx.db.delete(eye._id);
    return null;
  },
});

// List every eye (live or still waiting), with a green/grey status.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("eyes").take(200);
    return rows.map((e) => ({
      id: e.eyeId,
      name: e.name,
      pos: e.pos ?? "",
      online: !!e.frame && now - e.lastSeen < ONLINE_MS,
    }));
  },
});

export const getFrame = query({
  args: { eyeId: v.string() },
  handler: async (ctx, args) => {
    const eye = await ctx.db
      .query("eyes")
      .withIndex("by_eyeId", (q) => q.eq("eyeId", args.eyeId))
      .unique();
    return { image: eye?.frame ?? null };
  },
});

// Live eyes with media, for the brain and the watch loop.
export const live = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("eyes").take(200);
    return rows
      .filter((e) => !!e.frame && now - e.lastSeen < ONLINE_MS)
      .map((e) => ({
        eyeId: e.eyeId,
        name: e.name,
        pos: e.pos ?? "",
        frame: e.frame as string,
        clipId: e.clipId ?? null,
        clipAt: e.clipAt ?? 0,
        motionAt: e.motionAt ?? null, // null = older doc, motion unknown
      }));
  },
});
