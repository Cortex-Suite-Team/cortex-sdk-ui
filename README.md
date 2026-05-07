# Cortex SDK UI

`@cortex-suite/sdk-ui` is the headless Cortex chat behavior layer.

It owns chat and escalation state management, but it does not render DOM, CSS, widgets, or framework components.

## Boundaries

This package includes:

- transcript state
- message normalization
- `chat::partial` aggregation
- connection and input-lock display state
- escalation helpers for `continue`, `operator_input`, and `reply_user`

This package does not include:

- DOM rendering
- CSS
- React, Vue, Svelte, or Bootstrap components
- floating launchers or embeddable widget UI
- Control Plane permission or audit logic

## Install

```bash
npm install @cortex-suite/sdk-ui
```

## Use With `@cortex-suite/sdk`

`sdk-ui` is runtime-agnostic. It works with any client object matching `CortexClientLike`.

```ts
import { CortexClient } from "@cortex-suite/sdk";
import { createChatController } from "@cortex-suite/sdk-ui";

const client = new CortexClient({
  apiKey: "your-api-key",
  onMessage: () => {},
});

const chat = createChatController({
  client,
  onStateChange: (state) => {
    renderTranscript(state.transcript);
    renderConnection(state.connection);
    renderComposerLock(state.input);
  },
});

await chat.connect();
await chat.sendMessage({ content: "Hello" });
```

## Use With A Mock Or Custom Client

```ts
import { createChatController } from "@cortex-suite/sdk-ui";

const listeners = new Set();

const client = {
  sessionState: "ACTIVE",
  channelState: "OPEN",
  async connect() {},
  async sendMessage(options) {
    void options;
  },
  onMessage(handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
};

const chat = createChatController({ client });
```

## Render Your Own UI

`ChatState` is the rendering contract. A widget, app shell, or internal tool can subscribe and render however it wants.

```ts
const unsubscribe = chat.subscribe((state) => {
  console.log(state.transcript);
});
```

## Control Plane Reuse

Control Plane can reuse transcript and escalation behavior while keeping operator permissions server-side.

If the browser must not receive the runtime `wait_token`, provide a custom `replyRequestBuilder`. That lets the controller keep its normal helper API while your Control Plane adapter sends a server-shaped request instead of the public SDK reply payload.
