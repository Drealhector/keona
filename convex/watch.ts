// The pattern engine, Convex-style. A minute cron fans out short "passes"
// (every ~8s) via the scheduler. Each pass checks active guards x live eyes.
// When no guards are active the cron exits after one cheap query — zero
// Gemini calls, zero scheduled work.
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { blobPart, checkMedia, imagePart, type Part } from "./brain";

const PASS_GAP_MS = 8000;
const CLIP_FRESH_MS = 30000;
const MOTION_FRESH_MS = 20000; // quiet eyes (no movement this recently) are skipped

export const minute = internalAction({
  args: {},
  handler: async (ctx) => {
    const actives = await ctx.runQuery(api.guards.listActive, {});
    if (!actives.length) return null;
    for (let i = 0; i * PASS_GAP_MS < 60000; i++) {
      await ctx.scheduler.runAfter(i * PASS_GAP_MS, internal.watch.pass, {});
    }
    return null;
  },
});

export const pass = internalAction({
  args: {},
  handler: async (ctx) => {
    const actives = await ctx.runQuery(api.guards.listActive, {});
    const eyes = await ctx.runQuery(internal.eyes.live, {});
    if (!actives.length || !eyes.length) return null;

    for (const g of actives) {
      // Load the taught target once per guard, not once per eye.
      let target: Part | null = null;
      if (g.targetName) {
        const t = await ctx.runQuery(internal.targets.byName, { name: g.targetName });
        if (t) {
          const blob = await ctx.storage.get(t.storageId);
          if (blob) target = await blobPart(blob, "image/jpeg");
        }
      }
      for (const e of eyes) {
        if (g.scope && g.scope !== "all" && g.scope !== e.eyeId) continue;
        // Quiet scene = no Gemini call. motionAt null means an older eye page
        // that can't report motion — check those the old way to stay correct.
        const clipFresh = e.clipId !== null && Date.now() - e.clipAt < CLIP_FRESH_MS;
        const motionFresh = e.motionAt === null || Date.now() - e.motionAt < MOTION_FRESH_MS;
        if (!clipFresh && !motionFresh) continue;
        try {
          // Prefer a fresh clip (real motion over time); fall back to the frame.
          let media: Part = imagePart(e.frame);
          if (clipFresh && e.clipId) {
            const blob = await ctx.storage.get(e.clipId);
            if (blob) media = await blobPart(blob, "video/webm");
          }
          const { seen, text } = await checkMedia(media, g.condition, target);
          if (seen) {
            const summary = (text || "").split("\n").slice(1).join(" ").trim() || g.condition;
            await ctx.runMutation(internal.guards.fire, { id: g.id, eyeName: e.name, summary });
          }
        } catch (err) {
          console.error(`[watch] check error: ${(err as Error).message}`);
        }
      }
    }
    return null;
  },
});
