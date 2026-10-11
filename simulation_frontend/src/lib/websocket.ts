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

interface Callbacks {
  onState: (state: TrainState) => void;
  onConnection: (state: "connected" | "reconnecting" | "offline") => void;
  onError: (message: string) => void;
}

export class SimulationSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private callbacks: Callbacks) {}

  connect() {
    this.stopped = false;
    const wsUrl = getSimulationWsUrl();
    this.socket = new WebSocket(wsUrl);
    this.socket.onopen = () => {
      this.attempt = 0;
      this.callbacks.onConnection("connected");
    };
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as TrainState | { type: string; message?: string };
      if (message.type === "train_state") this.callbacks.onState(message as TrainState);
      if (message.type === "command_error") this.callbacks.onError(message.message ?? "Command rejected");
    };
    this.socket.onerror = () => this.callbacks.onError(`Live train connection to ${getSimulationWsUrl()} was interrupted.`);
    this.socket.onclose = () => {
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

  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.callbacks.onConnection("offline");
  }
}
