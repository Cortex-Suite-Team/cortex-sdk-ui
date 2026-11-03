import { createHumanAssistanceController } from '../src/human-assistance-controller.js';
import type { HumanAssistanceClientLike, HumanAssistanceRequest, ReplyHumanAssistanceOptions } from '../src/types.js';

const request: HumanAssistanceRequest = {
  version: 1, request_id: 'r', question: 'Approve?',
  options: [{ id: 'no', label: 'No' }], allow_text: true,
  deadline_at: new Date(Date.now() + 60_000).toISOString(), status: 'pending',
};

test('Other is visible but only nonempty text is sent, with no stale option ID', async () => {
  const sent: ReplyHumanAssistanceOptions[] = [];
  const client: HumanAssistanceClientLike = {
    humanAssistanceRequests: [request], onHumanAssistance: () => () => {},
    replyHumanAssistance: async (options) => { sent.push(options); },
  };
  const controller = createHumanAssistanceController({ client, createClientReplyId: () => 'reply' });
  expect(controller.getCards()[0].fields[0].options).toEqual([
    { id: 'no', label: 'No' }, { id: '', label: 'Other…' },
  ]);
  controller.selectOption('r', 'no');
  controller.selectOption('r', '');
  expect(() => controller.submit('r')).toThrow('Choose an option or enter text.');
  controller.setText('r', '  Need context  ');
  await controller.submit('r');
  expect(sent).toEqual([{ requestId: 'r', clientReplyId: 'reply', action: 'answer', text: 'Need context' }]);
  controller.destroy();
});

test('Other is absent when text is forbidden', () => {
  const client: HumanAssistanceClientLike = {
    humanAssistanceRequests: [{ ...request, allow_text: false }], onHumanAssistance: () => () => {},
    replyHumanAssistance: async () => {},
  };
  const controller = createHumanAssistanceController({ client });
  expect(controller.getCards()[0].fields[0].options).toEqual([{ id: 'no', label: 'No' }]);
  expect(() => controller.selectOption('r', '')).toThrow('Unknown Human Assistance option.');
  controller.destroy();
});
