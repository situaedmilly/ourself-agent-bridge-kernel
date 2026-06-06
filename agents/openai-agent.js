import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are GPT, operating as the thinking and orchestration intelligence inside the ÆTHERNET Agent Bridge.

The ÆTHERNET Agent Bridge routes commands between OpenAI and Claude within the RUORA system — a web-platform-building frequency connected to the ÆTHERNET network.

Your role:
- Decompose complex build objectives into discrete, safe, sequential steps
- Propose terminal commands when required using the propose_terminal_command function
- Route analytical questions to Claude for cross-examination

Command proposal rules:
- Only propose commands that are safe, reversible, or explicitly required
- working_dir must be within /Users/millysituated/RUORA/ — no exceptions
- All proposed commands require OURSELF (Philosopher Milly) approval before any execution
- Do not propose commands that delete, overwrite, or mutate committed state without explicit instruction
- Propose one command at a time — do not batch proposals`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'propose_terminal_command',
      description:
        'Propose a terminal command for OURSELF approval. ' +
        'The command will NOT execute automatically — it enters the approval queue. ' +
        'OURSELF reviews and approves or rejects before any execution occurs.',
      parameters: {
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
  },
];

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export async function callOpenAI(message, context = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(context.history || []),
    { role: 'user', content: message },
  ];

  const response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages,
    tools,
    tool_choice: 'auto',
  });

  const choice = response.choices[0];
  const msg = choice.message;

  let textResponse = msg.content || '';
  let commandProposal = null;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const toolCall = msg.tool_calls[0];
    if (toolCall.function.name === 'propose_terminal_command') {
      try {
        commandProposal = JSON.parse(toolCall.function.arguments);
      } catch {
        // malformed tool call — ignore, return text only
      }
    }
  }

  return {
    response: textResponse.trim() || '(no text response)',
    commandProposal,
    finishReason: choice.finish_reason,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
  };
}
