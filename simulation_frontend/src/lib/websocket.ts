import type { RailroadPayload, SimulationCommand, TrainState } from "@/types/simulation";

export function getSimulationApiUrl(): string {
  return process.env.NEXT_PUBLIC_SIMULATION_API_URL ?? "http://localhost:8000";
}

export function getSimulationWsUrl(): string {
  return process.env.NEXT_PUBLIC_SIMULATION_WS_URL ?? "ws://localhost:8000/ws/simulation";
}

/** Detect the classic production pitfall: an https:// page with http/ws backend URLs. */
export function getMixedContentHint(): string | null {
  if (typeof window === "undefined" || window.location.protocol !== "https:") return null;
  const insecure = [getSimulationApiUrl(), getSimulationWsUrl()].some((url) =>
    /^(http|ws):\/\//i.test(url.trim()),
  );
  if (!insecure) return null;
  return "This page is on HTTPS but the backend URL is http/ws, which browsers block. Use the https/wss DuckDNS URLs and redeploy.";
}

export async function loadRailroad(signal?: AbortSignal): Promise<RailroadPayload> {
  const apiUrl = getSimulationApiUrl();
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/railroad`, { signal, cache: "no-store" });
  } catch {
    throw new Error(`Cannot reach the rail backend at ${apiUrl} (is it running, and is this origin allowed?).`);
  }
  if (!response.ok) throw new Error(`Rail data request to ${apiUrl} failed (${response.status})`);
  return response.json() as Promise<RailroadPayload>;
}

/** REST snapshot for the polling fallback (same `train_state` the socket streams). */
export async function loadTrainSnapshot(signal?: AbortSignal): Promise<TrainState | null> {
  const apiUrl = getSimulationApiUrl();
  const response = await fetch(`${apiUrl}/api/train`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Train snapshot request to ${apiUrl} failed (${response.status})`);
  const data = (await response.json()) as TrainState | { type?: unknown };
  if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== "train_state") return null;
  return data as TrainState;
}

/** REST command fallback used when the live socket is not open. */
export async function postSimulationCommand(command: SimulationCommand): Promise<TrainState> {
  const apiUrl = getSimulationApiUrl();
  const response = await fetch(`${apiUrl}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Command rejected (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return response.json() as Promise<TrainState>;
}

interface Callbacks {
  onState: (state: TrainState) => void;
  onConnection: (state: "connected" | "reconnecting" | "offline") => void;
  onError: (message: string) => void;
}

/** Last close/timeout detail for the rail socket, shown in the waiting note. */
let connectionDetail: string | null = null;

export function getSimulationConnectionDetail(): string | null {
  return connectionDetail;
}

function describeClose(code: number, reason: string, wasClean: boolean): string {
  const known: Record<number, string> = {
    1000: "normal closure",
    1001: "endpoint going away",
    1006: "abnormal closure (network reset, blocker, or TLS failure — server never closed cleanly)",
    1008: "policy violation (server rejected the connection, e.g. origin not allowed)",
    1011: "server error",
    1015: "TLS handshake failure",
  };
  const label = known[code] ?? (wasClean ? "clean closure" : "unclean closure");
  return `close ${code} (${label})${reason ? `: ${reason}` : ""}`;
}

export class SimulationSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private callbacks: Callbacks) {}

  connect() {
    this.stopped = false;
    const wsUrl = getSimulationWsUrl();
    connectionDetail = null;
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (cause) {
      connectionDetail = `could not open ${wsUrl}: ${cause instanceof Error ? cause.message : String(cause)}`;
      this.callbacks.onError(`Live train connection to ${wsUrl} failed. ${connectionDetail}`);
      this.callbacks.onConnection("reconnecting");
      return;
    }
    this.socket = socket;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.CONNECTING) {
        connectionDetail = `handshake to ${wsUrl} timed out after 12 s (no open, no close) — likely a content blocker, proxy, or stalled TLS. The server answers 101 from the public internet.`;
        this.callbacks.onError(`Live train connection to ${wsUrl} timed out. ${connectionDetail}`);
        try {
          this.socket?.close();
        } catch {
          // Ignored: the socket never finished connecting.
        }
      }
    }, 12000);
    this.socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.attempt = 0;
      connectionDetail = null;
      this.callbacks.onConnection("connected");
    };
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as TrainState | { type: string; message?: string };
      if (message.type === "train_state") this.callbacks.onState(message as TrainState);
      if (message.type === "command_error") this.callbacks.onError(message.message ?? "Command rejected");
    };
    this.socket.onerror = () => this.callbacks.onError(`Live train connection to ${getSimulationWsUrl()} was interrupted.`);
    this.socket.onclose = (event) => {
      if (this.openTimer) clearTimeout(this.openTimer);
      connectionDetail = describeClose(event.code, event.reason, event.wasClean);
      this.callbacks.onError(`Live train connection to ${getSimulationWsUrl()} closed. ${connectionDetail}`);
      if (this.stopped) return;
      this.callbacks.onConnection("reconnecting");
      const delay = Math.min(1000 * 2 ** this.attempt, 10000);
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(command: SimulationCommand) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.callbacks.onError("The simulator is reconnecting. Try again in a moment.");
      return;
    }
    this.socket.send(JSON.stringify(command));
  }

  /** Drive the sim over the socket when open, else over REST (`POST /api/command`). */
  async sendWithFallback(command: SimulationCommand) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(command);
      return;
    }
    try {
      this.callbacks.onState(await postSimulationCommand(command));
    } catch (cause) {
      this.callbacks.onError(cause instanceof Error ? cause.message : "Command failed.");
    }
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.openTimer) clearTimeout(this.openTimer);
    this.socket?.close();
    this.callbacks.onConnection("offline");
  }
}
