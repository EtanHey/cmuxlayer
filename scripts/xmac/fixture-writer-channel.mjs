import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// One length-prefixed UTF8 JSON session; capability grants write authority only.
// drain()/close() end the session. Identity, files, and callback cancellation belong to callers.
export const PROTOCOL_VERSION = 1;
export const HARD_LIMITS = Object.freeze({ frameBytes: 65536, bodyBytes: 16384,
  queuedEvents: 16, queuedBodyBytes: 262144, acceptedEvents: 2048, wireBytes: 4194304,
  unauthenticatedSockets: 4, authenticationAttempts: 8, handshakeMs: 3000,
  eventMs: 3000, drainMs: 3000, lifetimeMs: 60000 });
const failure = code => Object.assign(new Error(`fixture channel: ${code}`), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Internal lifecycle promises may fail before the caller asks to close.
  promise.catch(() => {});
  return { promise, resolve, reject };
};
function optionsCheck(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !allowed.includes(k))) throw failure('CONFIG');
  const signal = options.signal;
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw failure('CONFIG');
}
function config(runId, input) {
  if (typeof runId !== 'string' || !runId || Buffer.byteLength(runId) > 128 || !validString(runId)) throw failure('RUN');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('LIMITS');
  if (Object.keys(input).some(k => !Object.hasOwn(HARD_LIMITS, k))) throw failure('LIMITS');
  const limits = { ...HARD_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = Object.hasOwn(input, key) ? input[key] : limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw failure('LIMITS');
    limits[key] = value;
  }
  return Object.freeze(limits);
}
function validString(value) { return Buffer.from(value, 'utf8').toString('utf8') === value; }
function keys(message, names) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).sort().join(',') === names.sort().join(',');
}
function bodySize(body, limits) {
  if (typeof body !== 'string' || !validString(body) || Buffer.byteLength(body) > limits.bodyBytes) throw failure('BODY');
  return Buffer.byteLength(body);
}
function endpointCheck(endpoint) {
  if (!keys(endpoint, ['host', 'port']) || endpoint.host !== '127.0.0.1' ||
      !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw failure('ENDPOINT');
}
function clocks(limits, fail, signal) {
  const timers = new Set();
  const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
  const after = (ms, code, fn = () => fail(code)) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const abort = () => fail('ABORT');
  return {
    after, cancel,
    begin() {
      after(limits.lifetimeMs, 'LIFETIME_TIMEOUT');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    clear() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      signal?.removeEventListener('abort', abort);
    }
  };
}
// Raw bytes are bounded before decoding. Every complete frame uses fatal UTF8 decoding.
function wire(socket, limits, counts, fail, receive, clock) {
  let buffer = Buffer.alloc(0), partial;
  socket.on('error', () => fail('TRANSPORT'));
  socket.on('data', bytes => {
    try {
      if (counts.receivedBytes + bytes.length > limits.wireBytes) throw failure('WIRE_LIMIT');
      counts.receivedBytes += bytes.length;
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (!size || size + 4 > limits.frameBytes) throw failure('FRAME');
        if (buffer.length < size + 4) break;
        const raw = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
        let message;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw failure('FRAME'); }
        receive(message);
        if (socket.destroyed) return;
      }
      if (!buffer.length && partial) { clock.cancel(partial); partial = null; }
      if (buffer.length && !partial) partial = clock.after(limits.eventMs, 'FRAME_TIMEOUT');
    } catch (error) { fail(error.code ?? 'MESSAGE'); }
  });
  socket.on('close', () => { if (partial) clock.cancel(partial); });
  return message => {
    if (socket.destroyed || !socket.writable) throw failure('DISCONNECT');
    const bytes = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    if (!bytes.length || bytes.length + 4 > limits.frameBytes) throw failure('FRAME');
    if (counts.sentBytes + bytes.length + 4 > limits.wireBytes) throw failure('WIRE_LIMIT');
    if (socket.writableLength + bytes.length + 4 > limits.queuedBodyBytes + limits.frameBytes) throw failure('BACKPRESSURE');
    header.writeUInt32BE(bytes.length); counts.sentBytes += bytes.length + 4;
    socket.write(Buffer.concat([header, bytes]));
  };
}

export function createFixtureWriterChannel(options) {
  optionsCheck(options, ['runId', 'limits', 'onEvent', 'signal']);
  const { runId, limits: input, onEvent, signal } = options;
  const limits = config(runId, input);
  if (typeof onEvent !== 'function') throw failure('CALLBACK');
  let state = 'fresh', error = null, capability, listener, peer, send, startPromise;
  let listenerClosed = true, closingListener = false, inFlight = false, uncertain = false;
  let acceptedSequence = 0, acknowledgedSequence = 0, queuedBytes = 0, drainRequested = false, exchangeComplete = false, drainTimer;
  const sockets = new Set(), queue = [], done = deferred();
  const counts = { receivedBytes: 0, sentBytes: 0, authenticationAttempts: 0, rejectedConnections: 0 };
  const clock = clocks(limits, fail, signal);
  const receipt = () => ({ state, error, acceptedSequence, acknowledgedSequence, uncertain,
    queuedEvents: queue.length, queuedBodyBytes: queuedBytes, sockets: sockets.size, listenerClosed, ...counts });
  function settle() {
    if (!listenerClosed || sockets.size) return;
    if (error) done.reject(failure(error));
    else if (state === 'closing') { state = 'closed'; clock.clear(); done.resolve(receipt()); }
  }
  function stopListener() {
    if (!listener || listenerClosed || closingListener || !listener.listening) return;
    closingListener = true;
    listener.close(() => { listenerClosed = true; settle(); });
  }
  function fail(code) {
    if (error || state === 'closed') return;
    error = code;
    state = 'failed';
    uncertain ||= inFlight || acceptedSequence > acknowledgedSequence || (acceptedSequence > 0 && !exchangeComplete);
    capability = undefined;
    clock.clear();
    queue.length = 0;
    queuedBytes = 0;
    stopListener();
    for (const socket of sockets) socket.destroy();
    settle();
  }
  function safeSend(message) {
    try { send(message); return true; }
    catch (e) { fail(e.code ?? 'TRANSPORT'); return false; }
  }
  function beginDrain() {
    if (!drainTimer) drainTimer = clock.after(limits.drainMs, 'DRAIN_TIMEOUT');
  }
  function drained() {
    if (drainRequested && !inFlight && !queue.length && !error) safeSend({ type: 'drained', sequence: acknowledgedSequence });
  }
  async function pump() {
    if (inFlight || error || !queue.length) return;
    const event = queue[0];
    inFlight = true;
    try { await onEvent(event.sequence, event.body); }
    catch { fail('CALLBACK'); }
    inFlight = false;
    if (error) return; // Running callbacks are not cancellable; never ACK late success.
    clock.cancel(event.timer);
    queue.shift();
    queuedBytes -= event.bytes;
    if (safeSend({ type: 'ack', sequence: event.sequence })) acknowledgedSequence = event.sequence;
    if (!error) { void pump(); drained(); }
  }
  function message(m) {
    if (error || exchangeComplete) { fail('LATE_EVENT'); return; }
    if (m?.type === 'event' && keys(m, ['type', 'sequence', 'body'])) {
      if (state !== 'authenticated' || drainRequested) throw failure('LATE_EVENT');
      if (!Number.isSafeInteger(m.sequence) || m.sequence !== acceptedSequence + 1) throw failure('SEQUENCE');
      const bytes = bodySize(m.body, limits);
      if (acceptedSequence >= limits.acceptedEvents) throw failure('EVENT_LIMIT');
      if (queue.length >= limits.queuedEvents || queuedBytes + bytes > limits.queuedBodyBytes) throw failure('QUEUE');
      acceptedSequence = m.sequence; queuedBytes += bytes;
      queue.push({ ...m, bytes, timer: clock.after(limits.eventMs, 'EVENT_TIMEOUT') }); void pump();
    } else if (m?.type === 'drain' && keys(m, ['type', 'sequence'])) {
      if (drainRequested || m.sequence !== acceptedSequence) throw failure('DRAIN');
      state = 'stopping'; drainRequested = true; beginDrain(); drained();
    } else if (m?.type === 'drainAck' && keys(m, ['type', 'sequence'])) {
      if (!drainRequested || inFlight || queue.length || m.sequence !== acknowledgedSequence) throw failure('DRAIN');
      safeSend({ type: 'closed', sequence: acknowledgedSequence });
      if (error) return;
      exchangeComplete = true; state = 'closing'; peer.end(); stopListener();
    } else throw failure('MESSAGE');
  }
  function accept(socket) {
    sockets.add(socket); socket.setNoDelay(true);
    if (socket.remoteAddress !== '127.0.0.1' || socket.localAddress !== '127.0.0.1') {
      counts.rejectedConnections++;
      socket.destroy();
      sockets.delete(socket);
      return;
    }
    let authenticated = false, handshake;
    const reject = () => { counts.rejectedConnections++; socket.destroy(); };
    socket.on('close', () => {
      sockets.delete(socket); clock.cancel(handshake);
      if (authenticated && !exchangeComplete && !error) fail('DISCONNECT'); settle();
    });
    if (counts.authenticationAttempts >= limits.authenticationAttempts) { fail('AUTH_LIMIT'); return; }
    counts.authenticationAttempts++;
    if (peer || sockets.size > limits.unauthenticatedSockets || state !== 'listening') { reject(); return; }
    handshake = clock.after(limits.handshakeMs, 'HANDSHAKE_TIMEOUT', reject);
    const write = wire(socket, limits, counts, fail, m => {
      if (authenticated) { message(m); return; }
      const valid = keys(m, ['type', 'version', 'runId', 'capability', 'limits']) && m.type === 'hello' &&
        m.version === PROTOCOL_VERSION && m.runId === runId && typeof m.capability === 'string' &&
        Buffer.byteLength(m.capability) === 64 && capability && timingSafeEqual(Buffer.from(m.capability), Buffer.from(capability)) &&
        keys(m.limits, Object.keys(limits)) && Object.keys(limits).every(k => m.limits[k] === limits[k]);
      if (!valid || peer || state !== 'listening') { reject(); return; }
      authenticated = true; clock.cancel(handshake); peer = socket; send = write;
      capability = undefined; state = 'authenticated'; stopListener();
      for (const other of sockets) if (other !== socket) other.destroy();
      safeSend({ type: 'ready', version: PROTOCOL_VERSION });
    }, clock);
  }
  function start() {
    if (startPromise) return startPromise;
    if (state !== 'fresh') return Promise.reject(failure(error ?? 'CLOSED'));
    if (signal?.aborted) { fail('ABORT'); return Promise.reject(failure('ABORT')); }
    state = 'starting'; capability = randomBytes(32).toString('hex'); listener = net.createServer(accept);
    listenerClosed = false; clock.begin();
    startPromise = new Promise((resolve, reject) => {
      listener.on('error', () => { listenerClosed = true; fail('LISTENER'); reject(failure(error)); settle(); });
      listener.listen({ host: '127.0.0.1', port: 0 }, () => {
        if (error) { stopListener(); reject(failure(error)); return; }
        state = 'listening'; resolve({ endpoint: { host: '127.0.0.1', port: listener.address().port }, capability });
      });
    });
    startPromise.catch(() => {}); return startPromise;
  }
  function close() {
    if (state === 'fresh') { state = 'closing'; settle(); }
    else if (!error && !['closing', 'closed', 'stopping'].includes(state)) {
      if (state === 'starting') { fail('CLOSED'); }
      else if (!peer) { state = 'closing'; clock.clear(); stopListener(); for (const s of sockets) s.destroy(); settle(); }
      else { state = 'stopping'; beginDrain(); safeSend({ type: 'stop' }); }
    }
    return done.promise;
  }
  return { start, close, abort(error) { fail('ABORT'); }, receipt };
}

export async function connectFixtureWriter(options) {
  optionsCheck(options, ['runId', 'endpoint', 'capability', 'limits', 'signal']);
  const { runId, endpoint, capability, limits: input, signal } = options;
  const limits = config(runId, input); endpointCheck(endpoint);
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) throw failure('CAPABILITY');
  if (signal?.aborted) throw failure('ABORT');
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port }); socket.setNoDelay(true);
  const ready = deferred(), done = deferred(), pending = new Map();
  let error, authenticated = false, stopping = false, requested = false, drainAcknowledged = false, final = false, closed = false, issued = 0, ack = 0, queuedBytes = 0;
  const counts = { receivedBytes: 0, sentBytes: 0 };
  const clock = clocks(limits, fail, signal);
  function fail(code) {
    if (error || closed) return;
    error = code;
    clock.clear();
    ready.reject(failure(code));
    done.reject(failure(code));
    for (const p of pending.values()) p.reject(failure(code));
    pending.clear();
    queuedBytes = 0;
    socket.destroy();
  }
  function send(message) { try { write(message); } catch (e) { fail(e.code ?? 'TRANSPORT'); } }
  function sendDrain() {
    if (stopping && authenticated && !pending.size && !requested && !error) {
      requested = true; send({ type: 'drain', sequence: issued });
    }
  }
  function drain() {
    if (error) return Promise.reject(failure(error));
    if (!stopping && !final) { stopping = true; clock.after(limits.drainMs, 'DRAIN_TIMEOUT'); }
    sendDrain(); return done.promise;
  }
  const handshake = clock.after(limits.handshakeMs, 'HANDSHAKE_TIMEOUT');
  const write = wire(socket, limits, counts, fail, m => {
    if (error || final) throw failure('LATE_EVENT');
    if (!authenticated) {
      if (!keys(m, ['type', 'version']) || m.type !== 'ready' || m.version !== PROTOCOL_VERSION) throw failure('AUTH');
      authenticated = true; clock.cancel(handshake); ready.resolve(); return;
    }
    if (m?.type === 'ack' && keys(m, ['type', 'sequence'])) {
      if (m.sequence !== ack + 1 || !pending.has(m.sequence)) throw failure('ACK');
      const p = pending.get(m.sequence);
      clock.cancel(p.timer);
      pending.delete(m.sequence);
      queuedBytes -= p.bytes;
      ack = m.sequence;
      p.resolve();
      sendDrain();
    } else if (m?.type === 'stop' && keys(m, ['type'])) { void drain(); }
    else if (m?.type === 'drained' && keys(m, ['type', 'sequence'])) {
      if (!requested || drainAcknowledged || pending.size || m.sequence !== ack) throw failure('DRAIN');
      drainAcknowledged = true; send({ type: 'drainAck', sequence: ack });
    } else if (m?.type === 'closed' && keys(m, ['type', 'sequence'])) {
      if (!drainAcknowledged || pending.size || m.sequence !== ack) throw failure('DRAIN');
      // Keep drain/lifetime deadlines until the peer physically closes.
      final = true; socket.end();
    } else throw failure('MESSAGE');
  }, clock);
  socket.on('connect', () => {
    if (socket.remoteAddress !== '127.0.0.1' || socket.localAddress !== '127.0.0.1') { fail('ENDPOINT'); return; }
    send({ type: 'hello', version: PROTOCOL_VERSION, runId, capability, limits });
  });
  socket.on('close', () => {
    if (!final) fail('DISCONNECT');
    else if (!error) { closed = true; clock.clear(); done.resolve({ state: 'closed', acknowledgedSequence: ack, ...counts }); }
  });
  clock.begin(); await ready.promise;
  return { publish(sequence, body) {
    if (error || stopping || final) return Promise.reject(failure(error ?? 'CLOSED'));
    try {
      if (!Number.isSafeInteger(sequence) || sequence !== issued + 1) throw failure('SEQUENCE');
      const bytes = bodySize(body, limits);
      if (issued >= limits.acceptedEvents) throw failure('EVENT_LIMIT');
      if (pending.size >= limits.queuedEvents || queuedBytes + bytes > limits.queuedBodyBytes) throw failure('QUEUE');
      const p = deferred();
      p.bytes = bytes;
      p.timer = clock.after(limits.eventMs, 'EVENT_TIMEOUT');
      issued = sequence;
      queuedBytes += bytes;
      pending.set(sequence, p);
      send({ type: 'event', sequence, body });
      return p.promise;
    } catch (e) { fail(e.code ?? 'MESSAGE'); return Promise.reject(failure(error)); }
  }, drain, close: drain, abort(error) { fail('ABORT'); } };
}
