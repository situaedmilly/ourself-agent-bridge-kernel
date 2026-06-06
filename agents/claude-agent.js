import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `You are Claude, operating as the cross-examination and build intelligence inside the ÆTHERNET Agent Bridge.

The ÆTHERNET Agent Bridge routes commands between OpenAI and Claude within the RUORA system — the web-platform-building frequency of SELF.

Your role:
- Cross-examine proposed actions for correctness, safety, and alignment with SELF Axiom Doctrine
- Help build and verify RUORA and AXIOM ecosystem components
- Propose terminal commands when required using the propose_terminal_command tool

SELF Axiom Doctrine (must be preserved):
No declaration without execution.
No execution without evidence.
No evidence without memory.

Command proposal rules:
- Only propose commands that are safe, reversible, or explicitly required
- working_dir must be within /Users/millysituated/RUORA/ — no exceptions
- All proposed commands require OURSELF (Philosopher Milly) approval before any execution
- Do not propose commands that delete, overwrite, or mutate committed state without explicit instruction
- Propose one command at a time — do not batch proposals`;

const tools = [
  {
    name: 'propose_terminal_command',
    description:
      'Propose a terminal command for OURSELF approval. ' +
      'The command will NOT execute automatically — it enters the approval queue. ' +
      'OURSELF reviews and approves or rejects before any execution occurs.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The exact shell command to execute.',
        },
        working_dir: {
          type: 'string',
          description:
            'Absolute working directory. Must be within /Users/millysituated/RUORA/.',
        },
        rationale: {
          type: 'string',
          description: 'Why this command is needed and what observable proof it will produce.',
        },
      },
      required: ['action', 'working_dir', 'rationale'],
    },
  },
];

let client;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function callClaude(message, context = {}) {
  const messages = [
    ...(context.history || []),
    { role: 'user', content: message },
  ];

  const response = await getClient().messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  let textResponse = '';
  let commandProposal = null;

  for (const block of response.content) {
    if (block.type === 'text') {
      textResponse += block.text;
    } else if (block.type === 'tool_use' && block.name === 'propose_terminal_command') {
      commandProposal = block.input;
    }
    // thinking blocks intentionally skipped — internal reasoning, not transmitted
  }

  return {
    response: textResponse.trim() || '(no text response)',
    commandProposal,
    stopReason: response.stop_reason,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
}
