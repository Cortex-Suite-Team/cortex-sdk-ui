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

## File Attachments

Every message keeps its files, in order, in `message.meta.attachments` as `ChatAttachment` objects (the
`@cortex-suite/sdk` public session-file descriptor: `file_ref`, `filename`, `content_type`, `size`,
`owner_role`, `direction`, `state`, `message_ref`, `message_ref_kind`).

- User uploads sit on the user message (`owner_role: "user"`, `direction: "inbound"`,
  `message_ref_kind: "client_msg_id"`, `message_ref` = its `client_msg_id`); files generated for an answer sit on
  that assistant message (`owner_role: "assistant"`, `direction: "outbound"`, `message_ref_kind: "turn"`,
  `message_ref` = `String(payload.turn)`). Both binding fields must be present and match exactly. A file of
  another owner, direction or message, an answer without `turn` (for example an operator close), a user message
  without `client_msg_id` and any other message type carry no files, so a user upload repeated inside an answer
  never becomes an assistant file. At most 8 files per message.
- Runtime answers and partials are identified by their integer `turn` (`id: "turn:<turn>"`, `meta.turnRef`).
- Only canonical `payload.meta.attachments` is read. Internal identities, scope, storage keys, tickets and URLs
  (including `download_mint_url`) are removed before a message is stored, rendered or persisted, and again when a
  persisted transcript is restored.
- Replayed echoes and answers (resync, reload) keep each `file_ref` once in its first position; a re-delivered file
  takes the newer descriptor (for example `state: "expired"`), and a delivery without attachments never removes
  accepted ones.
- Right after `sendMessage({ attachments })` the optimistic user message holds only `{ file_ref }` entries (plus any
  `filename` / `content_type` / `size` you passed); the echo replaces them with full descriptors.

SDK UI does not transfer bytes. Download a file through the SDK with `client.downloadFile(attachment.file_ref)`.

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
