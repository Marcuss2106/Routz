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
  alertRef.current = alert;

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
    player().consider(next.id, speechUrl(next.id));
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

export function VoiceButton() {
  const { enabled, toggle } = useVoiceGuidance();
  return (
    <button
      type="button"
      aria-pressed={enabled}
      onClick={toggle}
      className={`min-h-9 rounded-full px-3 py-1 text-[12px] font-semibold ${
        enabled
          ? "bg-[#007AFF] text-white"
          : "bg-[#F2F4F8] text-[#0B1B33]/70"
      }`}
    >
      {enabled ? "Voice on" : "Voice"}
    </button>
  );
}

export function VoiceAlert() {
  const { alert, voiceError, streamLost, enabled } = useVoiceGuidance();
  return (
    <div className="pointer-events-none flex flex-col gap-2">
      <p className="text-center text-[11px] font-bold tracking-[0.14em] text-[#9A3412]">
        SIMULATION / NOT FOR EMERGENCY USE
      </p>
      {voiceError && (
        <div
          role="status"
          className="pointer-events-auto rounded-2xl border border-[#9A3412]/20 bg-[#FFF7ED] px-3.5 py-2.5 text-[13px] font-medium leading-5 text-[#9A3412] shadow-lg"
        >
          {voiceError}
        </div>
      )}
      {enabled && streamLost && (
        <p className="text-center text-[12px] font-medium text-[#0B1B33]/55">
          Alert stream disconnected. Routes still work.
        </p>
      )}
      {alert && (
        <div className="pointer-events-auto rounded-2xl bg-white/95 px-3.5 py-3 shadow-[0_8px_30px_rgba(11,27,51,0.12)] backdrop-blur">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#9A3412]">
            Simulated estimate
          </p>
          <p className="mt-1 text-[14px] font-medium leading-5 text-[#0B1B33]">
            {alert.text}
          </p>
        </div>
      )}
    </div>
  );
}
