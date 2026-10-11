"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  VOICE_UNLOCK_ALERT_ID,
  createVoicePlayer,
  readRouteUpdate,
  speechUrl,
  userWsUrl,
  type SpokenAlert,
} from "@/lib/voice";

type VoiceContextValue = {
  enabled: boolean;
  alert: SpokenAlert | null;
  voiceError: string | null;
  streamLost: boolean;
  toggle: () => void;
  /** Unlocks audio inside the current tap, without speaking over the microphone. */
  prime: () => void;
  speak: (alert: SpokenAlert) => void;
  report: (message: string) => void;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoiceGuidance(): VoiceContextValue {
  const value = useContext(VoiceContext);
  if (!value) {
    throw new Error("Voice controls must render inside VoiceProvider");
  }
  return value;
}

/** Listens for simulated alerts and plays them only after the voice tap. */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [alert, setAlert] = useState<SpokenAlert | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [playbackReady, setPlaybackReady] = useState(false);
  const [streamLost, setStreamLost] = useState(false);
  const playerRef = useRef<ReturnType<typeof createVoicePlayer> | null>(null);
  const alertRef = useRef<SpokenAlert | null>(null);
  useEffect(() => {
    alertRef.current = alert;
  }, [alert]);

  function player() {
    if (!playerRef.current) {
      playerRef.current = createVoicePlayer((message) => setVoiceError(message));
    }
    return playerRef.current;
  }

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer = 0;
    let opened = false;

    const connect = () => {
      socket = new WebSocket(userWsUrl());
      socket.onopen = () => {
        opened = true;
        if (!stopped) setStreamLost(false);
      };
      socket.onmessage = (event) => {
        const next = readRouteUpdate(String(event.data));
        if (next) setAlert(next);
      };
      socket.onclose = () => {
        if (stopped) return;
        if (opened) setStreamLost(true);
        timer = window.setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!playbackReady || !alert) return;
    player().consider(alert.id, speechUrl(alert.id));
  }, [playbackReady, alert]);

  const prime = () => {
    setEnabled(true);
    setPlaybackReady(true);
    player().prime();
  };

  const speak = (next: SpokenAlert) => {
    setVoiceError(null);
    setAlert(next);
    player().play(next.id, speechUrl(next.id));
  };

  const report = (message: string) => {
    setVoiceError(message);
  };

  const toggle = () => {
    if (enabled) {
      setEnabled(false);
      setPlaybackReady(false);
      player().stop();
      return;
    }
    setVoiceError(null);
    setEnabled(true);
    setPlaybackReady(true);
    player().unlock(speechUrl(VOICE_UNLOCK_ALERT_ID));
    const current = alertRef.current;
    if (current) {
      player().consider(current.id, speechUrl(current.id));
    }
  };

  return (
    <VoiceContext.Provider
      value={{ enabled, alert, voiceError, streamLost, toggle, prime, speak, report }}
    >
      {children}
    </VoiceContext.Provider>
  );
}

/** Speaker toggle for spoken alerts. */
export function VoiceButton() {
  const { enabled, toggle } = useVoiceGuidance();
  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label={enabled ? "Turn voice alerts off" : "Turn voice alerts on"}
      onClick={toggle}
      className={`flex h-11 items-center gap-1.5 rounded-full pl-3 pr-3.5 text-[14px] font-semibold shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur transition-colors ${
        enabled
          ? "bg-[#A65353] text-white active:bg-[#934747]"
          : "bg-white/95 text-[#0B1B33]/75 active:bg-[#F2F4F8]"
      }`}
    >
      <SpeakerIcon muted={!enabled} />
      {enabled ? "Voice on" : "Voice off"}
    </button>
  );
}

export function SpeakerIcon({ muted, className = "h-5 w-5" }: { muted: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden>
      <path d="M4 10v4h3l4 3V7L7 10H4Z" strokeLinejoin="round" />
      {muted ? (
        <path d="M16 10l4 4m0-4-4 4" strokeLinecap="round" />
      ) : (
        <path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a6.5 6.5 0 0 1 0 10" strokeLinecap="round" />
      )}
    </svg>
  );
}

const CAPTION_MS = 12_000;

export function VoiceAlert() {
  const { alert, voiceError, streamLost, enabled } = useVoiceGuidance();
  const [hiddenId, setHiddenId] = useState<string | null>(null);

  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => setHiddenId(alert.id), CAPTION_MS);
    return () => window.clearTimeout(timer);
  }, [alert]);

  const showCaption = Boolean(alert && alert.id !== hiddenId);
  if (!voiceError && !(enabled && streamLost) && !showCaption) return null;
  return (
    <div className="pointer-events-none flex flex-col gap-2">
      {voiceError && (
        <div
          role="status"
          className="pointer-events-auto rounded-2xl border border-[#9A3412]/20 bg-[#FFF7ED] px-3.5 py-2.5 text-[14px] font-medium leading-5 text-[#9A3412] shadow-lg"
        >
          {voiceError}
        </div>
      )}
      {enabled && streamLost && (
        <p className="self-center rounded-full bg-white/90 px-3 py-1 text-[12px] font-medium text-[#0B1B33]/60 shadow">
          Alert stream disconnected. Routes still work.
        </p>
      )}
      {alert && showCaption && (
        <div
          role="status"
          className="sheet-swap pointer-events-auto flex items-start gap-2.5 rounded-2xl bg-white/95 py-3 pl-3.5 pr-2 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur"
        >
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#A65353]/10 text-[#A65353]">
            <SpeakerIcon muted={!enabled} className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7A5C00]">
              Simulated
            </p>
            <p className="mt-0.5 text-[15px] font-medium leading-5 text-[#0B1B33]">
              {alert.text}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setHiddenId(alert.id)}
            aria-label="Dismiss message"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#0B1B33]/40 active:bg-black/5"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
