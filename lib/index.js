/**
 * dsh-plugin-read-image-free — 图片路径转发 + 免费图片理解插件
 *
 * 两个能力：
 *
 * 1. 图片路径转发：dsh web 发送带图片的消息时，不再让核心的
 *    `session.prompt` / `subagent.prompt` 处理图片块（模型不支持图片时会被
 *    拒绝并提示「当前模型不支持图片，请切换支持图片的模型」），而是在入口处
 *    用与核心相同的校验与存储规则（`ctx.attachments`，内容寻址、去重）保存
 *    图片，建带扩展名的硬链接，再把每个图片块改写为「只有绝对路径」的文本块
 *    交给原始 handler。超限/非法图片仍以 `attachment-error` + 原 reason 返回。
 *
 * 2. read_image_free 工具（内化 image-read-free 技能）：注册一个模型可直接
 *    调用的动态工具，读取本地图片并以 base64 调用智谱 GLM-4.1V-Thinking-Flash
 *    （OpenAI 兼容接口，免费）做 OCR / 画面描述 / 表格提取 / UI 复刻 / 图中
 *    文字翻译 / 图中内容问答。模型无需再依赖 image-read-free 技能指令。
 *
 * Key 配置优先级（与技能脚本一致）：插件行 config.apiKey > 环境变量
 * IMAGE_READER_API_KEY > ~/.config/image-read-free/config.json。
 *
 * 卸载/HMR 时自动恢复被包装的 handler，工具随插件 fiber 自动注销。
 */
import { link, mkdir, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { AttachmentError } from '@deepseek-ai/dsh-attachment';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

/** Loader 诊断用的插件名。 */
export const name = 'read-image-free';

/** 硬依赖：api-gateway 就绪后激活；tools/systemPrompt 用于注册工具。 */
export const inject = ['apiProxy', 'tools', 'systemPrompt'];

/** 插件行可配置项（baseUrl/apiKey/model 不填则走文件/环境变量兜底；未 .required() 即可选）。 */
export const Config = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  timeoutMs: z.number().step(1).min(1000).default(180000),
  maxImageBytes: z.number().step(1).min(1).default(10 * 1024 * 1024),
});

// ── 第一部分：图片路径转发 ──────────────────────────────────────────────

/** 媒体类型 → 文件扩展名。 */
const MEDIA_TYPE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 严格解码浏览器上送的 base64（与核心 api-proxy 的 wire 校验一致）。
 * @param data - 客户端传来的 base64 字符串。
 * @returns 解码后的字节。
 */
export function decodeBase64(data) {
  const decoded = Buffer.from(data, 'base64');
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64');
  }
  return new Uint8Array(decoded);
}

/**
 * 内容寻址存储里某个 attachment 的绝对路径（与 dsh-attachment-local 的
 * objectPath 布局一致）：`<root>/objects/<sha256[:2]>/<sha256>`。
 * @param root - attachment 存储根目录（`$DSH_HOME/attachments/v1`）。
 * @param ref - saveImage 返回的持久化引用。
 * @returns 存储对象的绝对路径（无扩展名）。
 */
export function resolveStoredImagePath(root, ref) {
  const sha256 = String(ref.attachmentId).replace(/^sha256:/, '');
  return join(root, 'objects', sha256.slice(0, 2), sha256);
}

/**
 * 取附件存储根目录：优先读服务实例上的 `root`（LocalAttachmentStore 暴露的
 * 字段），缺失时按默认布局 `$DSH_HOME/attachments/v1` 兜底。
 * @param attachments - `ctx.attachments` 服务实例，可能为 undefined。
 * @returns 绝对根目录。
 */
export function attachmentRoot(attachments) {
  const root = attachments?.root;
  if (typeof root === 'string' && root.length > 0) return root;
  return join(resolveDshHome(), 'attachments', 'v1');
}

/**
 * 确保带扩展名的文件存在并返回其路径：给内容寻址对象建一个
 * `<sha256>.<ext>` 硬链接（同 inode，零拷贝）。链接已存在（EEXIST）视为成功；
 * 其他失败回退为无扩展名对象路径，保证模型拿到的路径一定真实可读。
 * @param root - attachment 存储根目录。
 * @param ref - saveImage 返回的持久化引用。
 * @returns 带扩展名的绝对路径（失败时回退为无扩展名路径）。
 */
export async function ensureImagePathWithExtension(root, ref) {
  const objectPath = resolveStoredImagePath(root, ref);
  const extension = MEDIA_TYPE_EXTENSIONS[ref.mediaType];
  if (extension === undefined) return objectPath;
  const linked = join(dirname(objectPath), `${ref.attachmentId.slice('sha256:'.length)}.${extension}`);
  try {
    await mkdir(dirname(linked), { recursive: true });
    await link(objectPath, linked);
  } catch (error) {
    if (error?.code !== 'EEXIST') return objectPath;
  }
  return linked;
}

/**
 * 把 prompt 内容里的图片块改写为「只有绝对路径」的文本块。
 *
 * 校验与存储规则对齐核心 `durablePromptContent`：数量上限、总字节上限、
 * `validateImage`（类型/像素上限）与 `saveImage`（单张字节上限），任何违规
 * 抛出的 AttachmentError 都带与核心相同的 reason 码，由调用方映射为
 * `attachment-error` wire 响应，客户端提示保持不变。
 * @param ctx - 插件作用域。
 * @param attachments - `ctx.attachments` 服务实例。
 * @param content - 请求 payload 的 content 数组。
 * @returns 改写后的 content（无 image 块）。
 */
export async function rewritePromptContent(ctx, attachments, content) {
  if (!content.some((part) => part.type === 'image')) return content;
  const limits = attachments?.imageLimits;
  const out = [];
  let imageCount = 0;
  let totalBytes = 0;
  for (const part of content) {
    if (part.type !== 'image') {
      out.push(part);
      continue;
    }
    imageCount += 1;
    if (limits !== undefined && imageCount > limits.maxImagesPerMessage) {
      throw new AttachmentError('Prompt exceeds the configured image-count limit.', 'TOO_MANY_IMAGES');
    }
    const data = decodeBase64(part.data);
    totalBytes += data.byteLength;
    if (limits !== undefined && totalBytes > limits.maxMessageImageBytes) {
      throw new AttachmentError('Prompt exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE');
    }
    const meta = part.name === undefined ? {} : { name: part.name };
    let path;
    if (attachments !== undefined) {
      await attachments.validateImage({ data, mediaType: part.mediaType, ...meta });
      const ref = await attachments.saveImage({ data, mediaType: part.mediaType, ...meta });
      path = await ensureImagePathWithExtension(attachmentRoot(attachments), ref);
    }
    out.push({ type: 'text', text: path ?? '（无法保存图片）' });
  }
  return out;
}

// 包装自愈机制：include 树更新（如改 cordis.patch.yml 热重载）会重启
// api-gateway 行，apiProxy 服务实例被替换后，旧实例上的包装随之失效。因此
// 不只在 apply 时包装一次，而是监听 apiProxy 服务变更与 loader/config-update，
// 在每次变更后把包装重新挂到「当前」实例上（幂等）。
// LINEAGE 用 Symbol.for 全局标记「我们这一类」的包装，install 时先剥掉旧链；
// MY_WRAPPER 用模块私有 Symbol 标识「本模块实例」的包装，dispose 只还原自己的。
const LINEAGE = Symbol.for('dsh-plugin-read-image-free.wrapper');
const ORIGINAL_HANDLER = Symbol('dsh-plugin-read-image-free.original');
const MY_WRAPPER = Symbol('dsh-plugin-read-image-free.my');

/** 与核心 err() 一致的 attachment-error wire 响应。 */
function attachmentErrorResponse(request, error) {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: 'attachment-error',
        message: error.message,
        details: { reason: error.code },
      },
    },
  };
}

/** 剥掉同门包装链，取最初的原始 handler。 */
function unwrapLineage(handler) {
  let current = handler;
  while (current !== undefined && current[LINEAGE] === true) current = current[ORIGINAL_HANDLER];
  return current;
}

/** 构造一个图片块 → 路径文本块的 prompt 包装（捕获原始 handler）。 */
function makePromptWrapper(handler, ctx, attachments) {
  const wrapper = async (request, signal) => {
    const payload = request?.payload;
    if (
      payload === undefined ||
      !Array.isArray(payload.content) ||
      !payload.content.some((part) => part.type === 'image')
    ) {
      return handler(request, signal);
    }
    try {
      const content = await rewritePromptContent(ctx, attachments, payload.content);
      return handler({ ...request, payload: { ...payload, content } }, signal);
    } catch (error) {
      if (error instanceof AttachmentError) return attachmentErrorResponse(request, error);
      throw error;
    }
  };
  Object.defineProperty(wrapper, LINEAGE, { value: true });
  Object.defineProperty(wrapper, ORIGINAL_HANDLER, { value: handler });
  Object.defineProperty(wrapper, MY_WRAPPER, { value: true });
  return wrapper;
}

/** 把包装幂等挂到当前 apiProxy 实例的 session/subagent prompt 上。 */
function installPromptWrappers(ctx, attachments) {
  const api = ctx.get('apiProxy');
  if (api === undefined) return;
  const sessions = api.sessions;
  const subagents = api.subagents;
  if (sessions?.prompt === undefined || subagents?.prompt === undefined) return;
  sessions.prompt = makePromptWrapper(unwrapLineage(sessions.prompt), ctx, attachments);
  subagents.prompt = makePromptWrapper(unwrapLineage(subagents.prompt), ctx, attachments);
}

/** 卸载时恢复：只当当前 handler 仍是本模块实例的包装时才还原。 */
function restorePromptWrappers(ctx) {
  const api = ctx.get('apiProxy');
  if (api === undefined) return;
  for (const obj of [api.sessions, api.subagents]) {
    const current = obj?.prompt;
    if (current !== undefined && current[MY_WRAPPER] === true) obj.prompt = unwrapLineage(current);
  }
}

// ── 第二部分：read_image_free 工具（内化 image-read-free 技能） ─────────

/** 与技能脚本一致的默认自动分析提示词。 */
export const DEFAULT_PROMPT = (
  '请分析这张图片：\n'
  + '1. 如果图片包含文字（文档、截图、表格、海报、菜单、代码、票据等），'
  + '请完整、逐字提取所有文字内容，尽量保持原有排版结构（标题、段落、行列）；\n'
  + '2. 如果图片以画面为主（照片、插画、UI 界面、表情包、图表等），'
  + '请详细描述画面内容，包括主体、背景、颜色、构图、风格等；\n'
  + '3. 如果图文混合，请先给出文字提取结果，再给出画面描述。\n'
  + '直接输出分析结果，不要复述本指令。'
);

/** 技能脚本默认端点与模型。 */
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.1v-thinking-flash';

/** 技能脚本的配置文件名（兼容既有配置，无需迁移）。 */
export function readerConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ?? join(homedir(), '.config'), 'image-read-free', 'config.json');
}

/** 读取技能脚本的配置文件（~/.config/image-read-free/config.json）。 */
export function loadReaderConfigFile() {
  try {
    const raw = readFileSync(readerConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      baseUrl: typeof parsed.base_url === 'string' ? parsed.base_url : undefined,
      apiKey: typeof parsed.api_key === 'string' ? parsed.api_key : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * 合并解析读取器设置：插件行 config > 环境变量 > 配置文件 > 默认值。
 * @param config - 插件行配置（已过 schema 校验）。
 * @returns 解析后的设置。
 */
export function resolveReaderSettings(config) {
  const file = loadReaderConfigFile();
  const envKey = (process.env.IMAGE_READER_API_KEY ?? '').trim();
  return {
    baseUrl: ((config.baseUrl ?? '').trim() || file.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    apiKey: (config.apiKey ?? '').trim() || envKey || file.apiKey || '',
    model: (config.model ?? '').trim() || file.model || DEFAULT_MODEL,
    timeoutMs: config.timeoutMs,
    maxImageBytes: config.maxImageBytes,
  };
}

/** 扩展名 → 媒体类型（与 read_image 工具一致）。 */
const PATH_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 由路径扩展名推断媒体类型；未知回退 image/png。 */
export function mediaTypeForPath(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return PATH_MEDIA_TYPES[ext] ?? 'image/png';
}

/** Key 缺失时的指引（提示用户如何配置，而不是让模型瞎试）。 */
export function keyHelpText() {
  return '未找到 API Key。请通过以下任一方式配置后重试：\n'
    + '1. 在 web profile 的 cordis.patch.yml 中给 read-image-free 插件行加 config.apiKey；\n'
    + `2. 写入 ${readerConfigPath()}（{"api_key": "你的KEY"}）；\n`
    + '3. 设置环境变量 IMAGE_READER_API_KEY。\n'
    + '免费申请：https://bigmodel.cn/apikey/platform';
}

/**
 * 调用智谱多模态接口分析一张本地图片（内化技能脚本 image_reader.py 的逻辑）。
 * @param options - 图片路径、提示词、解析后的设置与中止信号。
 * @returns 分析文本（含【思考过程】与【分析结果】）。
 */
export async function analyzeImage({ path, prompt, settings, signal }) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`[error] 图片不存在: ${path}`);
  }
  if (!info.isFile()) throw new Error(`[error] 不是文件: ${path}`);
  if (info.size > settings.maxImageBytes) {
    throw new Error(`[error] 图片过大（${info.size} 字节，上限 ${settings.maxImageBytes}）`);
  }
  if (settings.apiKey.length === 0) throw new Error(keyHelpText());
  const mediaType = mediaTypeForPath(path);
  const base64 = (await readFile(path)).toString('base64');
  const dataUrl = `data:${mediaType};base64,${base64}`;
  const payload = {
    model: settings.model,
    messages: [
      { role: 'system', content: '你是一个专业的图像理解助手，擅长 OCR 文字提取与图像内容描述，回答准确、结构清晰。' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    temperature: 0.1,
  };
  const url = `${settings.baseUrl}/chat/completions`;
  const abort = new AbortController();
  const onParentAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('timeout')), settings.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (error) {
    if (abort.signal.aborted) throw new Error('[error] 请求已取消或超时');
    throw new Error(`[error] 网络错误: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[error] HTTP ${response.status}: ${body.slice(0, 2000)}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('[error] 响应不是合法 JSON');
  }
  const message = data?.choices?.[0]?.message;
  const content = (message?.content ?? '').trim();
  const reasoning = (message?.reasoning_content ?? '').trim();
  if (content.length === 0) throw new Error('[error] 模型未返回内容，请重试');
  return reasoning.length > 0 ? `【思考过程】\n${reasoning}\n\n【分析结果】\n${content}` : content;
}

/** 注册 read_image_free 工具与系统提示词指引。 */
function applyReadImageFreeTool(ctx, config) {
  ctx.systemPrompt.section({
    name: 'tool:read-image-free',
    order: 200,
    text: 'Use the read_image_free tool — not read_image — when the current model cannot view images directly (no image input). '
      + 'It analyzes a local image file through an external vision API: OCR text extraction, scene description, table extraction, '
      + 'UI reproduction, translating text inside an image, or answering questions about the image. '
      + 'Pass the absolute image path and a prompt describing what to extract or answer.',
  });
  ctx.tools.register(defineTool({
    name: 'read_image_free',
    description: 'Analyze a local image file (PNG/JPEG/WebP/GIF) through an external vision API: extract text (OCR), describe the scene, '
      + 'translate text in the image, extract tables, describe UI for reproduction, or answer questions about the image. '
      + 'Works even when the current model does not support image input.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the image file.',
      },
      prompt: {
        type: 'string',
        description: 'What to extract or answer about the image. Defaults to automatic analysis (OCR + scene description).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            required: true,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = String(args.file_path ?? '').trim();
      if (path.length === 0) throw new Error('file_path must be a non-empty string');
      const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
        ? args.prompt.trim()
        : DEFAULT_PROMPT;
      const settings = resolveReaderSettings(config);
      const text = await analyzeImage({ path, prompt, settings, signal: exec.signal });
      return { text };
    },
  }));
}

/**
 * 插件入口：注册 read_image_free 工具 + 包装 prompt handler（图片 → 路径）。
 * 包装自愈：apiProxy 服务实例变更（include 热重载会重启 api-gateway）或
 * loader 配置更新后自动重新挂载；卸载时只还原本实例的包装；工具随 fiber 注销。
 */
export const apply = (ctx, config) => {
  const attachments = ctx.get('attachments');
  if (attachments === undefined) return;

  applyReadImageFreeTool(ctx, config);
  installPromptWrappers(ctx, attachments);

  const onService = (name) => {
    if (name === 'apiProxy') installPromptWrappers(ctx, attachments);
  };
  const onConfigUpdate = () => installPromptWrappers(ctx, attachments);
  const offService = ctx.on('internal/service', onService);
  const offConfigUpdate = ctx.on('loader/config-update', onConfigUpdate);

  ctx.effect(() => () => {
    offService();
    offConfigUpdate();
    restorePromptWrappers(ctx);
  }, 'read-image-free handler restoration');
};

const plugin = { name, inject, Config, apply };
export default plugin;
