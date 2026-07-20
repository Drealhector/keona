// Keona's vision brain — strictly Gemini, called over plain HTTPS (no SDK) so it
// runs in the default Convex runtime. Plain helper functions (not registered
// Convex functions): http.ts and watch.ts call these directly with their ctx.
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { b64encode, parseDataUrl } from "./b64";

// Two models, matched to the job:
const MODEL_SMART = "gemini-3.1-pro-preview"; // chat + deep scene analysis — best reasoning
const MODEL_FAST = "gemini-3.5-flash";        // the watch loop — fast AND top-tier at video

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
type Turn = { role: "user" | "model"; parts: Part[] };

export const textPart = (t: string): Part => ({ text: t });
export function imagePart(dataUrl: string): Part {
  const { mimeType, data } = parseDataUrl(dataUrl);
  return { inlineData: { mimeType, data } };
}
export async function blobPart(blob: Blob, fallbackMime: string): Promise<Part> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { inlineData: { mimeType: blob.type || fallbackMime, data: b64encode(bytes) } };
}

// Core Gemini call. One immediate retry smooths transient blips (the Convex
// runtime has no setTimeout, so the retry is immediate rather than delayed).
async function gen(model: string, contents: Turn[], system?: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set on this Convex deployment");
  const body = JSON.stringify({
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  });
  const call = async (): Promise<string> => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  };
  try {
    return await call();
  } catch {
    return await call();
  }
}

export const ask = (parts: Part[], system?: string, model = MODEL_SMART) =>
  gen(model, [{ role: "user", parts }], system);

type ChatIntent = {
  create?: { condition?: string | null; target?: string | null } | null;
  stop?: "all" | string[] | null;
};

function safeJson(raw: string): ChatIntent | null {
  try {
    const m = /\{[\s\S]*\}/.exec(raw); // tolerate ```json fences or prose around it
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

// Chat with Keona — she answers using what her eyes see right now (+ any
// uploaded picture). Watch requests are detected by the AI reading the
// owner's meaning (any language or phrasing), NOT by phrase matching.
export async function chatLogic(
  ctx: ActionCtx,
  args: { message?: string; image?: string },
): Promise<{ text: string; guardCreated?: boolean }> {
  const message = args.message ?? "";
  const known: string[] = await ctx.runQuery(api.targets.known, {});

  if (message) {
    const actives: Array<{ id: Id<"patterns">; name: string }> = await ctx.runQuery(api.guards.listActive, {});
    const intentRaw = await gen(MODEL_FAST, [
      {
        role: "user",
        parts: [
          textPart(
            `The owner of a watching-eyes assistant said: "${message}"\n` +
              `Known taught target names: ${JSON.stringify(known)}\n` +
              `Currently active watches (exact names): ${JSON.stringify(actives.map((a) => a.name))}\n` +
              `Decide the owner's intent. They may phrase it any way, in any language:\n` +
              `- CREATE: they want to START a standing watch that should alert them LATER when something happens.\n` +
              `- STOP: they want to CANCEL/STOP one or more of the active watches, or stop all watching.\n` +
              `- NEITHER: greetings, questions about right now, and normal chat.\n` +
              `Reply with STRICT JSON only: {"create": {"condition": string, "target": string or null} or null, "stop": "all" or [exact names from the active list] or null}\n` +
              `condition = what to watch for, stated plainly in English. target = one of the known names if the owner meant it, else null.`,
          ),
        ],
      },
    ]);
    const intent = safeJson(intentRaw);

    if (intent?.stop) {
      let reply: string;
      if (!actives.length) {
        reply = "I wasn't watching for anything, so we're already clear — nothing is burning.";
      } else {
        const wanted =
          intent.stop === "all"
            ? actives
            : actives.filter((a) =>
                (intent.stop as string[]).some((n) => n.toLowerCase() === a.name.toLowerCase()),
              );
        for (const g of wanted) {
          await ctx.runMutation(api.guards.stop, { id: g.id });
        }
        reply = wanted.length
          ? `Done — I've stopped watching: ${wanted.map((g) => `"${g.name}"`).join(", ")}. My eyes stay open, but I'm off guard duty${wanted.length === actives.length ? " completely, so nothing is burning" : " for those"}.`
          : "I couldn't match that to any of my active watches — check the Watching for list and try the name shown there.";
      }
      await ctx.runMutation(internal.chat.append, { role: "user", text: message });
      await ctx.runMutation(internal.chat.append, { role: "assistant", text: reply });
      return { text: reply };
    }

    if (intent?.create?.condition) {
      const condition = intent.create.condition;
      const targetName =
        intent.create.target && known.includes(intent.create.target) ? intent.create.target : null;
      await ctx.runMutation(api.guards.create, {
        name: condition.slice(0, 70),
        condition,
        scope: "all",
        targetName,
      });
      const reply =
        `On it — I'm now watching all my eyes and I'll alert you: "${condition}"` +
        `${targetName ? ` (looking specifically for ${targetName})` : ""}. I'll ping you the moment it happens.`;
      await ctx.runMutation(internal.chat.append, { role: "user", text: message });
      await ctx.runMutation(internal.chat.append, { role: "assistant", text: reply });
      return { text: reply, guardCreated: true };
    }
  }

  const eyes = await ctx.runQuery(internal.eyes.live, {});
  const history: Array<{ role: string; text: string }> = await ctx.runQuery(internal.chat.recent, {});
  const parts: Part[] = [];
  for (const e of eyes) {
    parts.push(textPart(`(Your eye "${e.name}"${e.pos ? " — " + e.pos : ""} currently sees:)`));
    parts.push(imagePart(e.frame));
  }
  if (args.image) {
    parts.push(textPart("(The owner uploaded this picture:)"));
    parts.push(imagePart(args.image));
  }
  if (!eyes.length && !args.image) {
    parts.push(
      textPart(
        "(You have no eyes open right now, so you genuinely cannot see anything at the moment. Do not invent or guess a scene — say plainly that no eyes are open.)",
      ),
    );
  }
  parts.push(textPart(message || "(no message)"));

  const system =
    "You are Keona, a warm, friendly AI that sees through the eyes shown to you. You are chatting with your owner like a real person who has eyes. Use what your eyes currently see to answer naturally. If the owner uploads a picture and asks you to look out for it, clearly acknowledge what you'll watch for. Never use the word 'camera' — always say 'eye' or 'eyes'. Be warm, natural, and concise.";
  const contents: Turn[] = [
    ...history.map((m): Turn => ({ role: m.role === "assistant" ? "model" : "user", parts: [textPart(m.text)] })),
    { role: "user", parts },
  ];
  const text = await gen(MODEL_SMART, contents, system);
  await ctx.runMutation(internal.chat.append, { role: "user", text: message || "(sent a picture)" });
  await ctx.runMutation(internal.chat.append, { role: "assistant", text });
  return { text };
}

// What do you see across ALL eyes right now? One natural, narrated report.
export async function sceneLogic(ctx: ActionCtx): Promise<string> {
  const eyes = await ctx.runQuery(internal.eyes.live, {});
  if (!eyes.length) return "I don't have any eyes open right now.";
  const parts: Part[] = [];
  eyes.forEach((e, i) => {
    parts.push(textPart(`EYE ${i + 1} — "${e.name}"${e.pos ? " (" + e.pos + ")" : ""}:`));
    parts.push(imagePart(e.frame));
  });
  parts.push(
    textPart(
      "You are Keona, an AI that sees through these eyes. Speak like a calm person with eyes. Go through each eye by its name and say what it sees in one short sentence. If the same notable thing shows up in more than one eye, point that out. Never use the word 'camera' — always call them your eyes. Keep it clean and natural — no lists, no markdown.",
    ),
  );
  return await ask(parts);
}

// Describe one eye.
export async function lookLogic(ctx: ActionCtx, eyeId: string): Promise<string | null> {
  const { image } = await ctx.runQuery(api.eyes.getFrame, { eyeId });
  if (!image) return null;
  return await ask([imagePart(image), textPart("In one or two short sentences, plainly describe what you see.")]);
}

// One-off: is an uploaded target visible in one eye right now?
export async function watchOnceLogic(
  ctx: ActionCtx,
  eyeId: string,
  targetImage: string,
): Promise<{ seen: boolean; text: string } | null> {
  const { image } = await ctx.runQuery(api.eyes.getFrame, { eyeId });
  if (!image) return null;
  const text = await ask([
    textPart("TARGET to watch for:"),
    imagePart(targetImage),
    textPart("LIVE VIEW (now):"),
    imagePart(image),
    textPart(
      "The first line of your reply must be exactly YES or NO — YES only if the target shown appears in the live view right now. The second line is a short reason.",
    ),
  ]);
  return { seen: /^\s*yes\b/i.test(text || ""), text };
}

// Check a guard's condition against an eye's latest media (clip when fresh —
// real motion over time — else the latest frame).
export async function checkMedia(
  media: Part,
  condition: string,
  target: Part | null,
): Promise<{ seen: boolean; text: string }> {
  const parts: Part[] = [];
  if (target) {
    parts.push(textPart("KNOWN TARGET (the specific person/thing to look for):"));
    parts.push(target);
  }
  parts.push(textPart("LIVE VIEW (what the eye just saw — a short clip or a frame):"));
  parts.push(media);
  parts.push(
    textPart(
      `Condition to check: "${condition}". The first line of your reply must be exactly YES or NO — YES only if the condition is clearly true in the live view right now. The second line: a short reason.`,
    ),
  );
  const text = await ask(parts, undefined, MODEL_FAST);
  return { seen: /^\s*yes\b/i.test(text || ""), text };
}
