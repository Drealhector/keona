import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Keona's persistent memory. Since the move off localhost, Convex holds EVERYTHING:
// eyes (with their latest frame + clip), watches, alerts, taught targets, chat history.
export default defineSchema({
  devices: defineTable({
    name: v.string(),
    kind: v.optional(v.string()),   // "iPhone", "Samsung", "Windows laptop", ...
    lastSeen: v.number(),
  }),

  eyes: defineTable({
    eyeId: v.string(),               // the /join?eye=ID id
    name: v.string(),
    pos: v.optional(v.string()),     // position / angle label
    online: v.boolean(),
    lastSeen: v.number(),
    frame: v.optional(v.string()),   // latest snapshot as a data URL (replaced in place)
    frameAt: v.optional(v.number()),
    clipId: v.optional(v.id("_storage")), // latest ~8s clip (old file deleted on replace)
    clipAt: v.optional(v.number()),
  }).index("by_eyeId", ["eyeId"]),

  // "Watching for..." — the standing guards / pattern engine.
  patterns: defineTable({
    name: v.string(),
    type: v.optional(v.string()),    // face_watch, object_watch, fall_detection, ...
    condition: v.string(),
    scope: v.string(),               // "all" or a specific eyeId
    targetName: v.optional(v.string()),
    priority: v.optional(v.number()),
    cooldownMs: v.number(),
    active: v.boolean(),
    lastFired: v.number(),
  }).index("by_active", ["active"]),

  // Taught references (a face/object Keona was shown and named).
  watch_targets: defineTable({
    name: v.string(),
    storageId: v.id("_storage"),
  }).index("by_name", ["name"]),

  // Analyzed frames/clips kept for history and old-vs-new comparison.
  media_assets: defineTable({
    eyeId: v.string(),
    storageId: v.id("_storage"),
    at: v.number(),
    note: v.optional(v.string()),
  }).index("by_eye", ["eyeId"]),

  alerts: defineTable({
    guardName: v.string(),
    eyeName: v.string(),
    summary: v.string(),
    severity: v.optional(v.string()),
    at: v.number(),
  }).index("by_at", ["at"]),

  conversations: defineTable({
    role: v.string(),                // "user" | "assistant"
    text: v.string(),
    at: v.number(),
  }).index("by_at", ["at"]),
});
