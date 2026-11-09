export class InterpretationError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'InterpretationError';
    this.status = status;
  }
}

async function readError(response) {
  try {
    const body = await response.json();
    return body.detail ?? body.message ?? `Interpreter request failed (${response.status}).`;
  } catch {
    return `Interpreter request failed (${response.status}).`;
  }
}

/**
 * Sends text + compact scene/world snapshots, then executes only the validated
 * planning actions returned by the backend.
 */
export async function interpretAndExecute({
  instruction,
  scene,
  world = { status: 'idle' },
  executeCommands,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const normalized = instruction?.trim();
  if (!normalized) throw new InterpretationError('Enter an instruction first.');
  if (typeof executeCommands !== 'function') {
    throw new TypeError('executeCommands must be a function.');
  }

  let response;
  try {
    response = await fetchImpl('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: normalized, scene, world }),
    });
  } catch (error) {
    const wrapped = new InterpretationError('Could not reach the command interpreter.');
    wrapped.cause = error;
    throw wrapped;
  }

  if (!response.ok) {
    throw new InterpretationError(await readError(response), response.status);
  }

  const interpretation = await response.json();
  if (!Array.isArray(interpretation.actions)) {
    throw new InterpretationError('Interpreter returned an invalid response.');
  }

  const execution = interpretation.actions.length
    ? await executeCommands(interpretation.actions)
    : null;

  return {
    instruction: normalized,
    interpreted: {
      actions: interpretation.actions,
      clarification: interpretation.clarification ?? null,
      acknowledgement: interpretation.acknowledgement ?? null,
      model: interpretation.model ?? null,
    },
    execution,
  };
}
