import {
  type Command,
  type EngineInit,
  FleshEngine,
  type ParamSet,
  type StepInput,
} from "./engine";

/**
 * The flesh, off the main thread. One engine per worker; every frame the
 * app sends the elapsed time and the gestures since last time along with
 * two buffers to fill, and gets them back with the deformed mesh.
 */
type Message =
  | { type: "init"; init: EngineInit; params: ParamSet }
  | { type: "params"; params: ParamSet }
  | {
      type: "step";
      input: StepInput;
      commands: Command[];
      pos: Float32Array;
      normal: Float32Array;
    };

/** the worker scope, typed just enough — tsconfig only knows the DOM lib */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let engine: FleshEngine | null = null;

scope.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "init") {
    engine = new FleshEngine(message.init);
    engine.setParams(message.params);
    scope.postMessage({ type: "ready" });
    return;
  }
  if (!engine) return;
  if (message.type === "params") {
    engine.setParams(message.params);
    return;
  }
  for (const command of message.commands) engine.apply(command);
  const out = engine.step(message.input, message.pos, message.normal);
  scope.postMessage(
    { type: "frame", out, pos: message.pos, normal: message.normal },
    [message.pos.buffer as ArrayBuffer, message.normal.buffer as ArrayBuffer],
  );
};
