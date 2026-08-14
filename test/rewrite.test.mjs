// 单元测试：图片路径转发（真实 dsh-attachment-local 存储 + 真实 PNG）
// 注意：测试根目录放在 $DSH_HOME 下，避免 macOS /var/folders 上 chmod EPERM。
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
import { rewritePromptContent, resolveStoredImagePath } from '../lib/index.js';

// 1x1 红色 PNG
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

try {
  // 1. 纯文本内容原样返回
  {
    const content = [{ type: 'text', text: 'hi' }];
    const out = await rewritePromptContent({}, attachments, content);
    check('text-only content passes through unchanged', out === content);
  }

  // 2. 图片块 -> 文本块（内容就是带扩展名的绝对路径），且文件真实落盘
  {
    const content = [
      { type: 'text', text: '看这张图' },
      { type: 'image', mediaType: 'image/png', data: PNG_1x1.toString('base64'), name: 'dot.png' },
    ];
    const out = await rewritePromptContent({}, attachments, content);
    check('no image blocks remain', out.every((p) => p.type === 'text'));
    const textBlock = out[1];
    const path = textBlock.text;
    check('text block is exactly the absolute path', typeof path === 'string' && path.startsWith('/'), String(path));
    check('path has the .png extension', path.endsWith('.png'), String(path));
    check('path does not carry extra prose', !path.includes('用户上传') && !path.includes('read'), String(path));
    if (path) {
      const exists = await import('node:fs/promises').then((fs) => fs.stat(path).then(() => true, () => false));
      check('file exists at the referenced path (with extension)', exists, String(path));
    }
    // 引用格式与存储布局一致
    const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' };
    check('stored path layout matches objects/<2>/<sha>',
      resolveStoredImagePath(root, ref) === join(root, 'objects', 'aa', 'a'.repeat(64)));
  }

  // 3. 数量上限仍生效
  {
    const content = [
      { type: 'image', mediaType: 'image/png', data: PNG_1x1.toString('base64') },
      { type: 'image', mediaType: 'image/png', data: PNG_1x1.toString('base64') },
    ];
    let threw = false;
    try {
      await rewritePromptContent({}, { ...attachments, imageLimits: { ...limits, maxImagesPerMessage: 1 } }, content);
    } catch (e) { threw = e.code === 'TOO_MANY_IMAGES'; }
    check('TOO_MANY_IMAGES enforced', threw);
  }

  // 4. 非规范 base64 报 INVALID_IMAGE_BASE64
  {
    let threw = false;
    try {
      await rewritePromptContent({}, attachments, [{ type: 'image', mediaType: 'image/png', data: 'not base64!!' }]);
    } catch (e) { threw = e.code === 'INVALID_IMAGE_BASE64'; }
    check('INVALID_IMAGE_BASE64 enforced', threw);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
