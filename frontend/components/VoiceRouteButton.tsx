"use client";

import { useRef, useState } from "react";
import { useVoiceGuidance } from "@/components/VoiceGuidance";
import { armCurrentLocation } from "@/lib/here";
import {
  VOICE_NOTICES,
  transcribeRoute,
  type RouteTranscript,
} from "@/lib/voice";

const LISTEN_MS = 8000;

type VoiceRouteButtonProps = {
  disabled?: boolean;
  onRequest: (request: RouteTranscript) => Promise<void>;
};

/** Tap the mic to speak a start and destination. A second tap, or eight seconds, sends it. */
export default function VoiceRouteButton({
  disabled = false,
  onRequest,
}: VoiceRouteButtonProps) {
  const voice = useVoiceGuidance();
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef(0);

  async function finish(recorder: MediaRecorder, chunks: Blob[]) {
    window.clearTimeout(stopTimerRef.current);
    setListening(false);
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    recorder.stream.getTracks().forEach((track) => track.stop());
    if (blob.size < 100) {
      voice.speak(VOICE_NOTICES.help);
      return;
    }
    setWorking(true);
    try {
      const request = await transcribeRoute(blob);
      if (!request.destination_query) {
        voice.speak(request.alert);
        return;
      }
      await onRequest(request);
    } catch (err) {
      voice.speak(VOICE_NOTICES.notHeard);
      voice.report(err instanceof Error ? err.message : "Could not hear a route.");
    } finally {
      setWorking(false);
    }
  }

  async function start() {
    voice.prime();
    armCurrentLocation();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      voice.speak(VOICE_NOTICES.noMic);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : undefined;
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      void finish(recorder, chunks);
    };
    recorderRef.current = recorder;
    recorder.start();
    setListening(true);
    stopTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, LISTEN_MS);
  }

  function onClick() {
    if (disabled || working) return;
    const active = recorderRef.current;
    if (active && active.state === "recording") {
      active.stop();
      return;
    }
    void start().catch(() => {
      voice.speak(VOICE_NOTICES.micBlocked);
    });
  }

  const busy = working || disabled;
  const label = listening
    ? "Listening… tap to stop"
    : busy
      ? "Finding your route…"
      : "Say your route";

  return (
    <div className="pointer-events-auto flex items-center gap-2.5">
      <span
        aria-hidden
        className={`rounded-full px-3.5 py-2 text-[14px] font-semibold shadow-[0_8px_30px_rgba(11,27,51,0.14)] backdrop-blur ${
          listening ? "bg-[#9A3412] text-white" : "bg-white/95 text-[#0B1B33]"
        }`}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-pressed={listening}
        aria-label={listening ? "Stop listening and find route" : "Say your route"}
        className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-white shadow-[0_10px_28px_rgba(166,83,83,0.45)] transition-transform active:scale-95 disabled:opacity-70 ${
          listening ? "bg-[#9A3412]" : "bg-[#A65353]"
        }`}
      >
        {listening && (
          <span
            aria-hidden
            className="absolute inset-0 animate-ping rounded-full bg-[#9A3412]/45 motion-reduce:animate-none"
          />
        )}
        {busy && !listening ? (
          <span
            aria-hidden
            className="h-6 w-6 animate-spin rounded-full border-[3px] border-white border-t-transparent"
          />
        ) : (
          <MicIcon />
        )}
      </button>
    </div>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="relative h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </svg>
  );
}
