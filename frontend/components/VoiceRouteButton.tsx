"use client";

import { useRef, useState } from "react";
import { useVoiceGuidance } from "@/components/VoiceGuidance";
import { armCurrentLocation } from "@/lib/here";
import {
  transcribeRoute,
  type RouteTranscript,
} from "@/lib/voice";

const LISTEN_MS = 8000;

type VoiceRouteButtonProps = {
  disabled?: boolean;
  onRequest: (request: RouteTranscript) => Promise<void>;
};

/** Tap to speak a start and destination. A second tap, or eight seconds, sends it. */
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
      voice.report(
        "Simulation. Say a start and a destination. For example, from Main Street to the hospital."
      );
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
      voice.report(err instanceof Error ? err.message : "Could not hear a route.");
    } finally {
      setWorking(false);
    }
  }

  async function start() {
    voice.prime();
    armCurrentLocation();
    if (!navigator.mediaDevices?.getUserMedia) {
      voice.speak({
        id: "route-no-mic",
        text: "Simulation. This browser cannot use the microphone.",
      });
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
      voice.report("Allow the microphone to say a route.");
    });
  }

  const label = listening ? "Listening" : working ? "Hearing" : "Say route";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || working}
      aria-pressed={listening}
      className={`min-h-9 rounded-full px-3 py-1 text-[12px] font-semibold ${
        listening
          ? "bg-[#9A3412] text-white"
          : "bg-[#EAF2FF] text-[#007AFF]"
      } disabled:opacity-60`}
    >
      {label}
    </button>
  );
}
