import { GoogleGenAI } from "@google/genai";

// Keona's single vision brain — strictly Gemini. Best model for video / temporal /
// multi-frame reasoning and target matching.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Two models, matched to the job:
const MODEL_SMART = "gemini-3.1-pro-preview"; // chat + deep scene analysis — best reasoning
const MODEL_FAST = "gemini-3.5-flash";        // the constant watch loop — fast AND top-tier at video

// One retry — smooths transient cold-start / network blips.
async function gen(params) {
  try { return await ai.models.generateContent(params); }
  catch { await new Promise((r) => setTimeout(r, 700)); return await ai.models.generateContent(params); }
}

function parse(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  return m ? { mimeType: m[1], data: m[2] } : { mimeType: "image/jpeg", data: dataUrl.split(",")[1] };
}
export const imagePart = (dataUrl) => ({ inlineData: parse(dataUrl) });
export const textPart = (t) => ({ text: t });

// Core single-turn call.
export async function ask(parts, system, model = MODEL_SMART) {
  const res = await gen({
    model,
    contents: [{ role: "user", parts }],
    ...(system ? { config: { systemInstruction: system } } : {}),
  });
  return res.text;
}

// Multi-turn chat. history = [{ role: 'user' | 'assistant', text }].
export async function converse(history, parts, system) {
  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    { role: "user", parts },
  ];
  const res = await gen({
    model: MODEL_SMART, contents,
    ...(system ? { config: { systemInstruction: system } } : {}),
  });
  return res.text;
}

// ---- named vision helpers (per the upgrade plan) ----

export const analyzeImage = (image, prompt) => ask([imagePart(image), textPart(prompt)]);

// Sequential frames from one eye (stand-in for a short clip until real video capture).
export const analyzeVideo = (frames, prompt) =>
  ask([textPart("These are sequential frames from one eye, in time order:"), ...frames.map(imagePart), textPart(prompt)]);

// Is a condition (default: the target appears) true in the live view right now?
export async function watchTarget(frame, target, condition = "the target shown appears") {
  const text = await ask([
    textPart("TARGET to watch for:"), imagePart(target),
    textPart("LIVE VIEW (now):"), imagePart(frame),
    textPart(`The first line of your reply must be exactly YES or NO — YES only if ${condition} in the live view right now. The second line is a short reason.`),
  ]);
  return { seen: /^\s*yes\b/i.test(text || ""), text };
}

// Check any condition on a frame (optionally against a known target reference).
export async function checkFrame(frame, condition, targetImage) {
  const parts = [];
  if (targetImage) { parts.push(textPart("KNOWN TARGET (the specific person/thing to look for):")); parts.push(imagePart(targetImage)); }
  parts.push(textPart("LIVE VIEW (now):"));
  parts.push(imagePart(frame));
  parts.push(textPart(`Condition to check: "${condition}". The first line of your reply must be exactly YES or NO — YES only if the condition is clearly true in the live view right now. The second line: a short reason.`));
  const text = await ask(parts, undefined, MODEL_FAST); // watch loop uses the fast model
  return { seen: /^\s*yes\b/i.test(text || ""), text };
}

export const compareFrames = (a, b, question) =>
  ask([textPart("EARLIER:"), imagePart(a), textPart("NOW:"), imagePart(b), textPart(question)]);
