/** Playback for backend-owned alert audio. Routing never waits on this. */

export const VOICE_UNLOCK_ALERT_ID = "voice-unlock";

/** Fixed prompts the user backend registers at startup, with matching captions. */
export const VOICE_NOTICES = {
  help: {
    id: "voice-help",
    text: "Tell me where you're going. For example, from Main Street to the hospital.",
  },
  noMic: {
    id: "voice-no-mic",
    text: "This browser can't use the microphone. You can type your route instead.",
  },
  micBlocked: {
    id: "voice-mic-blocked",
    text: "I need microphone access to hear your route.",
  },
  notHeard: {
    id: "voice-not-heard",
    text: "Sorry, I didn't catch that. Please try again.",
  },
  routeFailed: {
    id: "voice-route-failed",
    text: "Sorry, I couldn't find a driving route.",
  },
} as const satisfies Record<string, SpokenAlert>;

export type SpokenAlert = {
  id: string;
  text: string;
};

export type RouteUpdate = {
  type: "route_update";
  simulation_id?: string;
  sequence?: number;
  label?: string;
  alert?: SpokenAlert | null;
};

export function userApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_USER_API_URL ?? "http://localhost:8002";
  return configured.replace(/\/$/, "");
}

export function userWsUrl(): string {
  return process.env.NEXT_PUBLIC_USER_WS_URL ?? "ws://localhost:8002/ws/updates";
}

export function speechUrl(alertId: string): string {
  return `${userApiBase()}/api/speech/${encodeURIComponent(alertId)}`;
}

export function readRouteUpdate(data: string): SpokenAlert | null {
  try {
    const message = JSON.parse(data) as RouteUpdate;
    if (message?.type !== "route_update" || !message.alert?.id || !message.alert?.text) {
      return null;
    }
    return { id: message.alert.id, text: message.alert.text };
  } catch {
    return null;
  }
}

type QueuedClip = { id: string; url: string };

/**
 * One audio element. The unlock call must happen inside the tap handler so
 * iPhone Safari allows later alert playback on the same element.
 */
export function createVoicePlayer(onError: (message: string) => void) {
  const audio = new Audio();
  let unlocked = false;
  let activeToken = 0;
  let current: QueuedClip | null = null;
  let queued: QueuedClip | null = null;
  const handled = new Set<string>();

  function fail(url: string, token: number) {
    if (token !== activeToken) return;
    activeToken += 1;
    const failed = current;
    if (current) handled.delete(current.id);
    if (queued) handled.delete(queued.id);
    current = null;
    queued = null;
    if (failed?.id === "silence") return;
    void explain(url).then(onError);
  }

  audio.addEventListener("ended", () => {
    const token = activeToken;
    const next = queued;
    current = null;
    queued = null;
    if (next && token === activeToken) start(next);
  });

  audio.addEventListener("error", () => {
    if (!current) return;
    fail(current.url, activeToken);
  });

  function start(clip: QueuedClip) {
    const token = ++activeToken;
    current = clip;
    audio.src = clip.url;
    void audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      fail(clip.url, token);
    });
  }

  function play(id: string, url: string) {
    if (!unlocked) return;
    handled.add(id);
    const clip = { id, url };
    if (current) {
      queued = clip;
      return;
    }
    start(clip);
  }

  return {
    unlock(url: string) {
      unlocked = true;
      handled.add(VOICE_UNLOCK_ALERT_ID);
      queued = null;
      start({ id: VOICE_UNLOCK_ALERT_ID, url });
    },
    consider(id: string, url: string) {
      if (handled.has(id)) return;
      play(id, url);
    },
    /** User-requested speech: plays even if this id was heard before. */
    play,
    /** Call inside a tap so later route audio is allowed, without speaking over the mic. */
    prime() {
      unlocked = true;
      queued = null;
      start({ id: "silence", url: SILENT_WAV });
    },
    stop() {
      activeToken += 1;
      current = null;
      queued = null;
      audio.pause();
    },
  };
}

/** Short silent clip used only to satisfy the browser audio gesture. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

export type RouteTranscript = {
  transcript: string;
  origin_query: string | null;
  destination_query: string | null;
  use_current_location: boolean;
  alert: SpokenAlert;
};

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof body?.detail === "string" ? body.detail : "Voice request failed.";
}

export async function transcribeRoute(audio: Blob): Promise<RouteTranscript> {
  const type = audio.type || "audio/webm";
  const extension = type.includes("mp4") || type.includes("m4a") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", audio, `route.${extension}`);
  const response = await fetch(`${userApiBase()}/api/voice/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as RouteTranscript;
}

export async function registerRouteSpeech(input: {
  origin_name: string;
  destination_name: string;
  duration_seconds: number;
  distance_meters: number;
  first_instruction?: string;
}): Promise<SpokenAlert> {
  return postForAlert("/api/voice/route", input);
}

/** The backend composes the spoken turn; ElevenLabs reads it by alert id. */
export async function registerStepSpeech(input: {
  instruction: string;
  distance_meters: number;
  next_instruction?: string;
}): Promise<SpokenAlert> {
  return postForAlert("/api/voice/step", input);
}

export async function registerNotFoundSpeech(query: string): Promise<SpokenAlert> {
  return postForAlert("/api/voice/not-found", { query });
}

async function postForAlert(path: string, input: object): Promise<SpokenAlert> {
  const response = await fetch(`${userApiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { alert: SpokenAlert };
  return body.alert;
}

async function explain(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
      if (typeof body?.detail === "string") return body.detail;
      return "Could not play voice guidance.";
    }
  } catch {
    return "Cannot reach the voice service.";
  }
  return "Could not play voice guidance.";
}
