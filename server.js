import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const memoryDir = new URL("./memory/", import.meta.url);
await mkdir(memoryDir, { recursive: true });

// id -> { name, pos, image (data URL or null), at }
const eyes = new Map();
const ONLINE_MS = 15000;        // an eye is "live" if it sent a frame this recently
const chat = [];                // recent conversation with Keona: { role, text }
let eyeCount = 0;

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl);
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: "image/jpeg", data: dataUrl.split(",")[1] };
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
      const userContent = [];
      for (const [, e] of liveEyes()) {
        const img = parseDataUrl(e.image);
        userContent.push({ type: "text", text: `(Your eye "${e.name}"${e.pos ? " — " + e.pos : ""} currently sees:)` });
        userContent.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
      if (image) {
        const up = parseDataUrl(image);
        userContent.push({ type: "text", text: "(The owner uploaded this picture:)" });
        userContent.push({ type: "image", source: { type: "base64", media_type: up.mediaType, data: up.data } });
      }
      userContent.push({ type: "text", text: message || "(no message)" });

      const messages = [...chat.map((m) => ({ role: m.role, content: m.text })), { role: "user", content: userContent }];
      const msg = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 700,
        system: "You are Keona, a warm, friendly AI that sees through the eyes shown to you. You are chatting with your owner like a real person who has eyes. Use what your eyes currently see to answer naturally. If the owner uploads a picture and asks you to look out for it, clearly acknowledge what you'll watch for. Never use the word 'camera' — always say 'eye' or 'eyes'. Be warm, natural, and concise.",
        messages,
      });
      const text = msg.content.find((b) => b.type === "text")?.text ?? "...";
      chat.push({ role: "user", text: message || "(sent a picture)" });
      chat.push({ role: "assistant", text });
      if (chat.length > 16) chat.splice(0, chat.length - 16);
      return send(res, 200, { text });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // Describe one eye (kept for compatibility).
  if (req.method === "POST" && path === "/look") {
    try {
      const { id } = await readJsonBody(req);
      const e = eyes.get(id);
      if (!e?.image) return send(res, 404, { error: "that eye is offline" });
      const live = parseDataUrl(e.image);
      const msg = await client.messages.create({
        model: "claude-opus-4-8", max_tokens: 1024,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: live.mediaType, data: live.data } },
          { type: "text", text: "In one or two short sentences, plainly describe what you see." },
        ] }],
      });
      return send(res, 200, { text: msg.content.find((b) => b.type === "text")?.text ?? "I couldn't tell." });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // What do you see across ALL eyes right now? One natural, narrated report.
  if (req.method === "GET" && path === "/scene") {
    try {
      const live = liveEyes();
      if (!live.length) return send(res, 200, { text: "I don't have any eyes open right now." });
      const content = [];
      live.forEach(([, e], i) => {
        const img = parseDataUrl(e.image);
        content.push({ type: "text", text: `EYE ${i + 1} — "${e.name}"${e.pos ? " (" + e.pos + ")" : ""}:` });
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      });
      content.push({ type: "text", text: "You are Keona, an AI that sees through these eyes. Speak like a calm person with eyes. Go through each eye by its name and say what it sees in one short sentence. If the same notable thing shows up in more than one eye, point that out. Never use the word 'camera' — always call them your eyes. Keep it clean and natural — no lists, no markdown." });
      const msg = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 600, messages: [{ role: "user", content }] });
      return send(res, 200, { text: msg.content.find((b) => b.type === "text")?.text ?? "I couldn't tell." });
    } catch (err) { return send(res, 500, { error: err.message }); }
  }

  // Watch one eye for an uploaded target (kept for the continuous-alarm feature).
  if (req.method === "POST" && path === "/watch") {
    try {
      const { id, targetImage } = await readJsonBody(req);
      const e = eyes.get(id);
      if (!e?.image) return send(res, 404, { error: "that eye is offline", seen: false });
      const live = parseDataUrl(e.image), target = parseDataUrl(targetImage);
      const msg = await client.messages.create({
        model: "claude-opus-4-8", max_tokens: 200,
        messages: [{ role: "user", content: [
          { type: "text", text: "TARGET to watch for:" },
          { type: "image", source: { type: "base64", media_type: target.mediaType, data: target.data } },
          { type: "text", text: "LIVE VIEW:" },
          { type: "image", source: { type: "base64", media_type: live.mediaType, data: live.data } },
          { type: "text", text: "Decide whether the TARGET appears in the LIVE VIEW. First line exactly YES or NO. Second line a short reason." },
        ] }],
      });
      const text = msg.content.find((b) => b.type === "text")?.text ?? "NO";
      return send(res, 200, { seen: /^\s*yes\b/i.test(text), text });
    } catch (err) { return send(res, 500, { error: err.message, seen: false }); }
  }

  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log("Keona is awake at http://localhost:3000"));
