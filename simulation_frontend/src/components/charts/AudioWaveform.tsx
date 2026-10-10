"use client";

import type { SensorReading } from "@/types/simulation";

export function AudioWaveform({ reading }: { reading: SensorReading }) {
  const points = reading.waveform
    .map((value, index) => {
      const x = (index / (reading.waveform.length - 1)) * 240;
      const y = 44 - value * 34;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-500">
        <span>Live waveform</span>
        <span className="text-slate-300">{reading.frequency} Hz</span>
      </div>
      <svg
        viewBox="0 0 240 52"
        className="h-20 w-full overflow-visible"
        role="img"
        aria-label="Simulated audio waveform"
      >
        <line
          x1="0"
          y1="44"
          x2="240"
          y2="44"
          stroke="rgba(148,163,184,0.18)"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#73e0ff"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      </svg>
    </div>
  );
}
