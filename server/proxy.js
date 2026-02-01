import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from server/.env first, then root .env
const envPaths = [
  path.join(process.cwd(), "server", ".env"),
  path.join(process.cwd(), ".env"),
];
for (const p of envPaths) dotenv.config({ path: p });

const app = express();

// Render sets PORT automatically
const PORT = Number(process.env.PORT || 5050);

// ✅ IMPORTANT: your current default model is outdated and returns 404 "model not found".
// Set MODEL in Render to a valid Claude API model (see .env below).
const MODEL = process.env.MODEL || "claude-opus-4-5";
// good default
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const DEBUG = process.env.DEBUG === "true";

const log = (...a) => DEBUG && console.log("[proxy]", ...a);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT, model: MODEL, ts: new Date().toISOString() });
});

// shared handler for all chat endpoints
async function handleAsk(req, res) {
  const reqId = `req_${Date.now()}`;
  const question = req.body?.question ?? req.body?.text ?? "";

  if (!question) return res.status(400).json({ ok: false, error: "Missing 'question'" });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Server missing ANTHROPIC_API_KEY. Add it in Render env vars.",
    });
  }

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Upstream timeout")), 55000)
    );

    const apiPromise = anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      temperature: 0.2,
      system: "You are a helpful call-center compliance assistant. Answer practically.",
      messages: [{ role: "user", content: question }],
    });

    const msg = await Promise.race([apiPromise, timeoutPromise]);
    const text = msg?.content?.[0]?.text || "No text content.";
    log(`Success ${reqId}`);

    return res.json({ ok: true, answer: text });
  } catch (e) {
    // Anthropic errors may include: e.status and e.error (raw body)
    const status = Number(e?.status || 500);

    console.error(`Error ${reqId}:`, e?.message || e);

    return res.status(status).json({
      ok: false,
      error: e?.message || "Unknown server error",
      body: e?.error,
      model: MODEL,
    });
  }
}

// Routes your frontend tries (keep all to be safe)
["/api/claude", "/api/query", "/api/ask", "/api/chat", "/ask", "/chat", "/query"].forEach((r) =>
  app.post(r, handleAsk)
);

app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
  console.log(`Model: ${MODEL}`);
});
