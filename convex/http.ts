// Keona's public doors — the same routes the old Node server exposed, now
// served by Convex at https://<deployment>.convex.site. The pages live on
// Vercel, so every route answers with CORS headers.
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { b64decode, parseDataUrl } from "./b64";
import { chatLogic, lookLogic, sceneLogic, watchOnceLogic } from "./brain";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

const http = httpRouter();

// Register OPTIONS alongside every path so browser preflights always pass.
const PATHS = [
  "/create-eye", "/frame", "/clip", "/eyes", "/known", "/teach", "/remove-eye",
  "/chat", "/scene", "/look", "/watch", "/guards", "/guards/stop", "/alerts",
];
for (const path of PATHS) http.route({ path, method: "OPTIONS", handler: preflight });

// Create a named eye slot up front, then share its link.
http.route({
  path: "/create-eye",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { name, pos } = await req.json();
    const id: string = await ctx.runMutation(api.eyes.create, { name, pos });
    return json({ id });
  }),
});

// A device reports a frame for its eye.
http.route({
  path: "/frame",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { id, name, pos, image } = await req.json();
    if (!id || !image) return json({ error: "id and image required" }, 400);
    const r: { guardsActive: boolean } = await ctx.runMutation(api.eyes.reportFrame, {
      eyeId: id, name, pos, frame: image,
    });
    return json({ ok: true, guardsActive: r.guardsActive });
  }),
});

// Returns the actual image bytes so the pages can use it directly as an
// <img src> (the old server returned JSON here, which could never render).
http.route({
  path: "/frame",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const r: { image: string | null } = await ctx.runQuery(api.eyes.getFrame, { eyeId: id });
    if (!r.image) return new Response(null, { status: 404, headers: CORS });
    const { mimeType, data } = parseDataUrl(r.image);
    return new Response(b64decode(data), {
      status: 200,
      headers: { "Content-Type": mimeType, "Cache-Control": "no-store", ...CORS },
    });
  }),
});

// A device uploads its latest short clip (raw video bytes, ?eye=ID).
http.route({
  path: "/clip",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const eyeId = new URL(req.url).searchParams.get("eye");
    if (!eyeId) return json({ error: "eye required" }, 400);
    const blob = await req.blob();
    if (blob.size === 0) return json({ error: "empty clip" }, 400);
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(api.eyes.setClip, { eyeId, storageId });
    return json({ ok: true });
  }),
});

// Remove an eye completely (card, stored clip, everything).
http.route({
  path: "/remove-eye",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { id } = await req.json();
    if (!id) return json({ error: "id required" }, 400);
    await ctx.runMutation(api.eyes.remove, { eyeId: String(id) });
    return json({ ok: true });
  }),
});

// List every eye (live or still waiting), with a green/grey status.
http.route({
  path: "/eyes",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const eyes = await ctx.runQuery(api.eyes.list, {});
    return json({ eyes });
  }),
});

http.route({
  path: "/known",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const names: string[] = await ctx.runQuery(api.targets.known, {});
    return json({ names });
  }),
});

// Teach: save one eye's current frame under a name.
http.route({
  path: "/teach",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { id, name } = await req.json();
      const safe = String(name ?? "").replace(/[^a-zA-Z0-9 _-]/g, "").trim();
      if (!safe) return json({ error: "Please give it a name." }, 400);
      const { image } = await ctx.runQuery(api.eyes.getFrame, { eyeId: String(id ?? "") });
      if (!image) return json({ error: "that eye is offline" }, 404);
      const { mimeType, data } = parseDataUrl(image);
      const storageId = await ctx.storage.store(new Blob([b64decode(data)], { type: mimeType }));
      await ctx.runMutation(internal.targets.save, { name: safe, storageId });
      return json({ ok: true, name: safe });
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }),
});

// Chat with Keona — she answers using what her eyes see right now.
http.route({
  path: "/chat",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { message, image } = await req.json();
      const r = await chatLogic(ctx, { message, image });
      return json(r);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }),
});

// What do you see across ALL eyes right now?
http.route({
  path: "/scene",
  method: "GET",
  handler: httpAction(async (ctx) => {
    try {
      const text = await sceneLogic(ctx);
      return json({ text });
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }),
});

// Describe one eye.
http.route({
  path: "/look",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { id } = await req.json();
      const text = await lookLogic(ctx, String(id ?? ""));
      if (text === null) return json({ error: "that eye is offline" }, 404);
      return json({ text });
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }),
});

// Watch one eye for an uploaded target (one-off check).
http.route({
  path: "/watch",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const { id, targetImage } = await req.json();
      const r = await watchOnceLogic(ctx, String(id ?? ""), String(targetImage ?? ""));
      if (r === null) return json({ error: "that eye is offline", seen: false }, 404);
      return json(r);
    } catch (err) {
      return json({ error: (err as Error).message, seen: false }, 500);
    }
  }),
});

// Create a standing guard directly.
http.route({
  path: "/guards",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { condition, name, scope, targetName } = await req.json();
    if (!condition) return json({ error: "condition required" }, 400);
    const id = await ctx.runMutation(api.guards.create, {
      name: name || condition,
      condition,
      scope: scope || "all",
      targetName: targetName || null,
    });
    return json({ id });
  }),
});

http.route({
  path: "/guards",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const guards = await ctx.runQuery(api.guards.listActive, {});
    return json({ guards });
  }),
});

http.route({
  path: "/guards/stop",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { id } = await req.json();
    await ctx.runMutation(api.guards.stop, { id });
    return json({ ok: true });
  }),
});

http.route({
  path: "/alerts",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
    const alerts = await ctx.runQuery(api.alerts.since, { since });
    return json({ alerts });
  }),
});

export default http;
