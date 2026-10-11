"use client";

const PREFERRED_VOICE = /samantha|ava|karen|google us english|microsoft.*(jenny|aria|zira)/i;

function chooseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return (
    voices.find((voice) => PREFERRED_VOICE.test(voice.name) && voice.lang.startsWith("en")) ??
    voices.find((voice) => voice.lang === "en-US") ??
    voices.find((voice) => voice.lang.startsWith("en"))
  );
}

export type PleasantVoice = {
  available: boolean;
  speak: (text: string) => void;
  stop: () => void;
  dispose: () => void;
};

/**
 * A local, opt-in narrator for the 3D simulation's status changes.
 *
 * It deliberately uses the browser speech engine rather than the microphone
 * or acoustic WebSocket. Narration is presentation-only and never reaches the
 * inference backend as audio or train state.
 */
export function createPleasantVoice(): PleasantVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;

  const synthesis = window.speechSynthesis;
  let voices = synthesis.getVoices();
  const refreshVoices = () => {
    voices = synthesis.getVoices();
  };
  synthesis.addEventListener("voiceschanged", refreshVoices);

  return {
    available: true,
    speak(text) {
      if (!text.trim()) return;
      synthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = chooseVoice(voices) ?? null;
      utterance.lang = "en-US";
      utterance.rate = 0.93;
      utterance.pitch = 1.04;
      utterance.volume = 0.76;
      synthesis.speak(utterance);
    },
    stop() {
      synthesis.cancel();
    },
    dispose() {
      synthesis.removeEventListener("voiceschanged", refreshVoices);
      synthesis.cancel();
    },
  };
}
