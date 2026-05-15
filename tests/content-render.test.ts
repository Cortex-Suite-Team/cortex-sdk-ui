import {
  renderAssistantMarkdown,
  renderChatMessageContent,
} from '../src/index.js';
import { createMessage } from './helpers.js';
import { normalizeCortexMessage } from '../src/normalize.js';

describe('renderChatMessageContent', () => {
  it('renders assistant final answer markdown as sanitized html', () => {
    const message = normalizeCortexMessage(createMessage('chat::answer', {
      content: ['**bold**', '- item', '`code`', '```ts', 'const x = 1;', '```'],
      role: 'assistant',
      answer_kind: 'final',
      turn_id: 'turn_1',
    }));

    const rendered = renderChatMessageContent(message);

    expect(rendered.format).toBe('html');
    if (rendered.format !== 'html') {
      throw new Error('Expected html format');
    }
    expect(rendered.kind).toBe('assistant_markdown');
    expect(rendered.html).toContain('<strong>bold</strong>');
    expect(rendered.html).toContain('<ul>');
    expect(rendered.html).toContain('<code>code</code>');
    expect(rendered.html).toContain('<pre><code');
  });

  it('renders assistant links with target and rel', () => {
    const html = renderAssistantMarkdown('[safe](https://example.test/path)');

    expect(html).toContain('href="https://example.test/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('neutralizes dangerous html and javascript urls', () => {
    const html = renderAssistantMarkdown([
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)" onclick="alert(2)" style="color:red">bad</a>',
    ].join('\n'));
    const template = document.createElement('template');
    template.innerHTML = html;

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(template.content.querySelector('script')).toBeNull();
    expect(template.content.querySelector('img')).toBeNull();
    expect(template.content.querySelector('a')).toBeNull();
  });

  it('keeps user messages as safe plain text', () => {
    const message = normalizeCortexMessage(createMessage('chat::message', {
      content: '**bold**\n- list item',
      role: 'user',
    }));

    const rendered = renderChatMessageContent(message);

    expect(rendered).toEqual({
      format: 'text',
      text: '**bold**\n- list item',
      style: 'plain',
      kind: 'plain_text',
    });
  });

  it('does not markdown-render chat partials', () => {
    const message = normalizeCortexMessage(createMessage('chat::partial', {
      content: '**partial**',
      role: 'assistant',
      turn_id: 'turn_1',
    }));

    const rendered = renderChatMessageContent(message);

    expect(rendered).toEqual({
      format: 'text',
      text: '**partial**',
      style: 'plain',
      kind: 'plain_text',
    });
  });

  it('uses structured fallback for mixed arrays and objects', () => {
    const mixedArray = renderChatMessageContent({
      id: 'mixed',
      type: 'chat::answer',
      role: 'assistant',
      content: ['text', { nested: true }],
      status: 'final',
    });
    const objectContent = renderChatMessageContent({
      id: 'object',
      type: 'chat::answer',
      role: 'assistant',
      content: { key: 'value' },
      status: 'final',
    });

    expect(mixedArray).toEqual({
      format: 'text',
      text: JSON.stringify(['text', { nested: true }], null, 2),
      style: 'preformatted',
      kind: 'structured_fallback',
    });
    expect(objectContent).toEqual({
      format: 'text',
      text: JSON.stringify({ key: 'value' }, null, 2),
      style: 'preformatted',
      kind: 'structured_fallback',
    });
  });

  it('does not mutate reconciliation fields on the source message', () => {
    const message = normalizeCortexMessage(createMessage('chat::echo', {
      content: 'Hello',
      role: 'user',
      meta: {
        client_msg_id: 'msg_1',
      },
    }));
    const snapshot = JSON.parse(JSON.stringify(message));

    renderChatMessageContent(message);

    expect(message).toEqual(snapshot);
    expect(message.clientMsgId).toBe('msg_1');
    expect(message.type).toBe('chat::echo');
    expect(message.role).toBe('user');
    expect(message.status).toBe('final');
    expect(message.meta).toEqual(snapshot.meta);
  });
});
