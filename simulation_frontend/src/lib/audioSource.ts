"use client";

import { useEffect, useState } from "react";

import type { TrainAudioSource } from "@/types/simulation";

/** Load the shared train recording for client-side virtual microphone sampling. */
export function useTrainAudioSource() {
  const [source, setSource] = useState<TrainAudioSource>({
    samples: new Float32Array(),
    sampleRateHz: 16_000,
    durationSeconds: 0,
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined" || !window.AudioContext) {
      queueMicrotask(() => {
        if (!cancelled) {
          setSource((current) => ({ ...current, status: "fallback" }));
        }
      });
      return;
    }
    const audioContext = new window.AudioContext();

    fetch("/api/train-audio")
      .then((response) => {
        if (!response.ok) throw new Error("train audio unavailable");
        return response.arrayBuffer();
      })
      .then((data) => audioContext.decodeAudioData(data))
      .then((buffer) => {
        if (cancelled) return;
        setSource({
          samples: buffer.getChannelData(0),
          sampleRateHz: buffer.sampleRate,
          durationSeconds: buffer.duration,
          status: "ready",
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSource((current) => ({ ...current, status: "fallback" }));
        }
      })
      .finally(() => {
        void audioContext.close();
      });

    return () => {
      cancelled = true;
      void audioContext.close();
    };
  }, []);

  return source;
}
