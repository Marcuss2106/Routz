/** Playback for backend-owned alert audio. Routing never waits on this. */

export const VOICE_UNLOCK_ALERT_ID = "voice-unlock";

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
  const configured = process.env.NEXT_PUBLIC_USER_API_URL ?? "http://localhost:8001";
  return configured.replace(/\/$/, "");
}

export function userWsUrl(): string {
  return process.env.NEXT_PUBLIC_USER_WS_URL ?? "ws://localhost:8001/ws/updates";
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

  return {
    unlock(url: string) {
      unlocked = true;
      handled.add(VOICE_UNLOCK_ALERT_ID);
      queued = null;
      start({ id: VOICE_UNLOCK_ALERT_ID, url });
    },
    consider(id: string, url: string) {
      if (!unlocked || handled.has(id)) return;
      handled.add(id);
      const clip = { id, url };
      if (current) {
        queued = clip;
        return;
      }
      start(clip);
    },
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
}): Promise<SpokenAlert> {
  const response = await fetch(`${userApiBase()}/api/voice/route`, {
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
