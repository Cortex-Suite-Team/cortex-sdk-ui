# Cortex SDK UI

`@cortex-suite/sdk-ui` is the headless Cortex chat behavior layer.

It owns chat and escalation state management, but it does not render DOM, CSS, widgets, or framework components.

## Boundaries

This package includes:

- transcript state
- message normalization
- `chat::partial` aggregation
- connection and input-lock display state
- escalation helpers for `operator_input` and `reply_user`

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

## Interactive Questions

Canonical runtime questions arrive as `chat::question` with `payload.meta.questions`.

```json
{
  "type": "chat::question",
  "payload": {
    "content": "Please clarify",
    "role": "assistant",
    "meta": {
      "question_ref": "q_01hzk8p5x4w6",
      "input_type": "form",
      "allow_reply": true,
      "questions": [
        {
          "key": "decision",
          "label": "Decision",
          "type": "select",
          "required": true,
          "options": [
            { "id": "approve", "label": "Approve" }
          ]
        }
      ]
    }
  }
}
```

Rules:

- `payload.meta.questions` is canonical
- top-level `payload.meta.options` is not supported
- `question_ref` is canonical
- `question_id` is accepted only as an inbound legacy fallback for old `chat::question`
- `resume_event_ref` is internal runtime coordination metadata and is ignored by `sdk-ui`

Answer payloads must echo `payload.meta.question_ref`.

Canonical generated question replies use `content` as `string[]`. Structured data belongs in
`payload.meta`, not `payload.content`.

Choice answers use `meta.selected`, always as `string[]`. `selected` contains question keys, never
labels. Radio answers still use a one-item array; checkbox answers use one or more keys.

Single select / radio answers use `selected`:

```json
{
  "type": "chat::message",
  "payload": {
    "content": [],
    "role": "user",
    "meta": {
      "question_ref": "q_01hzk8p5x4w6",
      "selected": ["approve"]
    }
  }
}
```

Checkbox answers also use `selected`:

```json
{
  "type": "chat::message",
  "payload": {
    "content": [],
    "role": "user",
    "meta": {
      "question_ref": "q_01hzk8p5x4w6",
      "selected": ["approve", "request_changes"]
    }
  }
}
```

Free replies use text content and do not include `selected`:

```json
{
  "type": "chat::message",
  "payload": {
    "content": ["Your answer here"],
    "role": "user",
    "meta": {
      "question_ref": "q_01hzk8p5x4w6"
    }
  }
}
```

## Control Plane Reuse

Control Plane can reuse transcript and escalation behavior while keeping operator permissions server-side.

If the browser must not receive the runtime `wait_token`, provide a custom `replyRequestBuilder`. That lets the controller keep its normal helper API while your Control Plane adapter sends a server-shaped request instead of the public SDK reply payload.
