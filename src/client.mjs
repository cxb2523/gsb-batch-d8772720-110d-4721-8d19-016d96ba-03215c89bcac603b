import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createCodec } from './codec.mjs';

export const MAX_SEQ = 2147483647;
const HALF_SEQ = (MAX_SEQ - 1) / 2;
const MEMBER_REQUESTS = new Set([
  'GuildInfoRequest', 'GotGuildWelfarePackRequest', 'GuildAidListRequest', 'GuildCityInfoRequest',
  'GuildTechInfoRequest', 'UpgradeGuildTechRequest', 'GuildOrderRequest', 'TradeGuildRadarRequest',
  'GuildAidHelpRequest', 'GuildAidAskRequest', 'MyGuildAidRequest', 'GotMyGuildAidRequest', 'GotGuildTitleRewardRequest',
]);

export const TICK_INTERVAL_MS = 1000;
export const PING_TIMEOUT_MS = 10000;
export const MAX_MISSED_PINGS = 3;
export const LOGIN_TIMEOUT_MS = 15000;
export const ACK_DELAY_MS = 1000;
export const HEARTBEAT_DEADLINE_MS = PING_TIMEOUT_MS * MAX_MISSED_PINGS;

// 一次页面读取最多拦住普通请求这么久；各请求自身也有超时，这里只防读取卡死拖住挂机。
const READ_GATE_LIMIT_MS = 20000;
const readScope = new AsyncLocalStorage();

export const DEFAULT_GATEWAY = 'wss://dhyaoj-gate.khlgamen.com/ws';

export function nextSeqNo(seq) {
  return seq === MAX_SEQ ? 1 : seq + 1;
}

// protobufjs decodes int64 into { low, high, unsigned } when no Long library is
// installed, so values echoed back by the server need converting before compare.
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return value.high * 4294967296 + (value.low >>> 0);
  }
  return Number(value);
}

export function isSeqNoInRange(seq, right) {
  if (!(right > 0 && right <= MAX_SEQ)) throw new RangeError(`Invalid seqNoRight=${right}`);
  const left = right - HALF_SEQ;
  if (left > 0) return seq >= left && seq <= right;
  return (seq >= 1 && seq <= right) || (seq >= MAX_SEQ + left && seq <= MAX_SEQ);
}

export class GameClient extends EventEmitter {
  constructor({ url = DEFAULT_GATEWAY, protocol, login = null } = {}) {
    super();
    // 各玩法在同一连接上注册独立推送观察器（均按连接单例）；保留有限上限以发现重复注册。
    this.setMaxListeners(32);
    this.url = url;
    this.login = login;
    // v71 lacks this unsolicited v74 update. Reward claims read their state
    // from DailyTaskInfoResponse, so they don't need to consume its payload.
    this.codec = createCodec(protocol, { optionalPush: 'SCTierTaskUpdate' });
    this.promptNames = protocol.Prompt ?? {};
    this.warnedAboutSkippedPush = false;
    this.state = 'IDLE';
    this.socket = null;
    this.sendSeqNo = Math.floor(1000 * Math.random()) + 1;
    this.recvSeqNo = null;
    this.nextAckSeqNo = null;
    this.ackTimer = null;
    this.gapTimer = null;
    this.tickTimer = null;
    this.lastPingTimestamp = 0;
    this.pingAttempts = new Map();
    this.heartbeatNow = () => performance.now();
    this.lastResponseAt = 0;
    this.latencyMs = 0;
    this.serverClockOffsetMs = 0;
    this.pending = [];
    this.watchers = [];
    this.sendOrder = 0;
    this.stopping = false;
    this.closeReason = null;
    this.loginAbort = null;
    this.connectionEpoch = 0;
    this.readGate = null;
    this.readTail = null;
  }

  get connected() {
    return this.socket !== null && this.socket.readyState === 1;
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, detail });
  }

  async connect(loginBody = this.login, { timeout = LOGIN_TIMEOUT_MS } = {}) {
    if (this.connected || this.loginAbort) throw new Error('already connected or connecting');
    this.releaseRequests('旧连接已替换');
    this.discardSocket('replaced');
    this.stopping = false;
    this.closeReason = null;
    const epoch = ++this.connectionEpoch;
    this.setState('CONNECTING', this.url);

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    const frame = this.codec.encode('LoginRequest', this.bumpSeqNo(), loginBody || {});

    const body = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('login timeout'));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        if (this.loginAbort === abort) this.loginAbort = null;
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.onmessage = null;
      };
      const abort = () => { cleanup(); reject(new Error('client stopped')); };
      this.loginAbort = abort;
      socket.onopen = () => {
        try {
          this.emit('frame', { dir: 'out', name: 'LoginRequest', seq: this.sendSeqNo, bytes: frame });
          socket.send(frame);
        } catch (error) { cleanup(); reject(error); }
      };
      socket.onerror = () => {
        cleanup();
        reject(new Error('socket error during login'));
      };
      socket.onclose = (event) => {
        cleanup();
        reject(new Error(`socket closed during login: ${event.code} ${event.reason || ''}`));
      };
      socket.onmessage = (event) => {
        let decoded;
        try {
          decoded = this.codec.decode(event.data);
        } catch (error) {
          cleanup();
          error.recoverable = false;
          reject(error);
          return;
        }
        cleanup();
        if (decoded.name !== 'LoginResponse') {
          reject(Object.assign(new Error(`unexpected auth reply: ${decoded.name}`), { recoverable: false }));
          return;
        }
        resolve(decoded.body);
      };
    }).catch((error) => {
      const cause = this.stopping || epoch !== this.connectionEpoch ? 'stopped' : error.recoverable === false ? 'protocol' : 'network';
      error.recoverable = cause === 'network';
      // 旧登录的 Promise 可能在 stop 后、下一次 connect 已开始时才拒绝。
      if (epoch === this.connectionEpoch) {
        if (this.socket === socket) this.discardSocket('loginFailed');
        this.closeReason = cause;
        if (!this.stopping) this.setState('FAILED', error.message);
      }
      throw error;
    });

    if (this.stopping || this.socket !== socket) throw Object.assign(new Error('client stopped'), { recoverable: false });

    if (body.result !== 0) {
      this.discardSocket('loginRejected');
      this.closeReason = 'login-rejected';
      this.setState('REJECTED', `result=${body.result} ${body.errorMessage || ''}`);
      const error = new Error(`login rejected: result=${body.result} ${body.errorMessage || ''}`);
      error.loginResponse = body;
      error.recoverable = false;
      throw error;
    }

    this.sendSeqNo = body.initSeqNo ?? 0;
    this.recvSeqNo = null;
    this.nextAckSeqNo = null;

    socket.onmessage = (event) => { if (this.socket === socket) this.onMessage(event.data); };
    socket.onclose = (event) => { if (this.socket === socket) this.onClose(event); };
    socket.onerror = () => { if (this.socket === socket) this.failConnection('游戏连接网络异常', 'network'); };

    this.setState('READY', `player=${body.playerInfo?.nickname ?? ''} initSeqNo=${body.initSeqNo}`);
    if (this.stopping || this.socket !== socket) throw Object.assign(new Error('client stopped'), { recoverable: false });
    this.lastPingTimestamp = 0;
    try { this.sendPing(Date.now()); }
    catch (error) { this.failConnection('发送心跳失败：' + error.message, 'network'); throw error; }
    this.tickTimer = setInterval(() => { if (this.socket === socket) this.tick(); }, TICK_INTERVAL_MS);
    this.emit('login', body);
    return body;
  }

  bumpSeqNo() {
    this.sendSeqNo = nextSeqNo(this.sendSeqNo);
    return this.sendSeqNo;
  }

  send(name, body) {
    if (!this.connected) throw new Error('not connected');
    const seq = this.bumpSeqNo();
    const frame = this.codec.encode(name, seq, body || {});
    this.emit('frame', { dir: 'out', name, seq, bytes: frame, body });
    this.socket.send(frame);
    return seq;
  }

  sendNoSeq(name, body) {
    if (!this.connected) return false;
    const frame = this.codec.encode(name, 0, body || {});
    this.emit('frame', { dir: 'out', name, seq: 0, bytes: frame, body });
    this.socket.send(frame);
    return true;
  }

  // 页面只读请求插在队列任务的两次请求之间：先拦住新的普通请求，等在途请求都有结果再发送。
  // PromptResponse 没有请求编号，必须保持同一时刻只有一方在途，拒绝才不会记到别的请求头上。
  // 只能用于不改变游戏状态的读取。
  interleaveRead(work) {
    const run = async () => {
      let open;
      this.readGate = new Promise((resolve) => { open = resolve; });
      const deadline = Date.now() + READ_GATE_LIMIT_MS;
      const release = () => { clearTimeout(limit); this.readGate = null; open(); };
      const limit = setTimeout(release, READ_GATE_LIMIT_MS);
      try {
        while (this.connected && Date.now() < deadline && (this.pending.length || this.watchers.length)) await sleep(5);
        return await readScope.run(this, work);
      } finally {
        release();
      }
    };
    const job = (this.readTail ?? Promise.resolve()).then(run, run);
    this.readTail = job;
    const clear = () => { if (this.readTail === job) this.readTail = null; };
    job.then(clear, clear);
    return job;
  }

  heldByRead() {
    return this.readGate !== null && readScope.getStore() !== this;
  }

  request(name, body, responseName = `${name.slice(0, -7)}Response`, timeout = 15000) {
    if (this.heldByRead()) return this.readGate.then(() => this.request(name, body, responseName, timeout));
    return new Promise((resolve, reject) => {
      const entry = { name, responseName, resolve, reject, timer: null, order: this.sendOrder };
      entry.timer = setTimeout(() => {
        this.pending = this.pending.filter((item) => item !== entry);
        reject(new Error(`timeout waiting for ${[responseName].flat().join(' or ')} (sent ${name})`));
      }, timeout);
      this.pending.push(entry);
      this.sendOrder += 1;
      try {
        this.send(name, body);
      } catch (error) {
        clearTimeout(entry.timer);
        this.pending = this.pending.filter((item) => item !== entry);
        reject(error);
      }
    });
  }

  // 有一部分请求服务端没有配套的 *Response，成功时静默，失败时只推一条 PromptResponse。
  // 这类请求用 sendWatch：发送后守着 prompt 一小段时间，守到了就是被拒，没守到就当作成功。
  sendWatch(name, body, { window = 350 } = {}) {
    if (this.heldByRead()) return this.readGate.then(() => this.sendWatch(name, body, { window }));
    const order = this.sendOrder;
    this.sendOrder += 1;
    const seq = this.send(name, body);
    return new Promise((resolve, reject) => {
      const watcher = { name, order, resolve, reject, timer: null };
      watcher.timer = setTimeout(() => {
        this.watchers = this.watchers.filter((item) => item !== watcher);
        resolve({ sent: seq, name });
      }, window);
      this.watchers.push(watcher);
    });
  }

  // PromptResponse has no request ID. NO_GUILD can only belong to an
  // operation requiring membership. A late guild prompt need not match any
  // current send. Other prompts keep their ordinary send-order attribution.
  attributePrompt(body) {
    const promptName = this.promptNames[body?.prompt];
    const reason = (body?.args ?? []).join(' ') || `prompt=${body?.prompt}${promptName ? ' ' + promptName : ''}${promptName === 'NO_GUILD' ? '（未加入联盟）' : ''}`;
    const error = new Error(`server prompt: ${reason}`);
    error.prompt = body;
    const firstEligible = entries => promptName === 'NO_GUILD'
      ? entries.find(entry => MEMBER_REQUESTS.has(entry.name)) : entries[0];
    const pendingEntry = firstEligible(this.pending);
    const firstWatch = firstEligible(this.watchers);
    const watcher = firstWatch && (!pendingEntry || firstWatch.order < pendingEntry.order) ? firstWatch : null;
    if (watcher) {
      this.watchers = this.watchers.filter((item) => item !== watcher);
      clearTimeout(watcher.timer);
      error.request = watcher.name;
      watcher.reject(error);
      return;
    }
    if (pendingEntry) {
      this.pending.splice(this.pending.indexOf(pendingEntry), 1);
      clearTimeout(pendingEntry.timer);
      error.request = pendingEntry.name;
      pendingEntry.reject(error);
    }
  }

  sendPing(timestamp) {
    // 重试保留旧 nonce，迟到的有效应答仍能确认连接；连续失败最多保留三项。
    while (this.pingAttempts.has(timestamp)) timestamp++;
    this.lastPingTimestamp = timestamp;
    this.pingAttempts.set(timestamp, this.heartbeatNow());
    if (!this.sendNoSeq('PingRequest', { clientTimestamp: timestamp })) {
      this.pingAttempts.delete(timestamp);
      this.lastPingTimestamp = 0;
    }
  }

  tryHandlePong(body) {
    if (!this.lastPingTimestamp) return false;
    // The server echoes our timestamp back as an int64, which decodes to the
    // long-form { low, high } object when no Long library is installed.
    const echoed = toNumber(body?.clientTimestamp);
    const sentAt = this.pingAttempts.get(echoed);
    if (sentAt === undefined) return false;
    const now = Date.now();
    this.lastPingTimestamp = 0;
    const sample = 0.4 * (this.heartbeatNow() - sentAt) + 0.6 * this.latencyMs;
    this.pingAttempts.clear();
    this.latencyMs = Math.round(Math.max(sample, 0));
    this.serverClockOffsetMs = Math.round(toNumber(body.serverTimestamp) - now + sample / 2);
    this.emit('pong', { latencyMs: this.latencyMs, offsetMs: this.serverClockOffsetMs });
    return true;
  }

  onMessage(data) {
    let decoded;
    try {
      decoded = this.codec.decode(data);
    } catch (error) {
      this.failConnection(`服务器消息解码失败：${error.message}`, 'protocol');
      return;
    }
    this.lastResponseAt = Date.now();
    const { seq, name, body } = decoded;
    if (name === 'PingResponse') { this.tryHandlePong(body); return; }

    // The server can report a terminal failure precisely because a sequence is
    // missing. Handle it before rejecting out-of-order business responses.
    if (name === 'ResendFailed' || name === 'SCChannelExpired') {
      this.emit('fatal', { reason: name, seqNo: body.seqNo, detail: body.reason });
      this.failConnection(name === 'ResendFailed' ? '服务器无法重传缺失消息，请重新连接' : '游戏会话已失效，请重新连接', name === 'ResendFailed' ? 'sequence-gap' : 'kicked');
      return;
    }
    if (!this.handleSeqNo(seq, name)) return;
    if (decoded.skipped) {
      if (!this.warnedAboutSkippedPush) {
        this.warnedAboutSkippedPush = true;
        this.emit('warn', `当前协议缺少 ${name}，已跳过该推送内容并继续等待业务响应`);
      }
      return;
    }
    this.emit('message', { seq, name, body });
    // 业务拦截：服务端拒绝一个请求时不回 *Response，而是推一条 PromptResponse。
    // 不处理的话每次被拒都要干等满超时。
    if (name === 'PromptResponse') {
      this.emit('prompt', body);
      this.attributePrompt(body);
      return;
    }
    // 部分领奖请求的回包可能是 GotRewardResponse 或 OkResponse，调用方会传回包名数组。
    const index = this.pending.findIndex((item) =>
      Array.isArray(item.responseName) ? item.responseName.includes(name) : item.responseName === name);
    if (index >= 0) {
      const [entry] = this.pending.splice(index, 1);
      clearTimeout(entry.timer);
      entry.resolve(body);
    }
  }

  handleSeqNo(seq, name) {
    if (seq > 0 && seq <= MAX_SEQ) {
      if (this.recvSeqNo === null) {
        this.recvSeqNo = seq;
      } else if (seq !== nextSeqNo(this.recvSeqNo)) {
        if (isSeqNoInRange(seq, this.recvSeqNo)) {
          this.ack(this.recvSeqNo);
          this.emit('drop', { reason: 'duplicate', name, seq, recvSeqNo: this.recvSeqNo });
        } else {
          if (!this.gapTimer) {
            this.emit('drop', { reason: 'gap', name, seq, recvSeqNo: this.recvSeqNo });
            this.sendNack(this.recvSeqNo);
            let retries = 0;
            this.gapTimer = setInterval(() => {
              if (++retries < 3) this.sendNack(this.recvSeqNo);
              else this.failConnection(`缺少服务器消息序号 ${nextSeqNo(this.recvSeqNo)}，重传未恢复，请重新连接`, 'sequence-gap');
            }, 1000);
          }
        }
        return false;
      } else {
        clearInterval(this.gapTimer);
        this.gapTimer = null;
        this.recvSeqNo = seq;
        this.ack(seq);
      }
    }
    return true;
  }

  ack(seq) {
    if (this.nextAckSeqNo === null) {
      this.nextAckSeqNo = seq;
    } else if (!isSeqNoInRange(seq, this.nextAckSeqNo)) {
      this.nextAckSeqNo = seq;
    }
    if (this.ackTimer === null) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        if (this.nextAckSeqNo !== null) {
          this.sendNoSeq('Ack', { seqNo: this.nextAckSeqNo });
          this.nextAckSeqNo = null;
        }
      }, ACK_DELAY_MS);
    }
  }

  sendNack(seqNo) {
    this.sendNoSeq('Nack', { seqNo });
  }

  tick() {
    if (!this.stopping && this.connected) {
      try {
        if (this.lastPingTimestamp > 0) {
          if (this.heartbeatNow() - this.pingAttempts.get(this.lastPingTimestamp) >= PING_TIMEOUT_MS) {
            if (this.pingAttempts.size >= MAX_MISSED_PINGS) this.failConnection('连续心跳无应答，连接已断开', 'heartbeat-timeout');
            else {
              this.emit('warn', '心跳应答延迟，正在重新探测（' + this.pingAttempts.size + '/' + MAX_MISSED_PINGS + '）');
              this.sendPing(Date.now());
            }
          }
        } else {
          this.sendPing(Date.now());
        }
      } catch (error) { this.failConnection('发送心跳失败：' + error.message, 'network'); }
    }
    this.emit('tick', this.snapshot());
  }

  snapshot() {
    return {
      state: this.state,
      url: this.url,
      connected: this.connected,
      latencyMs: this.latencyMs,
      offsetMs: this.serverClockOffsetMs,
      sendSeqNo: this.sendSeqNo,
      recvSeqNo: this.recvSeqNo,
      lastResponseAt: this.lastResponseAt,
    };
  }

  discardSocket(reason) {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onopen = null;
    try {
      socket.close(4001, reason);
    } catch {
      /* already closing */
    }
  }

  onClose(event) {
    this.closeReason ??= 'network';
    this.releaseRequests(`游戏连接已断开（${event?.code ?? ''}）`);
    this.socket = null;
    this.emit('close', { code: event?.code, reason: event?.reason, cause: this.closeReason });
    if (!this.stopping) this.setState('CLOSED', `code=${event?.code ?? ''}`);
  }

  releaseRequests(reason) {
    clearInterval(this.gapTimer);
    this.gapTimer = null;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.tickTimer = null;
    this.ackTimer = null;
    this.lastPingTimestamp = 0;
    this.pingAttempts.clear();
    this.nextAckSeqNo = null;
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    for (const watcher of this.watchers.splice(0)) {
      clearTimeout(watcher.timer);
      watcher.reject(new Error(reason));
    }
  }

  failConnection(reason, cause = 'network') {
    if (this.stopping || (!this.socket && this.closeReason)) return;
    this.closeReason = cause;
    this.emit('warn', reason);
    this.releaseRequests(reason);
    this.discardSocket('connectionLost');
    this.emit('close', { reason, cause });
    this.setState('CLOSED', reason);
  }

  stop() {
    this.stopping = true;
    this.closeReason = 'stopped';
    this.loginAbort?.();
    this.releaseRequests('client stopped');
    this.discardSocket('stop');
    this.setState('STOPPED');
  }
}
