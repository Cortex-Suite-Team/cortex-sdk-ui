import createDOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

import type { ChatMessageViewModel, RenderedChatContent } from './types.js';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const FORBIDDEN_TAGS = ['script', 'style', 'iframe', 'img', 'form', 'input', 'button'];
const FORBIDDEN_ATTRS = ['style'];
type DOMPurifyWindow = Parameters<typeof createDOMPurify>[0];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toTextualContent(source: unknown): string | null {
  if (typeof source === 'string') {
    return source;
  }

  if (isStringArray(source)) {
    return source.join('\n');
  }

  if (source === null || source === undefined) {
    return '';
  }

  return null;
}

function toStructuredText(source: unknown): string {
  if (source === null || source === undefined) {
    return '';
  }

  try {
    return JSON.stringify(source, null, 2);
  } catch {
    return String(source);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWindowLike(): Window | null {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return window;
  }

  return null;
}

function sanitizeHtml(html: string): string {
  const currentWindow = getWindowLike();
  if (!currentWindow) {
    return escapeHtml(html);
  }

  const purify = createDOMPurify(currentWindow as unknown as DOMPurifyWindow);

  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (/^on/i.test(data.attrName)) {
      data.keepAttr = false;
    }
  });

  const sanitized = purify.sanitize(html, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
  });

  purify.removeAllHooks();

  const template = currentWindow.document.createElement('template');
  template.innerHTML = sanitized;

  for (const link of template.content.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }

  return template.innerHTML;
}

export function renderAssistantMarkdown(source: unknown): string {
  const text = toTextualContent(source);
  if (text === null) {
    return '';
  }

  const rendered = markdown.render(text);
  return sanitizeHtml(rendered);
}

export function renderUserText(source: unknown): string {
  return toTextualContent(source) ?? toStructuredText(source);
}

export function renderChatMessageContent(message: ChatMessageViewModel): RenderedChatContent {
  const textualContent = toTextualContent(message.content);
  const isAssistantFinalAnswer = (
    message.role === 'assistant'
    && message.type === 'chat::answer'
    && message.status === 'final'
    && textualContent !== null
  );

  if (isAssistantFinalAnswer) {
    return {
      format: 'html',
      html: renderAssistantMarkdown(message.content),
      kind: 'assistant_markdown',
    };
  }

  if (textualContent !== null) {
    return {
      format: 'text',
      text: renderUserText(message.content),
      style: 'plain',
      kind: 'plain_text',
    };
  }

  return {
    format: 'text',
    text: toStructuredText(message.content),
    style: 'preformatted',
    kind: 'structured_fallback',
  };
}
