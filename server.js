import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const memoryDir = new URL("./memory/", import.meta.url);
await mkdir(memoryDir, { recursive: true }); // where taught photos live

// Read every taught photo back as { name, base64 }.
async function loadKnown() {
  const files = (await readdir(memoryDir)).filter((f) => f.endsWith(".jpg"));
  return Promise.all(files.map(async (f) => ({
    name: f.replace(/\.jpg$/, ""),
    base64: (await readFile(new URL(f, memoryDir))).toString("base64"),
  })));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const server = createServer(async (req, res) => {
  // Serve the camera page.
  if (req.method === "GET" && req.url === "/") {
    const html = await readFile(new URL("./index.html", import.meta.url));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // List the names Katy has been taught.
  if (req.method === "GET" && req.url === "/known") {
    const known = await loadKnown();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ names: known.map((k) => k.name) }));
    return;
  }

  // Teach Katy: save the current picture under a name.
  if (req.method === "POST" && req.url === "/teach") {
    try {
      const { image, name } = await readJsonBody(req);
      const safe = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim();
      if (!safe) throw new Error("Please give it a name.");
      const base64 = image.split(",")[1];
      await writeFile(new URL(`${safe}.jpg`, memoryDir), Buffer.from(base64, "base64"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: safe }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // The eye sends a picture here; Katy describes it and names anything she knows.
  if (req.method === "POST" && req.url === "/look") {
    try {
      const { image } = await readJsonBody(req);
      const liveBase64 = image.split(",")[1];
      const known = await loadKnown();

      // Show Katy each taught photo with its name, then the live view.
      const content = [];
      for (const k of known) {
        content.push({ type: "text", text: `Known, named "${k.name}":` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: k.base64 } });
      }
      content.push({ type: "text", text: "LIVE VIEW:" });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: liveBase64 } });
      content.push({
        type: "text",
        text: known.length
          ? "In one or two short sentences, plainly describe the LIVE VIEW. If any of the people or things named above appear in the LIVE VIEW, say their name clearly (for example: \"I can see Pepper\")."
          : "In one or two short sentences, plainly describe what you see in this picture.",
      });

      const message = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      });

      const text = message.content.find((b) => b.type === "text")?.text ?? "I couldn't tell.";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(3000, () => console.log("Katy is awake at http://localhost:3000"));
