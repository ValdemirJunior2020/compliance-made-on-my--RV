import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import * as XLSX from "xlsx";
import "./App.css";

const API_BASE = "https://compliance-made-on-my-rv.onrender.com";

// public assets
const MATRIX_PUBLIC_PATH = "/Service Matrix's 2026.xlsx";
const LOADING_GIF_SRC = "/loading.gif";
const NAV_LOGO_VIDEO_SRC = "/Video_Generation_Confirmation.mp4";
const ERROR_VIDEO_SRC = "/Video_Animation_For_Error_Created.mp4"; // <-- ADD

// ====== DOCUMENTS (placeholders for tomorrow) ======
const trainingGuideKnowledge = `TRAINING GUIDE DOCUMENTS (PASTE HERE TOMORROW)`;
const qaVoiceKnowledge = `QUALITY ASSURANCE VOICE DOCUMENTS (PASTE HERE TOMORROW)`;
const qaGroupRequestKnowledge = `QUALITY ASSURANCE GROUP REQUEST DOCUMENTS (PASTE HERE TOMORROW)`;
const hotelPlannerKnowledge = `HOTELPLANNER CORE DOCUMENTS (PASTE HERE TOMORROW)`;

// ====== PROMPT ======
const SYSTEM_PROMPT = `You are QA Master — strict compliance & quality expert for HotelPlanner call center agents.
Answer ONLY from the provided HotelPlanner documents.
Never guess, never use external knowledge, never invent steps.
If question cannot be answered from documents or is unrelated → say: 'This question is outside the scope of our documented HotelPlanner procedures. Please check with your supervisor or QA team.'

HotelPlanner documents:
{{hotelPlannerKnowledge}}

Agent question:
{{question}}

Mandatory answer format (STRICT — follow exactly):

Follow the steps:
1) ...
2) ...
3) ...

Then add:

Matrix Reference
- Sheet: [Voice Matrix or Ticket Matrix]
- Category: [exact category header from matrix]
- Issue Row: [exact issue title from matrix]

QA Check
• Compliance: [Yes/No + one sentence]
• Guest experience: [one sentence]
• Risk prevention: [one sentence]

Rules:
- Use ONLY information that appears in the documents/matrix text above.
- If the exact issue row cannot be found, say it is outside scope.
- Do not add extra sections besides the required ones.
Be concise yet complete (300–900 words).`;

function safeText(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function normalizeCell(v) {
  return safeText(v).replace(/\u200b|\u200c|\u200d|\ufeff/g, "").trim();
}

function extractClaudeText(payload) {
  const content = payload?.content;
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => safeText(b.text))
      .filter(Boolean);
    if (textBlocks.length) return textBlocks.join("\n\n").trim();
  }
  return safeText(payload?.text || payload?.output_text || "").trim();
}

function buildSystemPrompt(question, knowledge) {
  return SYSTEM_PROMPT.replace("{{hotelPlannerKnowledge}}", knowledge).replace(
    "{{question}}",
    String(question || "").trim()
  );
}

function useAutosizeTextarea(value) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 200);
    el.style.height = next + "px";
  }, [value]);
  return ref;
}

function sheetToMatrixText(worksheet, sheetLabel) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });

  let currentCategory = "";
  const out = [];
  out.push(`=== ${sheetLabel} ===`);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const c1 = normalizeCell(row[1]);
    const c2 = normalizeCell(row[2]);
    const c3 = normalizeCell(row[3]);
    const c4 = normalizeCell(row[4]);
    const c5 = normalizeCell(row[5]);
    const c6 = normalizeCell(row[6]);
    const c7 = normalizeCell(row[7]);

    if (c1 && c2.toLowerCase() === "instructions") {
      currentCategory = c1;
      out.push("");
      out.push(`# ${currentCategory}`);
      out.push("");
      continue;
    }

    if (!c1 || !c2) continue;
    if (!currentCategory) currentCategory = "General";

    const parts = [];
    parts.push(`- Issue: ${c1}`);
    parts.push(`  Instructions: ${c2}`);
    if (c3) parts.push(`  Slack: ${c3}`);
    if (c4) parts.push(`  Refund Queue: ${c4}`);
    if (c5) parts.push(`  Create a Ticket: ${c5}`);
    if (c6) parts.push(`  Supervisor: ${c6}`);
    if (c7) parts.push(`  VIPRES: ${c7}`);

    out.push(parts.join("\n"));
    out.push("");
  }

  return out.join("\n").trim();
}

function sheetToNotesText(worksheet, sheetLabel) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
  const out = [];
  out.push(`=== ${sheetLabel} ===`);
  out.push("");

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const title = normalizeCell(row[1]);
    const col2 = normalizeCell(row[2]);
    const col3 = normalizeCell(row[3]);

    if (!title) continue;
    if (!col2 && !col3) continue;

    out.push(`- ${title}`);
    if (col2) out.push(`  ${col2}`);
    if (col3) out.push(`  ${col3}`);
    out.push("");
  }

  return out.join("\n").trim();
}

// NEW: detect "low credits" billing error and show special UI
function isBillingLowCredits(errText) {
  const s = String(errText || "").toLowerCase();
  return (
    s.includes("credit balance is too low") ||
    s.includes("plans & billing") ||
    s.includes("purchase credits") ||
    s.includes("insufficient") ||
    s.includes("billing")
  );
}

export default function App() {
  const [matrixMode, setMatrixMode] = useState("voice");
  const [docMode, setDocMode] = useState("matrix");

  const [activeSourceLabel, setActiveSourceLabel] = useState("Matrix");
  const [activeTabLabel, setActiveTabLabel] = useState("Voice (Customer Service)");
  const [debugInfo, setDebugInfo] = useState("");

  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [errorMsg, setErrorMsg] = useState("");
  const [isBillingError, setIsBillingError] = useState(false); // <-- ADD

  const [matrixVoiceText, setMatrixVoiceText] = useState("");
  const [matrixTicketText, setMatrixTicketText] = useState("");
  const [matrixNotesText, setMatrixNotesText] = useState("");
  const [matrixLoadError, setMatrixLoadError] = useState("");

  const textareaRef = useAutosizeTextarea(question);
  const listRef = useRef(null);

  useEffect(() => {
    marked.setOptions({ gfm: true, breaks: true });
  }, []);

  useEffect(() => {
    async function loadMatrix() {
      setMatrixLoadError("");
      try {
        const res = await fetch(MATRIX_PUBLIC_PATH, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(
            `Matrix file not found. Put it in /public as: public/Service Matrix's 2026.xlsx (HTTP ${res.status})`
          );
        }
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });

        const voiceWs = wb.Sheets["Voice Matrix"] || wb.Sheets[wb.SheetNames[0]];
        const ticketWs = wb.Sheets["Ticket Matrix"] || wb.Sheets[wb.SheetNames[1]];
        const notesWs = wb.Sheets["Items to note"] || wb.Sheets[wb.SheetNames[2]];

        setMatrixVoiceText(voiceWs ? sheetToMatrixText(voiceWs, "VOICE MATRIX (Customer Service)") : "");
        setMatrixTicketText(ticketWs ? sheetToMatrixText(ticketWs, "TICKET MATRIX (Tickets Agents)") : "");
        setMatrixNotesText(notesWs ? sheetToNotesText(notesWs, "ITEMS TO NOTE") : "");
      } catch (e) {
        setMatrixLoadError(e?.message || "Failed to load matrix.");
      }
    }

    loadMatrix();
  }, []);

  const activeMatrixText = matrixMode === "voice" ? matrixVoiceText : matrixTicketText;

  const activeDocsText = useMemo(() => {
    if (docMode === "training") return trainingGuideKnowledge;
    if (docMode === "qaVoice") return qaVoiceKnowledge;
    if (docMode === "qaGroup") return qaGroupRequestKnowledge;
    return activeMatrixText;
  }, [docMode, activeMatrixText]);

  const combinedKnowledge = useMemo(() => {
    return [hotelPlannerKnowledge.trim(), activeDocsText.trim(), matrixNotesText.trim()]
      .filter(Boolean)
      .join("\n\n");
  }, [activeDocsText, matrixNotesText]);

  const answerHtml = useMemo(() => {
    const a = (answer || "").trim();
    if (!a) return "";
    return marked.parse(a);
  }, [answer]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [answer, isLoading, errorMsg, lastQuestion, isBillingError]);

  useEffect(() => {
    const which =
      docMode === "matrix"
        ? `Doc: Matrix | Tab: ${matrixMode}`
        : docMode === "training"
        ? "Doc: Training Guide"
        : docMode === "qaVoice"
        ? "Doc: QA Voice"
        : "Doc: QA Group Request";

    const matrixLen = (activeMatrixText || "").length;
    const notesLen = (matrixNotesText || "").length;
    const docsLen = (activeDocsText || "").length;
    const coreLen = (hotelPlannerKnowledge || "").length;

    setDebugInfo(`${which} | lengths => core:${coreLen} docs:${docsLen} matrix:${matrixLen} notes:${notesLen}`);
  }, [docMode, matrixMode, activeMatrixText, activeDocsText, matrixNotesText]);

  async function send() {
    const q = question.trim();
    if (!q || isLoading) return;

    setIsLoading(true);
    setErrorMsg("");
    setIsBillingError(false);
    setAnswer("");
    setLastQuestion(q);

    try {
      const system = buildSystemPrompt(q, combinedKnowledge);

      const res = await fetch(`${API_BASE}/api/claude`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system, question: q }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const details = data?.details ? String(data.details) : "";
        const msg = data?.error ? String(data.error) : "Request failed";
        const full = `${msg}${details ? "\n\n" + details : ""}`;

        // NEW: if billing/credits error, show video UI
        const billing = isBillingLowCredits(full);
        setIsBillingError(billing);

        throw new Error(full);
      }

      const text = extractClaudeText(data);
      setAnswer(text || "No answer returned.");
      setQuestion("");
    } catch (err) {
      const msg = err?.message || "Failed to fetch.";
      setErrorMsg(msg);
      setIsBillingError(isBillingLowCredits(msg));
    } finally {
      setIsLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const canSend = question.trim().length > 0 && !isLoading;

  return (
    <div className="cc-root">
      <header className="cc-topbar">
        <div className="cc-topbar-inner">
          <div className="cc-nav-left">
            <video className="cc-nav-logoVideo" src={NAV_LOGO_VIDEO_SRC} autoPlay loop muted playsInline />
          </div>
          <div className="cc-title">Call Center Compliance App</div>
          <div className="cc-nav-right" />
        </div>
      </header>

      <main className="cc-main">
        <div className="cc-thread" ref={listRef}>
          <div className="cc-threadInner">
            {matrixLoadError ? (
              <div className="cc-bannerError">
                {matrixLoadError}
                <div className="cc-bannerSub">
                  Fix: put your Excel file here exactly: <b>public/Service Matrix&apos;s 2026.xlsx</b>
                </div>
              </div>
            ) : null}

            {!lastQuestion && !answer && !isLoading && !errorMsg ? (
              <div className="cc-hero">
                <div className="cc-heroTitle">HotelPlanner • QA Compliance</div>
                <div className="cc-heroSub">Choose a document button below, then ask a guest situation question.</div>
              </div>
            ) : null}

            {lastQuestion ? (
              <div className="cc-msg cc-user">
                <div className="cc-bubble">
                  <div className="cc-bubbleText">{lastQuestion}</div>
                </div>
              </div>
            ) : null}

            {isLoading ? (
              <div className="cc-msg cc-assistant">
                <div className="cc-bubble cc-bubbleAssistant">
                  <div className="cc-loadingWrap">
                    <img className="cc-loadingGif" src={LOADING_GIF_SRC} alt="Loading" />
                    <div className="cc-thinking">Thinking…</div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* NEW: billing/credits error animation */}
            {!isLoading && isBillingError ? (
              <div className="cc-msg cc-assistant">
                <div className="cc-bubble cc-bubbleAssistant">
                  <div className="cc-errorMedia">
                    <video className="cc-errorVideo" src={ERROR_VIDEO_SRC} autoPlay loop muted playsInline />
                    <div className="cc-errorTitle">Claude credits needed</div>
                    <div className="cc-errorHint">
                      Your Anthropic account has no credits right now. Ask your supervisor to add credits or create a
                      new API key with billing enabled.
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {errorMsg && !isBillingError ? (
              <div className="cc-msg cc-assistant">
                <div className="cc-bubble cc-bubbleAssistant">
                  <div className="cc-error" role="alert">
                    {errorMsg}
                  </div>
                </div>
              </div>
            ) : null}

            {answer ? (
              <div className="cc-msg cc-assistant">
                <div className="cc-bubble cc-bubbleAssistant">
                  <article className="cc-answer" dangerouslySetInnerHTML={{ __html: answerHtml }} />
                </div>
              </div>
            ) : null}

            <div className="cc-spacer" />
          </div>
        </div>
      </main>

      <footer className="cc-footer">
        <div className="cc-footer-inner">
          <div className="cc-docRow" role="group" aria-label="Knowledge source">
            <button
              type="button"
              className={`cc-chip ${docMode === "matrix" ? "is-active" : ""}`}
              onClick={() => {
                setDocMode("matrix");
                setActiveSourceLabel("Matrix");
              }}
            >
              Matrix
            </button>

            <button
              type="button"
              className={`cc-chip ${docMode === "training" ? "is-active" : ""}`}
              onClick={() => {
                setDocMode("training");
                setActiveSourceLabel("Training Guide");
              }}
            >
              Training Guide
            </button>

            <button
              type="button"
              className={`cc-chip ${docMode === "qaVoice" ? "is-active" : ""}`}
              onClick={() => {
                setDocMode("qaVoice");
                setActiveSourceLabel("Quality Assurance Voice");
              }}
            >
              Quality Assurance Voice
            </button>

            <button
              type="button"
              className={`cc-chip ${docMode === "qaGroup" ? "is-active" : ""}`}
              onClick={() => {
                setDocMode("qaGroup");
                setActiveSourceLabel("Quality Assurance Group Request");
              }}
            >
              Quality Assurance Group Request
            </button>
          </div>

          <div className="cc-modeRow" role="group" aria-label="Matrix tab">
            <button
              type="button"
              className={`cc-chip ${matrixMode === "voice" ? "is-active" : ""}`}
              onClick={() => {
                setMatrixMode("voice");
                setActiveTabLabel("Voice (Customer Service)");
              }}
            >
              Voice (Customer Service)
            </button>

            <button
              type="button"
              className={`cc-chip ${matrixMode === "ticket" ? "is-active" : ""}`}
              onClick={() => {
                setMatrixMode("ticket");
                setActiveTabLabel("Tickets (Ticket Agents)");
              }}
            >
              Tickets (Ticket Agents)
            </button>
          </div>

          <div className="cc-selectedLine">
            Using: <b>{activeSourceLabel}</b>
            {docMode === "matrix" ? (
              <>
                {" "}
                • Tab: <b>{activeTabLabel}</b>
              </>
            ) : null}
            <div className="cc-debugSmall">{debugInfo}</div>
          </div>

          <div className="cc-inputShell">
            <button className="cc-iconBtn" type="button" aria-label="Add (disabled)" disabled>
              <span className="cc-plus">+</span>
            </button>

            <textarea
              ref={textareaRef}
              className="cc-textarea"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about any guest situation, procedure or compliance question…"
              rows={1}
              spellCheck={true}
              disabled={isLoading}
            />

            <button className="cc-iconBtn" type="button" aria-label="Mic (disabled)" disabled>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path d="M19 11a7 7 0 0 1-14 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M12 18v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>

            <button className="cc-sendBtn" onClick={send} disabled={!canSend} aria-label="Send" type="button">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 11.5L21 3L12.5 21L11 13L3 11.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <div className="cc-footer-note">Quality Assurance team Management "Junior-2026"</div>
        </div>
      </footer>
    </div>
  );
}
