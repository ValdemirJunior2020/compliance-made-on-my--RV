import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();

const PORT = Number(process.env.PORT || 5050);
const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || "").trim();
const MODEL = String(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5").trim();

// Render/prod CORS (comma-separated). If empty -> allow all (temporary)
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "").trim();
const allowed = CORS_ORIGINS
  ? CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.length === 0) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    optionsSuccessStatus: 204
  })
);

app.options("*", cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, port: PORT, model: MODEL });
});

app.post("/api/claude", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY in env" });
    }

    const { system, question } = req.body || {};
    const q = String(question || "").trim();
    const s = String(system || "").trim();
    if (!q || !s) return res.status(400).json({ error: "Missing system or question" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2800,
        temperature: 0.2,
        system: s,
        messages: [{ role: "user", content: q }]
      })
    });

    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({
        error: `Anthropic API error ${r.status}`,
        details: text
      });
    }

    res.setHeader("content-type", "application/json");
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).json({ error: "Server exception", details: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
