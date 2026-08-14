// 单元测试：read_image_free 工具核心（analyzeImage）——本地 mock 智谱 API
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { analyzeImage, mediaTypeForPath, resolveReaderSettings } from '../lib/index.js';

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

const root = await mkdtemp(join(resolveDshHome(), 'reader-test-'));
const pngPath = join(root, 'red.png');
await writeFile(pngPath, PNG_1x1);

// mock 智谱 /chat/completions
let lastPayload = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastPayload = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          reasoning_content: '用户上传了一张 1x1 红色 PNG。',
          content: '这是一张纯红色的图片。',
        },
      }],
    }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v4`;

const settings = {
  baseUrl,
  apiKey: 'test-key',
  model: 'glm-4.1v-thinking-flash',
  timeoutMs: 5000,
  maxImageBytes: 10 * 1024 * 1024,
};

try {
  // 1. 正常调用：请求体契约正确 + 结果格式化
  const text = await analyzeImage({ path: pngPath, prompt: '图片里有什么？', settings, signal: undefined });
  check('result contains reasoning block', text.includes('【思考过程】') && text.includes('红色'));
  check('result contains analysis block', text.includes('【分析结果】'));
  check('payload model correct', lastPayload.model === 'glm-4.1v-thinking-flash');
  check('payload system prompt present', lastPayload.messages[0].role === 'system');
  const user = lastPayload.messages[1];
  check('payload user content is image+text', user.content[0].type === 'image_url' && user.content[1].type === 'text');
  check('payload image is base64 data URL with png mime',
    user.content[0].image_url.url.startsWith('data:image/png;base64,'));
  check('payload prompt carried through', user.content[1].text === '图片里有什么？');
  check('payload temperature low', lastPayload.temperature === 0.1);

  // 2. 无 Key → 指引错误
  let noKey = false;
  try {
    await analyzeImage({ path: pngPath, prompt: 'x', settings: { ...settings, apiKey: '' }, signal: undefined });
  } catch (e) { noKey = e.message.includes('未找到 API Key') && e.message.includes('bigmodel.cn'); }
  check('missing key raises guidance error', noKey);

  // 3. 文件不存在
  let missing = false;
  try {
    await analyzeImage({ path: join(root, 'nope.png'), prompt: 'x', settings, signal: undefined });
  } catch (e) { missing = e.message.includes('图片不存在'); }
  check('missing file raises clear error', missing);

  // 4. 超尺寸
  let oversized = false;
  try {
    await analyzeImage({ path: pngPath, prompt: 'x', settings: { ...settings, maxImageBytes: 1 }, signal: undefined });
  } catch (e) { oversized = e.message.includes('图片过大'); }
  check('oversized image raises clear error', oversized);

  // 5. HTTP 错误透传
  let httpErr = false;
  try {
    await analyzeImage({
      path: pngPath, prompt: 'x',
      settings: { ...settings, baseUrl: 'http://127.0.0.1:1/v4' },
      signal: undefined,
    });
  } catch (e) { httpErr = e.message.includes('网络错误'); }
  check('network failure raises clear error', httpErr);

  // 6. mediaTypeForPath
  check('mediaTypeForPath png', mediaTypeForPath('/a/b.png') === 'image/png');
  check('mediaTypeForPath jpg', mediaTypeForPath('/a/b.JPG') === 'image/jpeg');
  check('mediaTypeForPath gif', mediaTypeForPath('/a/b.gif') === 'image/gif');
  check('mediaTypeForPath unknown falls back png', mediaTypeForPath('/a/b.bin') === 'image/png');

  // 7. resolveReaderSettings 优先级（插件 config > 环境变量 > 配置文件 > 默认）
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const cfgDir = join(root, 'config');
  await import('node:fs/promises').then((fs) => fs.mkdir(join(cfgDir, 'image-read-free'), { recursive: true }));
  await writeFile(join(cfgDir, 'image-read-free', 'config.json'), JSON.stringify({
    base_url: 'https://file.example/v4',
    api_key: 'file-key',
    model: 'glm-4v-flash',
  }));
  process.env.XDG_CONFIG_HOME = cfgDir;
  const oldEnv = process.env.IMAGE_READER_API_KEY;
  delete process.env.IMAGE_READER_API_KEY;
  const fromFile = resolveReaderSettings({});
  check('file baseUrl picked up', fromFile.baseUrl === 'https://file.example/v4');
  check('file key picked up', fromFile.apiKey === 'file-key');
  check('file model picked up', fromFile.model === 'glm-4v-flash');
  process.env.IMAGE_READER_API_KEY = 'env-key';
  const withEnv = resolveReaderSettings({});
  check('env key beats file', withEnv.apiKey === 'env-key');
  const withPlugin = resolveReaderSettings({ apiKey: 'plugin-key', model: 'custom' });
  check('plugin config key beats env', withPlugin.apiKey === 'plugin-key');
  check('plugin config model beats file', withPlugin.model === 'custom');
  if (oldEnv === undefined) delete process.env.IMAGE_READER_API_KEY;
  else process.env.IMAGE_READER_API_KEY = oldEnv;
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
