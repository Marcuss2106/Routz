import type { RailroadPayload, SimulationCommand, TrainState } from "@/types/simulation";

const apiUrl = process.env.NEXT_PUBLIC_SIMULATION_API_URL ?? "http://localhost:8000";
const wsUrl = process.env.NEXT_PUBLIC_SIMULATION_WS_URL ?? "ws://localhost:8000/ws/simulation";

export async function loadRailroad(signal?: AbortSignal): Promise<RailroadPayload> {
  const response = await fetch(`${apiUrl}/api/railroad`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Rail data request failed (${response.status})`);
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
    this.socket = new WebSocket(wsUrl);
    this.socket.onopen = () => { this.attempt = 0; this.callbacks.onConnection("connected"); };
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as TrainState | { type: string; message?: string };
      if (message.type === "train_state") this.callbacks.onState(message as TrainState);
      if (message.type === "command_error") this.callbacks.onError(message.message ?? "Command rejected");
    };
    this.socket.onerror = () => this.callbacks.onError("Live train connection was interrupted.");
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
