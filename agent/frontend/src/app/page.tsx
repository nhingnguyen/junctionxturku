"use client";

import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type ToolUse = { name: string; args: Record<string, unknown> };
type Msg = { role: "user" | "assistant"; content: string; tools?: ToolUse[]; error?: boolean };
type Status = { online: boolean; provider?: string; tools: number };

const SUGGESTIONS = [
  "What's the weather in Helsinki right now?",
  "Can you show me the news from hackernews today?",
  "Any new commits or issues from my GitHub repositories today?",
  "List the events for this week.",
];

function ToolTrace({ tool }: { tool: ToolUse }) {
  const args = Object.entries(tool.args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return (
    <div className="trace">
      <span className="trace-name">{tool.name}</span>
      <span className="trace-args">{args}</span>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<Status>({ online: false, tools: 0 });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/health`).then((r) => r.json()),
      fetch(`${API}/tools`).then((r) => r.json()),
    ])
      .then(([h, t]) => setStatus({ online: true, provider: h.provider, tools: t.length }))
      .catch(() => setStatus({ online: false, tools: 0 }));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message }]);
    setLoading(true);

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setSessionId(data.sessionId);
      setMessages((m) => [...m, { role: "assistant", content: data.reply, tools: data.toolsUsed }]);

      // ===================== ADDED FOR PASILA INTELLIGENCE (map focus) =====================
      // When this UI is embedded as the Assistant panel in Pasila Intelligence (an iframe),
      // send each reply to the parent page so its map can focus on the buildings/areas named.
      // Pasila accepts the message only from this iframe's origin and matches the text against
      // official data (VTJ-PRT, property ID, address, street, postal code).
      // Opened on its own (not in an iframe), window.parent is this window and nothing listens.
      // Protocol: { type: "assistant:reply", text: string }  (see README of the dev/fe branch)
      // Delivered only to Pasila served locally at http://localhost:8000 (not 127.0.0.1); change for deployment.
      window.parent?.postMessage({ type: "assistant:reply", text: data.reply }, "http://localhost:8000");
      // =================== END ADDED FOR PASILA INTELLIGENCE (map focus) ===================
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          error: true,
          content: `Could not reach the API at ${API}. Start the backend, then send again. (${(e as Error).message})`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setSessionId(undefined);
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>Ask, and it checks.</h1>
          <p className="sub">An assistant that calls real tools through MCP instead of guessing.</p>
        </div>
        <div className="top-side">
          <span className={`pill ${status.online ? "on" : "off"}`}>
            <i aria-hidden />
            {status.online ? `${status.provider} with ${status.tools} tool${status.tools === 1 ? "" : "s"}` : "API offline"}
          </span>
          {messages.length > 0 && (
            <button className="ghost" onClick={reset}>
              New chat
            </button>
          )}
        </div>
      </header>

      <main className="thread" aria-live="polite">
        {messages.length === 0 && (
          <section className="empty">
            <p>Try one of these. Each one makes the assistant call a tool, and you will see the call before the answer.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </section>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.content}
            </div>
          ) : (
            <div key={i} className={`msg bot${m.error ? " err" : ""}`}>
              {m.tools?.map((t, j) => <ToolTrace key={j} tool={t} />)}
              <p>{m.content}</p>
            </div>
          ),
        )}

        {loading && (
          <div className="msg bot" aria-label="The assistant is working">
            <span className="dots"><b /><b /><b /></span>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask anything"
          aria-label="Message"
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}