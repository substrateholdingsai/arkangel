import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from './api';

// Lazy-load Spline para mantener el bundle inicial rápido y liviano
const Spline = lazy(() => import('@splinetool/react-spline'));

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

const SPLINE_SCENE_URL = 'https://prod.spline.design/IaZypc0K4Rnb07vW/scene.splinecode';

const QUICK_PROMPTS = [
  {
    label: '👋 Iniciar turno',
    prompt:
      'Soy un operador nuevo en Arkangel. Explícame paso a paso qué debo hacer al iniciar mi turno hoy según el estado actual del despacho.',
  },
  {
    label: '🚨 Casos urgentes',
    prompt:
      '¿Cuáles son los casos delegados a humano hoy, cuánto deben y cuál debería atender primero?',
  },
  {
    label: '⚖️ 12 Reglas Legales',
    prompt:
      'Explícame las reglas más importantes del Motor Legal y qué palabras o prácticas tengo estrictamente prohibidas al escribir o llamar.',
  },
  {
    label: '✍️ Redactar respuesta',
    prompt:
      'Ayúdame a redactar una respuesta empática, firme y 100% blindada legalmente para el deudor que tengo abierto en el Drawer.',
  },
];

export function CopilotWidget({ activeCaseId, activeCaseName, humanCount }: CopilotWidgetProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [splineError, setSplineError] = useState(false);

  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Hola, soy **Ark**, tu asistente 3D de cobranza legal en tiempo real. Pregúntame cómo operar el despacho, qué casos urgentes atender o tócame / presiona el micrófono para hablarme directamente.',
    },
  ]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<unknown>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, open]);

  // Soporte de reconocimiento de voz por Web Speech API (es-MX)
  const toggleListening = () => {
    if (isListening) {
      if (recognitionRef.current) {
        (recognitionRef.current as any).stop();
      }
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(
        'Tu navegador no soporta reconocimiento de voz nativo. Puedes escribir tu duda en el teclado.'
      );
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'es-MX';
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
        setIsListening(false);
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

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

  // Posicionamiento adaptativo si el Drawer está abierto
  const positionClass = activeCaseId ? 'left-5 bottom-5' : 'right-5 bottom-5';

  return (
    <div className={`fixed ${positionClass} z-50 transition-all`}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex items-center gap-3 rounded-full bg-slate-900/95 pl-1.5 pr-4 py-1.5 text-white shadow-2xl border border-slate-700 hover:border-cyan-500 hover:shadow-cyan-500/20 hover:scale-105 active:scale-95 transition-all backdrop-blur-md"
        >
          <span className="relative flex h-11 w-11 shrink-0 overflow-hidden rounded-full ring-2 ring-cyan-400/80 bg-[#0b1329]">
            <img
              src="/ark-mascot.jpg"
              alt="Ark Mascot"
              className="h-full w-full object-cover group-hover:scale-110 transition-transform duration-300"
            />
            <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-slate-900 animate-pulse" />
          </span>
          <div className="text-left pr-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
              <span>Ark Copiloto</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-mono text-emerald-300">
                IA Activa
              </span>
            </div>
            <div className="text-[11px] text-slate-400 truncate max-w-[170px]">
              {activeCaseName
                ? `Caso: ${activeCaseName.slice(0, 18)}`
                : humanCount > 0
                  ? `${humanCount} caso(s) en espera`
                  : 'Toca para hablar con Ark'}
            </div>
          </div>
        </button>
      ) : (
        <div className="flex flex-col w-[380px] sm:w-[420px] h-[580px] max-h-[85vh] rounded-2xl bg-white border border-slate-300 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          {/* Header 3D Spline Interactivo con Mascota Ark */}
          <div className="relative h-44 w-full bg-gradient-to-b from-[#0b1329] via-[#0f172a] to-[#0b1329] overflow-hidden select-none border-b border-slate-800">
            {/* Controles superiores */}
            <div className="absolute top-2.5 left-3 right-3 z-20 flex items-center justify-between pointer-events-auto">
              <div className="flex items-center gap-1.5 rounded-full bg-slate-900/80 backdrop-blur-sm border border-slate-700/60 px-2.5 py-1 text-[11px] font-mono text-cyan-300">
                <Sparkles className="h-3 w-3 text-cyan-400" />
                <span>Ark 3D Live</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full bg-slate-900/80 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700/60 transition-colors"
                title="Cerrar Copiloto"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Lienzo Spline 3D interactivo con fallback elegante */}
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              {!splineError ? (
                <Suspense
                  fallback={
                    <div className="flex flex-col items-center justify-center gap-2 text-cyan-400/80">
                      <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
                      <span className="text-[11px] font-mono text-cyan-300/80">
                        Cargando Ark 3D…
                      </span>
                    </div>
                  }
                >
                  <Spline
                    scene={SPLINE_SCENE_URL}
                    onError={() => setSplineError(true)}
                    className="w-full h-full"
                  />
                </Suspense>
              ) : (
                <img
                  src="/ark-mascot.jpg"
                  alt="Ark Mascot Fallback"
                  className="h-36 w-36 object-contain drop-shadow-[0_0_15px_rgba(0,240,255,0.3)]"
                />
              )}
            </div>

            {/* Llamado a la acción por voz superpuesto */}
            <div
              onClick={toggleListening}
              className="absolute bottom-2 inset-x-0 z-20 flex justify-center cursor-pointer pointer-events-auto"
            >
              <div
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium border shadow-lg transition-all ${
                  isListening
                    ? 'bg-rose-500/90 text-white border-rose-400 animate-pulse'
                    : 'bg-slate-900/85 text-cyan-300 border-cyan-500/40 hover:bg-slate-800 hover:border-cyan-400'
                }`}
              >
                {isListening ? (
                  <>
                    <MicOff className="h-3 w-3" />
                    <span>Escuchando… ¡Háblale a Ark!</span>
                  </>
                ) : (
                  <>
                    <Mic className="h-3 w-3 text-cyan-400" />
                    <span>Toca a Ark y háblale</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Subheader de Estado y Contexto de Caso */}
          <div className="bg-slate-50 px-4 py-2 text-xs border-b border-slate-200 flex items-center justify-between">
            <span className="text-[11px] text-slate-600 font-mono truncate max-w-[240px]">
              {activeCaseName ? `Caso activo: ${activeCaseName}` : 'Cobranza General · 12 Reglas'}
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono text-emerald-700 border border-emerald-500/20">
              <ShieldCheck className="h-3 w-3 text-emerald-600" /> Worker Live
            </span>
          </div>

          {/* Chips de consulta rápida */}
          <div className="bg-slate-50/70 px-3 py-1.5 border-b border-slate-200 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
            <HelpCircle className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            {QUICK_PROMPTS.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={sending}
                onClick={() => void sendMessage(item.prompt)}
                className="shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:border-cyan-500 hover:text-cyan-800 transition-colors disabled:opacity-50"
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Historial de conversación */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/40">
            {turns.map((turn) => (
              <div
                key={turn.id}
                className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                    turn.role === 'user'
                      ? 'bg-slate-900 text-white rounded-br-sm'
                      : 'bg-white border border-slate-200 text-slate-800 shadow-sm rounded-bl-sm'
                  }`}
                >
                  {turn.content}
                </div>

                {turn.suggestedDraft ? (
                  <div className="mt-2 max-w-[90%] rounded-xl border border-emerald-300 bg-emerald-50/90 p-3 text-xs text-emerald-950 shadow-sm">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="font-semibold text-[11px] uppercase tracking-wider text-emerald-800 flex items-center gap-1">
                        <MessageSquarePlus className="h-3.5 w-3.5" /> Borrador Blindado CONDUSEF
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyDraft(turn.id, turn.suggestedDraft!)}
                        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
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
                    <p className="font-mono text-[11px] text-emerald-900 bg-white/95 rounded-lg p-2 border border-emerald-200">
                      {turn.suggestedDraft}
                    </p>
                  </div>
                ) : null}
              </div>
            ))}

            {sending ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-white border border-slate-200 rounded-full px-3.5 py-1.5 w-fit shadow-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-600" />
                <span>Ark está redactando y validando con el Motor Legal…</span>
              </div>
            ) : null}
          </div>

          {/* Input Omnicanal: Texto + Micrófono + Enviar */}
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
                isListening
                  ? '🎙️ Escuchando tu voz… habla ahora'
                  : activeCaseName
                    ? `Pregunta sobre ${activeCaseName.split(' ')[0]} o dicta…`
                    : 'Pregunta qué hacer, reglas legales o casos de hoy…'
              }
              className={`flex-1 rounded-full border px-4 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none transition-colors ${
                isListening
                  ? 'border-rose-400 bg-rose-50/50 ring-2 ring-rose-400/30'
                  : 'border-slate-300 focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-600'
              }`}
            />
            <button
              type="button"
              onClick={toggleListening}
              className={`p-2 rounded-full border transition-all ${
                isListening
                  ? 'bg-rose-500 border-rose-600 text-white shadow-md animate-pulse'
                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:text-cyan-600 hover:border-cyan-300'
              }`}
              title={isListening ? 'Detener dictado' : 'Hablar con Ark (Micrófono)'}
            >
              {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="inline-flex items-center justify-center rounded-full bg-slate-900 hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50 transition-colors shadow-sm"
              title="Enviar mensaje"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
