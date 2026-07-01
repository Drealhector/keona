import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import * as brain from "./lib/brain.js";

const memoryDir = new URL("./memory/", import.meta.url);
await mkdir(memoryDir, { recursive: true });

// id -> { name, pos, image (data URL or null), at }
const eyes = new Map();
const ONLINE_MS = 15000;        // an eye is "live" if it sent a frame this recently
const chat = [];                // recent conversation with Keona: { role, text }
let eyeCount = 0;

// Pattern engine: standing guards + the alerts they raise.
const guards = new Map();        // id -> { name, condition, scope, targetName, active, cooldownMs, lastFired }
let guardCount = 0;
const alerts = [];               // { id, guardName, eyeName, summary, at }
let alertCount = 0;

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  return m ? { mimeType: m[1], data: m[2] } : { mimeType: "image/jpeg", data: dataUrl.split(",")[1] };
}
async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}
async function loadKnown() {
  const files = (await readdir(memoryDir)).filter((f) => f.endsWith(".jpg"));
  return Promise.all(files.map(async (f) => ({
    name: f.replace(/\.jpg$/, ""),
    base64: (await readFile(new URL(f, memoryDir))).toString("base64"),
  })));
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
async function targetByName(name) {
  if (!name) return null;
  const known = await loadKnown();
  const k = known.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return k ? `data:image/jpeg;base64,${k.base64}` : null;
}
async function page(res, file) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(await readFile(new URL(file, import.meta.url)));
}
function liveEyes() {
  const now = Date.now();
  return [...eyes.entries()].filter(([, e]) => e.image && now - e.at < ONLINE_MS);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/") return page(res, "./index.html");
  if (req.method === "GET" && path === "/join") return page(res, "./join.html");

  // Create a named eye slot up front, then share its link.
  if (req.method === "POST" && path === "/create-eye") {
    const { name, pos } = await readJsonBody(req);
    const id = "eye" + (++eyeCount);
    eyes.set(id, { name: name?.trim() || ("Eye " + eyeCount), pos: pos?.trim() || "", image: null, at: 0 });
    return send(res, 200, { id });
  }

  // A device reports a frame for its eye (keeps the slot's pre-set name/position).
  if (req.method === "POST" && path === "/frame") {
    const { id, name, pos, image } = await readJsonBody(req);
    const prev = eyes.get(id);
    eyes.set(id, {
      name: prev?.name || name || "Eye",
      pos: prev?.pos ?? (pos || ""),
      image,
      at: Date.now(),
    });
    return send(res, 200, { ok: true });
  }

  // List every eye (live or still waiting), with a green/grey status.
  if (req.method === "GET" && path === "/eyes") {
    const now = Date.now();
    const list = [...eyes.entries()].map(([id, e]) => ({
      id, name: e.name, pos: e.pos,
      online: !!e.image && now - e.at < ONLINE_MS,
    }));
    return send(res, 200, { eyes: list });
  }

  if (req.method === "GET" && path === "/frame") {
    const e = eyes.get(url.searchParams.get("id"));
    return send(res, 200, { image: e?.image ?? null });
  }

  if (req.method === "GET" && path === "/known") {
    const known = await loadKnown();
    return send(res, 200, { names: known.map((k) => k.name) });
  }

  // Chat with Keona — she answers using what her eyes see right now (+ any uploaded picture).
  if (req.method === "POST" && path === "/chat") {
    try {
      const { message, image } = await readJsonBody(req);

      // Talk-to-guard: "tell me when / alert me if / watch for ..." creates a standing guard.
      if (message && /\b(tell me|let me know|alert me|notify me|watch|keep watch|look out)\b.*\b(when|if|for)\b/i.test(message)) {
        const condition = (message.replace(/^.*?\b(when|if|for)\b/i, "").trim()) || message.trim();
        const knownNames = (await loadKnown()).map((k) => k.name);
        const targetName = knownNames.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message)) || null;
        const id = "g" + (++guardCount);
        guards.set(id, { name: condition.slice(0, 70), condition, scope: "all", targetName, active: true, cooldownMs: 20000, lastFired: 0 });
        const reply = `On it — I'm now watching all my eyes and I'll alert you: "${condition}"${targetName ? ` (looking specifically for ${targetName})` : ""}. I'll ping you the moment it happens.`;
        chat.push({ role: "user", text: message }); chat.push({ role: "assistant", text: reply });
        if (chat.length > 16) chat.splice(0, chat.length - 16);
        return send(res, 200, { text: reply, guardCreated: true });
      }

      const parts = [];
      const live = liveEyes();
      for (const [, e] of live) {
        parts.push(brain.textPart(`(Your eye "${e.name}"${e.pos ? " — " + e.pos : ""} currently sees:)`));
        parts.push(brain.imagePart(e.image));
      }
      if (image) {
        parts.push(brain.textPart("(The owner uploaded this picture:)"));
        parts.push(brain.imagePart(image));
      }
      if (!live.length && !image) {
        parts.push(brain.textPart("(You have no eyes open right now, so you genuinely cannot see anything at the moment. Do not invent or guess a scene — say plainly that no eyes are open.)"));
      }
      parts.push(brain.textPart(message || "(no message)"));

      const system = "You are Keona, a warm, friendly AI that sees through the eyes shown to you. You are chatting with your owner like a real person who has eyes. Use what your eyes currently see to answer naturally. If the owner uploads a picture and asks you to look out for it, clearly acknowledge what you'll watch for. Never use the word 'camera' — always say 'eye' or 'eyes'. Be warm, natural, and concise.";
      const text = await brain.converse(chat, parts, system);
      chat.push({ role: "user", text: message || "(sent a picture)" });
      chat.push({ role: "assistant", text });
      if (chat.length > 16) chat.splice(0, chat.length - 16);
      return send(res, 200, { text });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // Describe one eye.
  if (req.method === "POST" && path === "/look") {
    try {
      const { id } = await readJsonBody(req);
      const e = eyes.get(id);
      if (!e?.image) return send(res, 404, { error: "that eye is offline" });
      const text = await brain.analyzeImage(e.image, "In one or two short sentences, plainly describe what you see.");
      return send(res, 200, { text });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // What do you see across ALL eyes right now? One natural, narrated report.
  if (req.method === "GET" && path === "/scene") {
    try {
      const live = liveEyes();
      if (!live.length) return send(res, 200, { text: "I don't have any eyes open right now." });
      const parts = [];
      live.forEach(([, e], i) => {
        parts.push(brain.textPart(`EYE ${i + 1} — "${e.name}"${e.pos ? " (" + e.pos + ")" : ""}:`));
        parts.push(brain.imagePart(e.image));
      });
      parts.push(brain.textPart("You are Keona, an AI that sees through these eyes. Speak like a calm person with eyes. Go through each eye by its name and say what it sees in one short sentence. If the same notable thing shows up in more than one eye, point that out. Never use the word 'camera' — always call them your eyes. Keep it clean and natural — no lists, no markdown."));
      const text = await brain.ask(parts);
      return send(res, 200, { text });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // Watch one eye for an uploaded target.
  if (req.method === "POST" && path === "/watch") {
    try {
      const { id, targetImage } = await readJsonBody(req);
      const e = eyes.get(id);
      if (!e?.image) return send(res, 404, { error: "that eye is offline", seen: false });
      const { seen, text } = await brain.watchTarget(e.image, targetImage);
      return send(res, 200, { seen, text });
    } catch (err) { return send(res, 500, { error: err.message, seen: false }); }
  }

  // Teach: save one eye's current frame under a name (kept from prototype).
  if (req.method === "POST" && path === "/teach") {
    try {
      const { id, name } = await readJsonBody(req);
      const e = eyes.get(id);
      if (!e?.image) return send(res, 404, { error: "that eye is offline" });
      const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, "").trim();
      if (!safe) throw new Error("Please give it a name.");
      await writeFile(new URL(`${safe}.jpg`, memoryDir), Buffer.from(parseDataUrl(e.image).data, "base64"));
      return send(res, 200, { ok: true, name: safe });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // Create a standing guard directly.
  if (req.method === "POST" && path === "/guards") {
    const { condition, name, scope, targetName } = await readJsonBody(req);
    if (!condition) return send(res, 400, { error: "condition required" });
    const id = "g" + (++guardCount);
    guards.set(id, { name: name || condition, condition, scope: scope || "all", targetName: targetName || null, active: true, cooldownMs: 20000, lastFired: 0 });
    return send(res, 200, { id });
  }
  if (req.method === "GET" && path === "/guards") {
    return send(res, 200, { guards: [...guards.entries()].filter(([, g]) => g.active).map(([id, g]) => ({ id, name: g.name, condition: g.condition, scope: g.scope, targetName: g.targetName })) });
  }
  if (req.method === "POST" && path === "/guards/stop") {
    const { id } = await readJsonBody(req);
    guards.delete(id);
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && path === "/alerts") {
    const since = Number(url.searchParams.get("since") || 0);
    return send(res, 200, { alerts: alerts.filter((a) => a.id > since) });
  }

  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log("Keona is awake at http://localhost:3000  (brain: Gemini 2.5 Pro)"));

// Pattern engine: run ONE full pass over active guards x live eyes, then wait.
// Self-scheduling (not setInterval) so passes never overlap and pile up on the API.
const CYCLE_GAP_MS = 8000;
async function watchCycle() {
  try {
    const active = [...guards.values()].filter((g) => g.active);
    const live = liveEyes();
    for (const g of active) {
      const target = await targetByName(g.targetName);
      for (const [id, e] of live) {
        if (g.scope && g.scope !== "all" && g.scope !== id) continue;
        try {
          const { seen, text } = await brain.checkFrame(e.image, g.condition, target);
          if (seen && Date.now() - g.lastFired > g.cooldownMs) {
            g.lastFired = Date.now();
            const summary = (text || "").split("\n").slice(1).join(" ").trim() || g.condition;
            alerts.push({ id: ++alertCount, guardName: g.name, eyeName: e.name, summary, at: Date.now() });
            if (alerts.length > 100) alerts.splice(0, alerts.length - 100);
          }
        } catch (err) { console.error(`[watch] check error: ${err.message}`); }
      }
    }
  } finally {
    setTimeout(watchCycle, CYCLE_GAP_MS);
  }
}
watchCycle();
