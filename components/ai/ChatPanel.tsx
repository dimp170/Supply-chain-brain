"use client";

/**
 * ChatPanel — the global AI assistant surface.
 *
 * Slides in from the right edge as an overlay, sits ABOVE the sidebar so it
 * can be opened on any vehicle view without losing context. Conversation
 * history lives in local component state — refreshing the page clears it,
 * which is the right default for a demo (each judge gets a clean slate).
 *
 * Backend round-trip: services/aiClient.ts → POST /api/ai/chat →
 * services/nim_chat.py → NVIDIA NIM (Nemotron 3 Super 120B). The frontend
 * assembles a fleet/disruption snapshot per turn so the model can ground
 * answers in current state.
 */

import { useEffect, useRef, useState } from "react";
import { useVehicleStore } from "@/stores/vehicleStore";
import { sendChat, type ChatMessage } from "@/api/aiClient";
import { X, Send, Sparkles, Loader2, AlertCircle } from "lucide-react";

// Preset prompts surfaced in the empty state. Picked from the flagship demo
// queries we identified — each one demonstrates a different mode of AI value
// (synthesis / counterfactual / joint optimization).
const STARTER_PROMPTS: { label: string; prompt: string }[] = [
    {
        label: "Biggest fleet risk right now",
        prompt: "What's my biggest fleet risk in the next 48 hours? Reference specific vehicles and severity.",
    },
    {
        label: "Suez exposure if closure extends",
        prompt: "If the Suez Canal stays closed for 5 days, what's my financial and operational exposure across the fleet?",
    },
    {
        label: "Reroute the affected vessels",
        prompt: "Reroute the vessels currently flagged with disruptions. Walk me through your reasoning for each — and how the recommendations interact (shared fuel stops, anchorage capacity, crew hours).",
    },
];

export default function ChatPanel() {
    const open = useVehicleStore((s) => s.chatOpen);
    const setOpen = useVehicleStore((s) => s.setChatOpen);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    // Auto-scroll to bottom on new message.
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, pending]);

    // Focus the input when the panel opens.
    useEffect(() => {
        if (open) {
            inputRef.current?.focus();
        }
    }, [open]);

    // ESC closes the panel — only when chat is open and the user isn't mid-keystroke.
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [open, setOpen]);

    const send = async (promptText?: string) => {
        const content = (promptText ?? input).trim();
        if (!content || pending) return;
        setError(null);

        const userMessage: ChatMessage = { role: "user", content };
        const nextHistory: ChatMessage[] = [...messages, userMessage];
        setMessages(nextHistory);
        setInput("");
        setPending(true);

        try {
            const response = await sendChat(nextHistory);
            const assistantContent = response.message?.content || "(no response)";
            setMessages((prev) => [...prev, { role: "assistant", content: assistantContent }]);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            setError(message);
        } finally {
            setPending(false);
        }
    };

    const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    return (
        <>
            {/* Backdrop — fades in when panel opens, click to close.
             *  Lighter than a sidebar drawer because the chat is more of an
             *  ambient surface, not a modal that demands attention. */}
            <div
                className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 ${
                    open ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
                onClick={() => setOpen(false)}
            />

            {/* Panel — slides in from right.
             *  z-50 so it sits above the backdrop, the topbar, and any
             *  sidebar drawer. Width 440px reads like a primary surface
             *  rather than a secondary detail panel. */}
            <aside
                className={`fixed right-0 top-0 bottom-0 z-50 w-[440px] flex flex-col bg-zinc-950 border-l border-zinc-800/80 shadow-2xl transition-transform duration-300 ease-out ${
                    open ? "translate-x-0" : "translate-x-full"
                }`}
                aria-hidden={!open}
            >
                {/* Header */}
                <div className="flex items-center justify-between h-12 px-4 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                        <Sparkles size={14} className="text-rose-300" />
                        <span className="font-mono text-[11px] tracking-[0.25em] text-white">
                            AI ASSISTANT
                        </span>
                        <span className="font-mono text-[9px] tracking-wider text-zinc-600 ml-1">
                            NEMOTRON 3 SUPER
                        </span>
                    </div>
                    <button
                        onClick={() => setOpen(false)}
                        className="text-zinc-500 hover:text-white transition-colors focus:outline-none"
                        aria-label="Close chat panel"
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Message area */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
                    {messages.length === 0 ? (
                        <EmptyState onPickPrompt={(p) => send(p)} disabled={pending} />
                    ) : (
                        <div className="space-y-4">
                            {messages.map((m, i) => (
                                <MessageBubble key={i} role={m.role} content={m.content} />
                            ))}
                            {pending && (
                                <div className="flex items-center gap-2 text-zinc-500 text-xs">
                                    <Loader2 size={12} className="animate-spin" />
                                    Thinking…
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Error banner — sits above the input so it's visible but
                 *  doesn't break the conversation history. */}
                {error && (
                    <div className="px-4 py-2 border-t border-red-500/30 bg-red-500/10 flex items-start gap-2">
                        <AlertCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
                        <span className="text-[11px] text-red-300 break-words">{error}</span>
                        <button
                            onClick={() => setError(null)}
                            className="ml-auto text-red-400 hover:text-white shrink-0"
                            aria-label="Dismiss error"
                        >
                            <X size={11} />
                        </button>
                    </div>
                )}

                {/* Input area */}
                <div className="border-t border-zinc-800/80 bg-zinc-950/95 px-3 py-3">
                    <div className="flex items-end gap-2">
                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={onInputKeyDown}
                            placeholder={pending ? "Waiting on response…" : "Ask about your fleet…"}
                            disabled={pending}
                            rows={1}
                            className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-md px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 resize-none disabled:opacity-50 max-h-[120px]"
                            style={{ minHeight: 36 }}
                        />
                        <button
                            onClick={() => send()}
                            disabled={!input.trim() || pending}
                            className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md border border-rose-500/40 bg-rose-500/[0.08] text-rose-200 hover:border-rose-400 hover:bg-rose-500/[0.15] transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none"
                            aria-label="Send message"
                        >
                            <Send size={13} />
                        </button>
                    </div>
                    <div className="text-[9px] font-mono tracking-wider text-zinc-700 mt-1.5">
                        ENTER to send · SHIFT+ENTER for newline · ESC to close
                    </div>
                </div>
            </aside>
        </>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EmptyState({
    onPickPrompt, disabled,
}: {
    onPickPrompt: (prompt: string) => void;
    disabled: boolean;
}) {
    return (
        <div className="flex flex-col items-start gap-3 mt-2">
            <div className="text-[11px] text-zinc-400 leading-relaxed">
                I have current context on your fleet — vehicle statuses, active
                disruptions, and the scenario you've selected (if any). Ask me
                anything about your operations.
            </div>
            <div className="text-[9px] font-mono tracking-[0.2em] text-zinc-600 mt-2">
                TRY ONE OF THESE
            </div>
            <div className="flex flex-col gap-1.5 w-full">
                {STARTER_PROMPTS.map((p, i) => (
                    <button
                        key={i}
                        onClick={() => onPickPrompt(p.prompt)}
                        disabled={disabled}
                        className="text-left px-3 py-2 rounded-md border border-zinc-800 bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/70 transition-colors disabled:opacity-50 focus:outline-none"
                    >
                        <span className="text-[11px] text-zinc-200">{p.label}</span>
                        <span className="block text-[10px] text-zinc-500 mt-0.5 line-clamp-2">
                            {p.prompt}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function MessageBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
    const isUser = role === "user";
    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div
                className={`max-w-[90%] px-3 py-2 rounded-lg text-xs leading-relaxed whitespace-pre-wrap ${
                    isUser
                        ? "bg-zinc-800/80 text-white"
                        : "bg-zinc-900/60 border border-zinc-800/60 text-zinc-200"
                }`}
            >
                {content}
            </div>
        </div>
    );
}
