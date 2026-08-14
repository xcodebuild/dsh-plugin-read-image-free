// apply() 接线测试：包装 session.prompt / subagent.prompt、错误映射、
// 自愈重装（apiProxy 实例替换）、卸载恢复
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  saveImageFile,
  validateImageFile,
} from '@deepseek-ai/dsh-attachment-local';
import plugin from '../lib/index.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok - ${name}`);
  else { failures += 1; console.error(`  FAIL - ${name} ${extra}`); }
}

const root = await mkdtemp(join(resolveDshHome(), 'attachments-test-'));
const limits = Object.freeze({
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
});
const attachments = {
  root,
  imageLimits: limits,
  async validateImage(input) { return validateImageFile(input, limits); },
  async saveImage(input) { return saveImageFile(root, input, limits); },
};

/** 构造一个 apiProxy 假实例（含 session/subagent prompt 桩）。 */
function makeApiProxy(sessionsSeen, subagentsSeen) {
  return {
    sessions: {
      async prompt(request) {
        sessionsSeen.push(request);
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } };
      },
    },
    subagents: {
      async prompt(request, signal) {
        subagentsSeen.push({ request, signal });
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } };
      },
    },
  };
}

/** 记录事件监听器，便于手动触发（模拟服务变更/配置更新）。 */
const listeners = new Map();
function fakeOn(name, handler) {
  const list = listeners.get(name) ?? [];
  list.push(handler);
  listeners.set(name, list);
  return () => {
    const l = listeners.get(name) ?? [];
    const i = l.indexOf(handler);
    if (i >= 0) l.splice(i, 1);
  };
}

let disposer = null;
let sessionsSeen = [];
let subagentsSeen = [];
let apiProxy = makeApiProxy(sessionsSeen, subagentsSeen);
const ctx = {
  get(name) {
    if (name === 'attachments') return attachments;
    if (name === 'apiProxy') return apiProxy;
    return undefined;
  },
  on: fakeOn,
  effect(cb) { disposer = cb(); return disposer; },
  tools: {
    register(tool) { check('tool registered: ' + tool.name, tool.name === 'read_image_free'); },
  },
  systemPrompt: {
    section(section) { check('systemPrompt section registered', section.name === 'tool:read-image-free'); },
  },
};

plugin.apply(ctx, {});

const imgReq = (rpcId, data, extra = {}) => ({
  rpcId,
  payload: {
    sessionId: 'session-1',
    mode: 'queue',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', mediaType: 'image/png', data, name: 'dot.png' },
    ],
    ...extra,
  },
});

try {
  // 1. session.prompt：图片块被改写，原 handler 收到纯文本 content
  const req = imgReq('rpc-1', PNG_1x1.toString('base64'));
  const resp = await apiProxy.sessions.prompt(req);
  check('session.prompt passthrough response', resp.result.ok === true);
  check('original handler called once', sessionsSeen.length === 1);
  const seen = sessionsSeen[0];
  check('rpcId preserved', seen.rpcId === 'rpc-1');
  check('sessionId preserved', seen.payload.sessionId === 'session-1');
  check('no image parts reach original handler', !seen.payload.content.some((p) => p.type === 'image'));
  const pathText = seen.payload.content[1]?.text;
  check('path text reaches original handler', typeof pathText === 'string' && pathText.startsWith('/') && pathText.includes(root) && pathText.endsWith('.png'));

  // 2. 纯文本消息不做任何改动（同一引用）
  const plain = { rpcId: 'rpc-2', payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } };
  await apiProxy.sessions.prompt(plain);
  check('plain text untouched', sessionsSeen[1].payload.content === plain.payload.content);

  // 3. subagent.prompt：同样改写，signal 透传
  const sub = {
    rpcId: 'rpc-3',
    payload: { parentSessionId: 'session-1', childSessionId: 'session-2', mode: 'continuable', content: [{ type: 'image', mediaType: 'image/png', data: PNG_1x1.toString('base64') }] },
  };
  const sig = { aborted: false };
  await apiProxy.subagents.prompt(sub, sig);
  check('subagent original called with signal', subagentsSeen[0]?.signal === sig);
  check('subagent content rewritten', !subagentsSeen[0]?.request.payload.content.some((p) => p.type === 'image'));

  // 4. 非法图片 → attachment-error wire 响应（含 reason）
  const bad = imgReq('rpc-4', '%%%');
  const badResp = await apiProxy.sessions.prompt(bad);
  check('invalid base64 maps to attachment-error', badResp.result.ok === false && badResp.result.error.code === 'attachment-error');
  check('reason code preserved', badResp.result.error.details.reason === 'INVALID_IMAGE_BASE64');
  check('original not called for bad image', sessionsSeen.length === 2);

  // 5. 自愈：apiProxy 实例被替换（include 热重载场景）→ 包装自动重挂到新实例
  const newSessionsSeen = [];
  const newSubagentsSeen = [];
  apiProxy = makeApiProxy(newSessionsSeen, newSubagentsSeen);
  for (const handler of listeners.get('internal/service') ?? []) handler('apiProxy', apiProxy);
  for (const handler of listeners.get('loader/config-update') ?? []) handler();
  const req2 = imgReq('rpc-5', PNG_1x1.toString('base64'));
  const resp2 = await apiProxy.sessions.prompt(req2);
  check('new instance prompt accepted after self-heal', resp2.result.ok === true);
  check('new instance content rewritten', newSessionsSeen.length === 1 && !newSessionsSeen[0].payload.content.some((p) => p.type === 'image'));
  const bad2 = imgReq('rpc-6', '%%%');
  const badResp2 = await apiProxy.sessions.prompt(bad2);
  check('new instance error mapping works', badResp2.result.error.details.reason === 'INVALID_IMAGE_BASE64');

  // 6. 卸载恢复：只还原本实例的包装（新实例的包装由新 fiber 负责，这里模拟本实例 dispose）
  disposer();
  const plain2 = { rpcId: 'rpc-7', payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } };
  const afterRestore = await apiProxy.sessions.prompt(plain2);
  check('restored handler still works', afterRestore.result.ok === true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
