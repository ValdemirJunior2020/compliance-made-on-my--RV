import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import "./App.css";

const API_BASE = "https://compliance-made-on-my-rv.onrender.com";

// public assets
const LOADING_GIF_SRC = "/loading.gif";
const NAV_LOGO_VIDEO_SRC = "/Video_Generation_Confirmation.mp4";
// CORRECT WAY (No /public, and new short name)
const ERROR_VIDEO_SRC = "/error.mp4";

// downloads (public)
const QA_GROUP_XLSX_PATH = "/qa-group.xlsx";
const QA_VOICE_XLSX_PATH = "/qa-voice.xlsx";
const MATRIX_PUBLIC_PATH = "/Service Matrix's 2026.xlsx";

// docs used by app (public)
const TRAINING_GUIDE_TXT_PATH = "/training_guide.txt";
const TRAINING_GUIDE_CHUNKS_PATH = "/training_guide.chunks.jsonl";

// --- logging ----------------------------------------------------------------

const DEBUG = true;

function log(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log("[CC]", ...args);
}
function warn(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.warn("[CC]", ...args);
}
function errlog(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.error("[CC]", ...args);
}
function group(title, fn) {
  if (!DEBUG) return fn?.();
  // eslint-disable-next-line no-console
  console.groupCollapsed(`[CC] ${title}`);
  try {
    return fn?.();
  } finally {
    // eslint-disable-next-line no-console
    console.groupEnd();
  }
}

// --- utils -------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function genId() {
  try {
    return crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function safeString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function normalizeWs(s) {
  return safeString(s).replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function isAbort(error) {
  return error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""));
}

function asHumanError(error) {
  const msg = String(error?.message || error || "");
  if (!msg) return "Something went wrong.";
  return msg.length > 900 ? msg.slice(0, 900) + "…" : msg;
}

// Minimal HTML hardening for model output (not a full sanitizer).
function stripDangerousHtml(html) {
  let out = String(html || "");
  out = out.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "");
  out = out.replace(/(href|src)\s*=\s*("|\')\s*javascript:[\s\S]*?\2/gi, "$1=$2#$2");
  return out;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    log("fetchWithTimeout ->", { url, options, timeoutMs });
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    log("fetchWithTimeout <-", { url, status: res.status, ok: res.ok });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function postToAnyEndpoint({ base, paths, payload, timeoutMs }) {
  let lastErr = null;

  for (const p of paths) {
    const url = base.replace(/\/+$/, "") + p;

    group(`POST attempt ${p}`, () => {
      log("POST url:", url);
      log("Payload keys:", Object.keys(payload || {}));
      log("Payload preview:", {
        question: payload?.question,
        mode: payload?.mode,
        docs: payload?.docs ? Object.keys(payload.docs) : null,
      });
    });

    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );

      const contentType = res.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

      log("POST response:", { path: p, status: res.status, isJson, contentType });

      if (!res.ok) {
        const detailText = normalizeWs(isJson ? safeString(body) : body) || res.statusText;
        const error = new Error(`HTTP ${res.status} on ${p}: ${detailText}`);
        error.status = res.status;
        error.body = body;
        error.path = p;
        throw error;
      }

      return { ok: true, status: res.status, path: p, body };
    } catch (e) {
      lastErr = e;
      warn("POST failed:", {
        path: p,
        status: e?.status,
        message: String(e?.message || e),
        isAbort: isAbort(e),
      });

      // stop immediately on auth issues
      if (e?.status === 401 || e?.status === 403) throw e;
      // stop immediately on aborts/timeouts
      if (isAbort(e)) throw e;
      // otherwise try next endpoint
    }
  }

  throw lastErr || new Error("No endpoint responded.");
}

function pickAnswerFromBody(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;

  const candidates = [
    body.answer,
    body.text,
    body.message,
    body.result,
    body.output,
    body.content,
    body?.data?.answer,
    body?.data?.text,
    body?.data?.message,
  ];

  for (const c of candidates) {
    const s = normalizeWs(c);
    if (s) return s;
  }
  return normalizeWs(body);
}

function tryLoadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const v = raw == null ? fallback : JSON.parse(raw);
    log("tryLoadLocal:", key, v);
    return v;
  } catch (e) {
    warn("tryLoadLocal failed:", key, e);
    return fallback;
  }
}

function trySaveLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    log("trySaveLocal:", key, value);
  } catch (e) {
    warn("trySaveLocal failed:", key, e);
  }
}

function useAutoResizeTextarea(ref, value) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const next = clamp(el.scrollHeight, 28, 200);
    el.style.height = next + "px";
  }, [ref, value]);
}

// --- Error Boundary -----------------------------------------------------------

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    errlog("ErrorBoundary caught:", error);
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    errlog("ErrorBoundary componentDidCatch:", error, info);
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="cc-root">
        <div className="cc-thread">
          <div className="cc-threadInner">
            <div className="cc-bannerError">
              <div style={{ fontWeight: 700 }}>🚨 UI turbulence detected</div>
              <div className="cc-bannerSub">Refresh usually fixes it.</div>
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="cc-sendBtn"
                  onClick={() => window.location.reload()}
                  style={{ width: "auto", padding: "0 14px" }}
                  type="button"
                >
                  Reload
                </button>
                <button
                  className="cc-sendBtn"
                  onClick={() => this.setState({ hasError: false, error: null })}
                  style={{ width: "auto", padding: "0 14px" }}
                  type="button"
                >
                  Try again
                </button>
              </div>
              <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, color: "rgba(17,24,39,0.75)" }}>
                {normalizeWs(this.state?.error?.stack || this.state?.error?.message || "Unknown error")}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

// --- UI bits -----------------------------------------------------------------

const DEFAULT_DOCS = {
  matrix: true,
  trainingTxt: true,
  trainingChunks: true,
  qaVoice: false,
  qaGroup: false,
};

const DOC_META = [
  { key: "matrix", label: "Matrix 2026", path: MATRIX_PUBLIC_PATH },
  { key: "trainingTxt", label: "Training Guide", path: TRAINING_GUIDE_TXT_PATH },
  { key: "trainingChunks", label: "Guide Chunks", path: TRAINING_GUIDE_CHUNKS_PATH },
  { key: "qaVoice", label: "QA Voice", path: QA_VOICE_XLSX_PATH },
  { key: "qaGroup", label: "QA Groups", path: QA_GROUP_XLSX_PATH },
];

const MODE_META = [
  { key: "cloud", label: "Cloud Mode" },
  { key: "local", label: "Local Mode" },
];

const RESOURCES = [
  { label: "QA Groups (.xlsx)", href: QA_GROUP_XLSX_PATH, fileName: "qa-group.xlsx" },
  { label: "Service Matrix 2026 (.xlsx)", href: MATRIX_PUBLIC_PATH, fileName: "Service Matrix's 2026.xlsx" },
  { label: "QA Voice (.xlsx)", href: QA_VOICE_XLSX_PATH, fileName: "qa-voice.xlsx" },
];

function buildPayload({ question, mode, docs }) {
  return {
    question,
    mode,
    docs,
    client: { app: "Call Center Compliance App", ts: nowIso(), ui: "react" },
  };
}

function build404Message({ apiBase, attemptedPath }) {
  const base = (apiBase || "").replace(/\/+$/, "");
  const fullUrl = attemptedPath ? `${base}${attemptedPath}` : base;

  return normalizeWs(`
🔎 Server cannot find the requested webpage or resource (HTTP 404).

What this usually means:
- The frontend is POSTing to an endpoint that does not exist on your server.
- Example: your UI tried: ${attemptedPath || "(unknown path)"} but your backend route name is different.

How to fix (pick 1):
1) ✅ Update the frontend to call the correct endpoint that exists on the server.
   - Open your server code and confirm the route, e.g. app.post("/api/claude", ...)
   - Then set the endpoints list to include that exact route FIRST.
2) ✅ Add the missing route on the backend to match what the frontend is calling.
3) ✅ If you changed API_BASE, confirm it's pointing to the correct deployed service.

Helpful checks:
- Try opening (in browser): ${base}/health
- Your app attempted: ${fullUrl}
`);
}

function isNoCreditsError(e) {
  const status = Number(e?.status || 0);
  const rawBody = safeString(e?.body);
  const msg = String(e?.message || "");
  const hay = (msg + "\n" + rawBody).toLowerCase();

  // Anthropic "no credits" / billing signals
  const hit =
    hay.includes("credit balance is too low") ||
    hay.includes("plans & billing") ||
    hay.includes("insufficient") && hay.includes("credit") ||
    hay.includes("billing") && hay.includes("upgrade") ||
    hay.includes("purchase credits");

  // most common is HTTP 400 from Anthropic
  return hit && (status === 400 || status === 402 || status === 403);
}

function buildNoCreditsMessage() {
  return normalizeWs(`
💳 No credits available for Claude (Anthropic).

What happened:
- Your ANTHROPIC_API_KEY is valid, but the account has $0 credits.

Fix:
1) Go to Anthropic Console → Plans & Billing
2) Add payment method / purchase credits
3) Restart the server (and redeploy on Render if needed)

After you add credits, Cloud Mode will work normally.
`);
}

function MessageBubble({ m, isIntro }) {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";

  const html = useMemo(() => {
    if (!isAssistant) return "";
    const raw = normalizeWs(m.text);
    if (!raw) return "";
    marked.setOptions({ gfm: true, breaks: true, mangle: false, headerIds: false });
    return stripDangerousHtml(marked.parse(raw));
  }, [m.text, isAssistant]);

  return (
    <div className={`cc-msg ${isUser ? "cc-user" : "cc-assistant"} ${isIntro ? "cc-intro" : ""}`}>
      <div className={`cc-bubble ${isAssistant ? "cc-bubbleAssistant" : ""}`}>
        {m.kind === "loading" ? (
          <div className="cc-loadingWrap">
            <img
              className="cc-loadingGif"
              src={LOADING_GIF_SRC}
              alt="loading"
              onError={(e) => {
                warn("Loading GIF missing, fallback to tenor gif");
                e.currentTarget.src = "https://media.tenor.com/e_E1hMZnbdAAAAAi/meme-coffee.gif";
              }}
            />
            <div className="cc-thinking">{m.thinkingText || "Thinking…"}</div>
          </div>
        ) : m.kind === "error401" ? (
          <div className="cc-loadingWrap">
            <video className="cc-errorVideo" autoPlay loop muted playsInline src={ERROR_VIDEO_SRC} />
            <div className="cc-errorHint">
              <div className="cc-error" style={{ textAlign: "center" }}>
                🔒 Unauthorized (401). Your server rejected the request.
              </div>
              <div className="cc-bannerSub" style={{ textAlign: "center" }}>
                Check API keys / env vars on the server and confirm the provider is configured.
              </div>
              {m.text ? (
                <pre className="cc-error" style={{ marginTop: 10 }}>
                  {normalizeWs(m.text)}
                </pre>
              ) : null}
            </div>
          </div>
        ) : m.kind === "error404" ? (
          <div className="cc-error">{normalizeWs(m.text)}</div>
        ) : m.kind === "errorNoCredits" ? (
          <div className="cc-loadingWrap">
            <video className="cc-errorVideo" autoPlay loop muted playsInline src={ERROR_VIDEO_SRC} />
            <div className="cc-errorHint">
              <div className="cc-error" style={{ textAlign: "center" }}>
                💳 Claude credits are empty.
              </div>
              <div className="cc-bannerSub" style={{ textAlign: "center" }}>
                Add credits in Anthropic Plans & Billing, then restart the server.
              </div>
              {m.text ? (
                <pre className="cc-error" style={{ marginTop: 10 }}>
                  {normalizeWs(m.text)}
                </pre>
              ) : null}
            </div>
          </div>
        ) : m.kind === "error" ? (
          <div className="cc-error">{normalizeWs(m.text)}</div>
        ) : isAssistant ? (
          <div className="cc-answer" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="cc-bubbleText">{normalizeWs(m.text)}</div>
        )}
      </div>
    </div>
  );
}

function ResourcePopover({ open, onClose }) {
  if (!open) return null;

  return (
    <>
      <div className="cc-popoverScrim" onClick={onClose} />
      <div className="cc-popover" role="dialog" aria-modal="true">
        <div className="cc-popoverHeader">
          <div className="cc-popoverTitle">Resources</div>
          <button className="cc-pillBtn cc-pillBtnGhost" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cc-popoverBody">
          <div className="cc-popoverHint">Download the files below:</div>
          <div className="cc-resourceList">
            {RESOURCES.map((r) => (
              <a
                key={r.href}
                className="cc-resourceItem"
                href={r.href}
                download={r.fileName}
                target="_blank"
                rel="noreferrer"
                onClick={() => log("Resource download clicked:", r)}
              >
                <div className="cc-resourceName">{r.label}</div>
                <div className="cc-resourceSub">{r.fileName}</div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const textareaRef = useRef(null);
  const threadEndRef = useRef(null);

  const [mode, setMode] = useState(() => tryLoadLocal("cc_mode", "cloud"));
  const [docs, setDocs] = useState(() => tryLoadLocal("cc_docs", DEFAULT_DOCS));
  const [docAvail, setDocAvail] = useState(() =>
    DOC_META.reduce((acc, d) => {
      acc[d.key] = true;
      return acc;
    }, {})
  );

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [banner, setBanner] = useState(null);
  const [health, setHealth] = useState({ ok: null, last: null });

  const [resourcesOpen, setResourcesOpen] = useState(false);

  const [messages, setMessages] = useState(() => [
    {
      id: genId(),
      role: "assistant",
      text:
        "Hi! Ask me what to do in a guest situation and I’ll respond using the selected procedures/policies.\n\nTip: select the docs in the footer first.",
      ts: Date.now(),
    },
  ]);

  useAutoResizeTextarea(textareaRef, input);

  const firstAssistantId = useMemo(() => messages.find((x) => x.role === "assistant")?.id ?? null, [messages]);

  const activeDocsLabel = useMemo(() => {
    const enabled = DOC_META.filter((d) => docs[d.key]).map((d) => d.label);
    return enabled.length ? enabled.join(", ") : "No docs selected";
  }, [docs]);

  const scrollToBottom = useCallback(() => {
    const el = threadEndRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    log("Mounted App");
    log("API_BASE:", API_BASE);
    log("Public docs paths:", DOC_META.map((d) => ({ label: d.label, path: d.path })));
    log("ERROR_VIDEO_SRC:", ERROR_VIDEO_SRC);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => trySaveLocal("cc_mode", mode), [mode]);
  useEffect(() => trySaveLocal("cc_docs", docs), [docs]);

  // Validate that public docs exist (HEAD)
  useEffect(() => {
    let cancelled = false;

    async function checkOne(path) {
      try {
        const res = await fetchWithTimeout(path, { method: "HEAD" }, 12000);
        return res.ok;
      } catch (e) {
        warn("HEAD check failed:", path, e);
        return false;
      }
    }

    (async () => {
      group("Checking public docs availability (HEAD)", async () => {
        const next = {};
        for (const d of DOC_META) {
          next[d.key] = await checkOne(d.path);
          log("Doc availability:", d.label, d.path, "=>", next[d.key]);
        }
        if (cancelled) return;

        setDocAvail((prev) => ({ ...prev, ...next }));

        const missing = DOC_META.filter((d) => !next[d.key]).map((d) => d.label);
        if (missing.length) {
          warn("Missing public docs:", missing);
          setBanner({
            type: "error",
            title: "📁 Some public docs were not found",
            sub: `Missing: ${missing.join(", ")}. Put them inside /public with the exact filenames.`,
          });
        } else {
          log("All public docs found ✅");
        }
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const runHealthCheck = useCallback(async () => {
    group("Health check", async () => {
      try {
        const url = `${API_BASE.replace(/\/+$/, "")}/health`;
        log("Health URL:", url);

        const res = await fetchWithTimeout(url, {}, 12000);
        const ok = res.ok;

        log("Health response:", { status: res.status, ok });
        setHealth({ ok, last: Date.now() });

        if (!ok) {
          setBanner({
            type: "error",
            title: "🛰️ Server health check failed",
            sub: `Health endpoint returned HTTP ${res.status}.`,
          });
        }
      } catch (e) {
        warn("Health check error:", e);
        setHealth({ ok: false, last: Date.now() });
        setBanner({
          type: "error",
          title: "🛰️ Server not reachable",
          sub: isAbort(e) ? "Health check timed out." : asHumanError(e),
        });
      }
    });
  }, []);

  useEffect(() => {
    runHealthCheck();
    const t = setInterval(() => runHealthCheck(), 120000);
    return () => clearInterval(t);
  }, [runHealthCheck]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        log("ESC pressed -> closing resources popover");
        setResourcesOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const addMessage = useCallback((m) => {
    log("addMessage:", { role: m?.role, kind: m?.kind, len: (m?.text || "").length });
    setMessages((prev) => [...prev, m]);
  }, []);

  const replaceLastAssistant = useCallback((replacement) => {
    log("replaceLastAssistant:", {
      kind: replacement?.kind,
      len: (replacement?.text || "").length,
      meta: replacement?.meta,
    });
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = { ...copy[i], ...replacement };
          break;
        }
      }
      return copy;
    });
  }, []);

  const toggleDoc = useCallback((key) => {
    log("toggleDoc:", key);
    setDocs((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const clearInput = useCallback(() => {
    log("clearInput");
    setInput("");
    textareaRef.current?.focus?.();
  }, []);

  const send = useCallback(async () => {
    const question = normalizeWs(input);

    group("send() invoked", () => {
      log("hasQuestion:", !!question);
      log("isSending:", isSending);
      log("mode:", mode);
      log("docs:", docs);
      log("docAvail:", docAvail);
      log("activeDocsLabel:", activeDocsLabel);
    });

    if (!question || isSending) return;

    const enabledCount = DOC_META.reduce((n, d) => n + (docs[d.key] ? 1 : 0), 0);
    if (enabledCount === 0) {
      warn("No docs selected -> blocking send");
      setBanner({
        type: "error",
        title: "📌 No docs selected",
        sub: "Select at least one doc chip in the footer so answers follow policy correctly.",
      });
      return;
    }

    setBanner(null);
    setIsSending(true);

    addMessage({ id: genId(), role: "user", text: question, ts: Date.now() });
    addMessage({
      id: genId(),
      role: "assistant",
      kind: "loading",
      text: "",
      thinkingText: mode === "cloud" ? "Thinking in cloud mode…" : "Thinking locally…",
      ts: Date.now(),
    });

    setInput("");

    const payload = buildPayload({
      question,
      mode,
      docs: { ...docs, _availability: docAvail, _activeDocsLabel: activeDocsLabel },
    });

    // Multi-endpoint probing (keep) — put most likely endpoint FIRST
    const endpoints = ["/api/claude", "/api/ask", "/ask", "/api/chat", "/chat", "/query", "/api/query"];
    const maxAttempts = 2;

    try {
      let last = null;

      group("Send flow", () => {
        log("API_BASE:", API_BASE);
        log("Endpoints list:", endpoints);
        log("Question:", question);
        log("Docs label:", activeDocsLabel);
      });

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`Attempt ${attempt}/${maxAttempts}`);
        try {
          last = await postToAnyEndpoint({ base: API_BASE, paths: endpoints, payload, timeoutMs: 65000 });
          log("Endpoint success:", last);
          break;
        } catch (e) {
          warn("Attempt failed:", {
            attempt,
            status: e?.status,
            path: e?.path,
            message: String(e?.message || e),
          });

          if (e?.status === 401) throw e;
          if (e?.status === 404) throw e;

          if (e?.status === 429 && attempt < maxAttempts) {
            await sleep(900 + Math.floor(Math.random() * 500));
            continue;
          }
          if (Number(e?.status) >= 500 && attempt < maxAttempts) {
            await sleep(650 + Math.floor(Math.random() * 450));
            continue;
          }
          if (isAbort(e)) throw e;

          throw e;
        }
      }

      const answerText = pickAnswerFromBody(last?.body);
      const finalText = normalizeWs(answerText) || "No answer returned from server.";

      replaceLastAssistant({
        kind: undefined,
        text: finalText,
        ts: Date.now(),
        meta: { endpoint: last?.path, status: last?.status, mode },
      });
      setHealth((h) => ({ ...h, ok: true, last: Date.now() }));
    } catch (e) {
      const status = e?.status;

      errlog("send() error:", e);

      if (status === 401) {
        replaceLastAssistant({
          kind: "error401",
          text: normalizeWs(e?.message || "Unauthorized (401)."),
          ts: Date.now(),
        });
      } else if (status === 404) {
        const attemptedPath = e?.path || "";
        const friendly404 = build404Message({ apiBase: API_BASE, attemptedPath });

        replaceLastAssistant({
          kind: "error404",
          text: friendly404,
          ts: Date.now(),
          meta: { endpoint: attemptedPath, status },
        });

        setBanner({
          type: "error",
          title: "🧯 We handled an error safely",
          sub: `HTTP 404 — Server cannot find the requested resource (${attemptedPath || "unknown endpoint"}).`,
        });
      } else if (isNoCreditsError(e)) {
        // ✅ SHOW THE ERROR ANIMATION FOR "NO CREDITS"
        const noCreditsText = buildNoCreditsMessage();
        replaceLastAssistant({
          kind: "errorNoCredits",
          text: noCreditsText,
          ts: Date.now(),
          meta: { status, endpoint: e?.path, noCredits: true },
        });

        setBanner({
          type: "error",
          title: "💳 Claude credits empty",
          sub: "Add credits in Anthropic Plans & Billing, then restart the server.",
        });
      } else {
        const friendly =
          status === 429
            ? "⏳ Rate limit hit (429). Please try again in a moment."
            : status === 413
            ? "📦 Request too large (413). Shorten the question or reduce selected docs."
            : isAbort(e)
            ? "⏱️ Timed out. Server took too long. Try again."
            : status
            ? `⚠️ Server error (HTTP ${status}).`
            : "⚠️ Network error. Check server / internet.";

        replaceLastAssistant({
          kind: "error",
          text: `${friendly}\n\nDetails:\n${normalizeWs(e?.message || asHumanError(e))}`,
          ts: Date.now(),
        });

        setBanner({ type: "error", title: "🧯 We handled an error safely", sub: normalizeWs(e?.message || asHumanError(e)) });
      }

      setHealth((h) => ({ ...h, ok: false, last: Date.now() }));
    } finally {
      setIsSending(false);
      log("send() finished");
    }
  }, [input, isSending, docs, mode, addMessage, replaceLastAssistant, docAvail, activeDocsLabel]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        log("Enter pressed -> send()");
        send();
      }
    },
    [send]
  );

  return (
    <ErrorBoundary>
      <div className="cc-root">
        {/* NAVBAR */}
      
<div className="cc-topbar">
  <div className="cc-navPill">
    <img
      className="cc-navLogo"
      src="/HP-logo-gold.png"   /* <--- CHANGE THIS NAME */
      alt="HotelPlanner"
      // ... existing props
    />

    <button
      className={`cc-navItem ${resourcesOpen ? "cc-navItemPill is-active" : ""}`}
      type="button"
      onClick={() => setResourcesOpen(true)}
    >
      Resources
    </button>

    {/* --- INSERT THIS LINE --- */}
   <div className="cc-navTitle">Call Center Compliance tool</div>
    {/* ------------------------ */}

    <div className="cc-navSpacer" />

    {/* "Say Hello" button removed from here */}
  </div>
</div>

<ResourcePopover open={resourcesOpen} onClose={() => setResourcesOpen(false)} />

{/* Main */}
<div className="cc-main">
{/* ... rest of your code ... */}
          <div className="cc-thread">
            <div className="cc-threadInner">
              {banner ? (
                <div className="cc-bannerError">
                  <div style={{ fontWeight: 700 }}>{banner.title}</div>
                  <div className="cc-bannerSub">{banner.sub}</div>
                </div>
              ) : null}

              <div className="cc-hero">
                <div className="cc-heroTitle">
                  Mode: <b>{mode === "cloud" ? "Cloud" : "Local"}</b> • Docs: <b>{activeDocsLabel}</b>
                </div>
                <div className="cc-heroSub">
                  Server:{" "}
                  <span style={{ fontWeight: 700 }}>{health.ok == null ? "checking…" : health.ok ? "online" : "offline"}</span>
                  {health.last ? (
                    <span style={{ marginLeft: 8, color: "rgba(17,24,39,0.45)", fontSize: 12 }}>
                      ({new Date(health.last).toLocaleTimeString()})
                    </span>
                  ) : null}
                </div>
              </div>

              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} isIntro={m.id === firstAssistantId} />
              ))}

              <div ref={threadEndRef} />
              <div className="cc-spacer" />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="cc-footer">
          <div className="cc-footer-inner">
            <div className="cc-docRow">
              {DOC_META.map((d) => {
                const active = !!docs[d.key];
                const available = !!docAvail[d.key];
                const disabled = !available;

                return (
                  <button
                    key={d.key}
                    className={`cc-chip ${active ? "is-active" : ""}`}
                    title={disabled ? `${d.label} not found in /public (check filename)` : `Toggle ${d.label}`}
                    onClick={() => {
                      log("Doc chip clicked:", { key: d.key, label: d.label, active, available });
                      if (disabled) {
                        setBanner({
                          type: "error",
                          title: "📁 Missing public file",
                          sub: `${d.label} not found at ${d.path}. Make sure it exists in /public exactly.`,
                        });
                        return;
                      }
                      toggleDoc(d.key);
                    }}
                    style={{ opacity: disabled ? 0.45 : 1 }}
                    type="button"
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>

            {/* Buttons removed here */}

            <div className="cc-inputShell">
              <button className="cc-iconBtn" type="button" disabled title="Attachments disabled">
                <span className="cc-plus">+</span>
              </button>

              <textarea
                ref={textareaRef}
                className="cc-textarea"
                value={input}
                placeholder="Type the guest situation… (Enter to send, Shift+Enter for new line)"
                onChange={(e) => {
                  log("Input changed:", { len: e.target.value.length });
                  setInput(e.target.value);
                }}
                onKeyDown={onKeyDown}
                disabled={isSending}
                spellCheck
              />

              <button
                className="cc-sendBtn"
                type="button"
                onClick={clearInput}
                disabled={isSending || !input.trim()}
                title="Clear"
                style={{ width: 40 }}
              >
                ✕
              </button>

              <button
                className="cc-sendBtn"
                type="button"
                onClick={() => {
                  log("Send button clicked");
                  send();
                }}
                disabled={isSending || !input.trim()}
                title="Send"
              >
                ➤
              </button>
            </div>

            <div className="cc-footer-note">
              This tool follows selected documents strictly. If something looks off, double-check the doc chips.
            </div>
          </div>
        </div>

        {/* Hidden logo video (optional) */}
        <video
          src={NAV_LOGO_VIDEO_SRC}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          muted
          playsInline
          onError={() => warn("Nav logo video missing:", NAV_LOGO_VIDEO_SRC)}
        />
      </div>
    </ErrorBoundary>
  );
}