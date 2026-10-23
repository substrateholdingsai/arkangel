import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from './api';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  suggestedDraft?: string | null;
}

interface CopilotWidgetProps {
  activeCaseId: string | null;
  activeCaseName?: string | null;
  humanCount: number;
}

const QUICK_PROMPTS = [
  {
    label: '👋 Soy nuevo, ¿cómo empiezo mi turno?',
    prompt:
      'Soy un operador nuevo en Arkangel. Explícame paso a paso qué debo hacer al iniciar mi turno hoy según el estado actual del despacho.',
  },
  {
    label: '🚨 ¿Qué casos urgentes atiendo hoy?',
    prompt:
      '¿Cuáles son los casos delegados a humano hoy, cuánto deben y cuál debería atender primero?',
  },
  {
    label: '⚖️ ¿Qué prohíbe el Motor Legal?',
    prompt:
      'Explícame las reglas más importantes del Motor Legal y qué palabras o prácticas tengo estrictamente prohibidas al escribir o llamar.',
  },
  {
    label: '✍️ Redactar respuesta al caso abierto',
    prompt:
      'Ayúdame a redactar una respuesta empática, firme y 100% blindada legalmente para el deudor que tengo abierto en el Drawer.',
  },
];

export function CopilotWidget({ activeCaseId, activeCaseName, humanCount }: CopilotWidgetProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Hola, soy el **Copiloto Arkangel** conectado en tiempo real al Worker, a la base D1 y al Motor Legal (12 reglas / 48 conductas). Pregúntame cómo operar la plataforma, qué casos urgentes atender o abre un caso para que te redacte una respuesta legalmente blindada.',
    },
  ]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, open]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userTurn: ChatTurn = {
      id: `usr_${Date.now()}`,
      role: 'user',
      content: trimmed,
    };

    const nextHistory = [...turns, userTurn];
    setTurns(nextHistory);
    setInput('');
    setSending(true);

    try {
      const historyPayload = nextHistory
        .filter((t) => t.id !== 'welcome')
        .slice(-6)
        .map((t) => ({ role: t.role, content: t.content }));

      const res = await api.copilotChat({
        message: trimmed,
        history: historyPayload,
        active_case_id: activeCaseId,
      });

      setTurns((prev) => [
        ...prev,
        {
          id: `ast_${Date.now()}`,
          role: 'assistant',
          content: res.reply,
          suggestedDraft: res.suggested_draft,
        },
      ]);
    } catch (e) {
      setTurns((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content:
            e instanceof Error
              ? `No pude consultar el Worker: ${e.message}`
              : 'Error temporal al consultar el Copiloto.',
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const copyDraft = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* fallback sin clipboard */
    }
  };

  // Si el Drawer derecho está abierto, el widget se posiciona a la izquierda para no tapar el chat con el deudor.
  const positionClass = activeCaseId ? 'left-5 bottom-5' : 'right-5 bottom-5';

  return (
    <div className={`fixed ${positionClass} z-50 transition-all`}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-white shadow-xl border border-slate-700 hover:bg-slate-800 transition-all"
        >
          <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <Bot className="h-4 w-4" />
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-900 animate-pulse" />
          </span>
          <div className="text-left">
            <div className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
              <span>Copiloto Arkangel</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
                IA · QA
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              {activeCaseName
                ? `Viendo: ${activeCaseName.slice(0, 22)}`
                : humanCount > 0
                  ? `${humanCount} caso(s) esperan operador`
                  : 'Manual vivo y asistencia legal'}
            </div>
          </div>
        </button>
      ) : (
        <div className="flex flex-col w-[380px] sm:w-[420px] h-[560px] max-h-[82vh] rounded-xl bg-white border border-slate-300 shadow-2xl overflow-hidden">
          {/* Header Meridian Core Slate 900 */}
          <div className="bg-slate-900 px-4 py-3 text-white flex items-center justify-between border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight">Copiloto Arkangel</h3>
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
                    <ShieldCheck className="h-3 w-3" /> Worker Live
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 font-mono truncate max-w-[250px]">
                  {activeCaseName
                    ? `Caso activo: ${activeCaseName}`
                    : 'Contexto: Despacho + 12 Reglas Legales'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Minimizar Copiloto"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Chips de consulta rápida */}
          <div className="bg-slate-50 px-3 py-2 border-b border-slate-200 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            <HelpCircle className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            {QUICK_PROMPTS.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={sending}
                onClick={() => void sendMessage(item.prompt)}
                className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:border-emerald-500 hover:text-emerald-700 transition-colors disabled:opacity-50"
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Historial de conversación */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/60">
            {turns.map((turn) => (
              <div
                key={turn.id}
                className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                    turn.role === 'user'
                      ? 'bg-slate-900 text-white'
                      : 'bg-white border border-slate-200 text-slate-800 shadow-sm'
                  }`}
                >
                  {turn.content}
                </div>

                {turn.suggestedDraft ? (
                  <div className="mt-2 max-w-[90%] rounded-lg border border-emerald-300 bg-emerald-50/80 p-3 text-xs text-emerald-950">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-semibold text-[11px] uppercase tracking-wider text-emerald-800 flex items-center gap-1">
                        <MessageSquarePlus className="h-3.5 w-3.5" /> Borrador Blindado (Reglas 1.1
                        / 3.2 / 8.1)
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyDraft(turn.id, turn.suggestedDraft!)}
                        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
                      >
                        {copiedId === turn.id ? (
                          <>
                            <Check className="h-3 w-3" /> Copiado
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copiar
                          </>
                        )}
                      </button>
                    </div>
                    <p className="font-mono text-[11px] text-emerald-900 bg-white/90 rounded p-2 border border-emerald-200">
                      {turn.suggestedDraft}
                    </p>
                  </div>
                ) : null}
              </div>
            ))}

            {sending ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-white border border-slate-200 rounded-xl px-3 py-2 w-fit">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />
                <span>Consultando Worker y Motor Legal…</span>
              </div>
            ) : null}
          </div>

          {/* Input de pregunta */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(input);
            }}
            className="p-3 bg-white border-t border-slate-200 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                activeCaseName
                  ? `Pregunta sobre ${activeCaseName.split(' ')[0]} o el sistema…`
                  : 'Pregunta qué hacer, reglas legales o casos de hoy…'
              }
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-600"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
