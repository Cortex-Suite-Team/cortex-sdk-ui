import {
  createControllerError,
  errorFromUnknown,
} from './errors.js';
import { normalizeEscalationState } from './normalize.js';
import type {
  ChatControllerEvent,
  ChatErrorViewModel,
  EscalationAction,
  EscalationController,
  EscalationControllerOptions,
  EscalationReplyContent,
  EscalationState,
  ReplyEscalationRequest,
} from './types.js';
import { asNonEmptyString, asPayload, cloneEscalation } from './utils.js';

export function createEscalationController(options: EscalationControllerOptions): EscalationController {
  let state = cloneEscalation(options.initialState ?? null);

  function emit(event: ChatControllerEvent) {
    options.onEvent?.(event);
  }

  function emitError(error: ChatErrorViewModel) {
    emit({ type: 'error', error });
  }

  function requireEscalation(): EscalationState {
    if (!state) {
      throw createControllerError(
        'escalation_missing',
        'No pending escalation is available.',
        'escalation',
      );
    }
    return state;
  }

  function validateAction(current: EscalationState, action: EscalationAction) {
    if (!current.allowedActions.includes(action)) {
      throw createControllerError(
        'action_not_allowed',
        `Escalation action ${action} is not allowed.`,
        'escalation',
        {
          escalationId: current.escalationId,
          allowedActions: current.allowedActions,
        },
      );
    }
  }

  function buildReplyRequest(
    current: EscalationState,
    action: EscalationAction,
    content?: EscalationReplyContent,
  ): ReplyEscalationRequest {
    if (options.replyRequestBuilder) {
      return options.replyRequestBuilder({ escalation: current, action, content });
    }

    if (!current.waitToken) {
      throw createControllerError(
        'wait_token_missing',
        'Current escalation has no waitToken. Provide replyRequestBuilder for server-side wait-token handling.',
        'escalation',
        {
          escalationId: current.escalationId,
          action,
        },
      );
    }

    return {
      escalationId: current.escalationId,
      waitToken: current.waitToken,
      action,
      ...(content !== undefined ? { content } : {}),
    };
  }

  async function reply(action: EscalationAction, content?: EscalationReplyContent) {
    try {
      const current = requireEscalation();
      validateAction(current, action);

      if (!options.client.replyEscalation) {
        throw createControllerError(
          'reply_escalation_missing',
          'Client does not implement replyEscalation().',
          'escalation',
        );
      }

      const request = buildReplyRequest(current, action, content);
      await options.client.replyEscalation(request);
      state = {
        ...current,
        status: 'replied',
      };
      emit({ type: 'escalation_replied', action });
    } catch (error) {
      const viewModel = errorFromUnknown(error, 'escalation_reply_failed', 'escalation');
      emitError(viewModel);
      throw error;
    }
  }

  return {
    getState() {
      return cloneEscalation(state);
    },

    setState(nextState) {
      state = cloneEscalation(nextState);
    },

    clearEscalation() {
      state = null;
    },

    ingest(message) {
      if (message.type === 'escalation::request') {
        state = normalizeEscalationState(message);
        return cloneEscalation(state);
      }

      if (message.type === 'escalation::reply' && state) {
        const payload = asPayload(message);
        const escalationId = asNonEmptyString(payload['escalation_id']);
        if (escalationId && escalationId === state.escalationId) {
          state = {
            ...state,
            status: 'replied',
          };
        }
      }

      return cloneEscalation(state);
    },

    async replyToUser(content) {
      await reply('reply_user', content);
    },

    async returnToWorker(content) {
      await reply('operator_input', content);
    },

    async continueWorker(content) {
      await reply('continue', content);
    },
  };
}
