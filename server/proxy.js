import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Load Environment (Robust)
const envPaths = [
  path.join(process.cwd(), "server", ".env"),
  path.join(process.cwd(), ".env")
];
envPaths.forEach(p => dotenv.config({ path: p }));

const app = express();

// Config
const PORT = Number(process.env.PORT || 5050);
const MODEL = process.env.MODEL || "claude-3-5-sonnet-20240620";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const DEBUG = process.env.DEBUG === "true";

// Logger
const log = (...a) => DEBUG && console.log("[proxy]", ...a);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" })); // Limit added for security

// Health Check
app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT, model: MODEL, ts: new Date().toISOString() });
});

// Main Handler
async function handleAsk(req, res) {
  const reqId = `req_${Date.now()}`;
  log(`Request ${reqId}:`, req.body?.question?.slice(0, 50));

  const question = req.body.question || req.body.text;
  
  // Validation
  if (!question) {
    return res.status(400).json({ ok: false, error: "Missing 'question'" });
  }

  // Auth Check
  if (!ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY");
    // Return 500 but detail explains it
    return res.status(500).json({ 
      ok: false, 
      error: "Server missing API Key. Check Render env vars." 
    });
  }

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    
    // Safety Timeout Race
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
    
    const text = msg.content[0]?.text || "No text content.";
    log(`Success ${reqId}`);

    return res.json({ ok: true, answer: text });

  } catch (e) {
    console.error(`Error ${reqId}:`, e.message);
    
    // Pass specific status codes to frontend so animation triggers
    const status = e.status || 500;
    
    // Explicitly pass Anthropic billing errors (400/402/403)
    // so the frontend "isNoCreditsError" check works
    return res.status(status).json({
      ok: false,
      error: e.message,
      body: e.error // Pass raw error body for inspection
    });
  }
}

// Routes
["/api/claude", "/api/query", "/ask"].forEach(r => app.post(r, handleAsk));

app.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
  console.log(`Model: ${MODEL}`);
});