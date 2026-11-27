'use strict';

export const COMMUNICATION_FABRIC_VERSION = 'ourself.communication-fabric.v0.1';
export const TRANSPORT_ADAPTER_VERSION = 'ourself.transport-adapter.v0.1';
export const COMMUNICATION_ERRORS = Object.freeze({ INVALID_ADAPTER:'INVALID_ADAPTER', INVALID_EVENT:'INVALID_EVENT', TRANSPORT_FAILURE:'TRANSPORT_FAILURE', TRANSPORT_RECEIVE_FAILURE:'TRANSPORT_RECEIVE_FAILURE' });

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event_id !== 'string' || event.event_id.length === 0) throw new TypeError(COMMUNICATION_ERRORS.INVALID_EVENT);
  return event;
}
function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.send !== 'function' || typeof adapter.receive !== 'function') throw new TypeError(COMMUNICATION_ERRORS.INVALID_ADAPTER);
  return adapter;
}

// Transport mechanics only. Semantic admission, authority, execution and effect remain outside this membrane.
export function createCommunicationFabric(adapter) {
  const transport = assertAdapter(adapter);
  return Object.freeze({
    version: COMMUNICATION_FABRIC_VERSION,
    async send(event) {
      const semanticEvent = assertEvent(event);
      try { return await transport.send(semanticEvent); }
      catch (error) { const wrapped = new Error(COMMUNICATION_ERRORS.TRANSPORT_FAILURE + ': ' + (error?.message || String(error))); wrapped.cause = error; throw wrapped; }
    },
    async receive() {
      try {
        const encountered = await transport.receive();
        if (encountered === null || encountered === undefined) return null;
        assertEvent(encountered);
        return encountered;
      } catch (error) {
        if (error?.message === COMMUNICATION_ERRORS.INVALID_EVENT) throw error;
        const wrapped = new Error(COMMUNICATION_ERRORS.TRANSPORT_RECEIVE_FAILURE + ': ' + (error?.message || String(error))); wrapped.cause = error; throw wrapped;
      }
    },
  });
}
