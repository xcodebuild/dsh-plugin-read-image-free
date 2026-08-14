# dsh-plugin-read-image-free

dsh web 插件，两个能力：

## 1. 图片路径转发（不再提示「当前模型不支持图片」）

发送带图片的消息时，插件在 `session.prompt` / `subagent.prompt` 入口处拦截：

1. 用与核心相同的规则（数量 / 总字节 / 单张字节 / 像素上限，内容寻址去重）
   把图片保存到 `$DSH_HOME/attachments/v1/objects/<sha256[:2]>/`；
2. 给存储对象建带扩展名的硬链接（`<sha256>.png/.jpg/.webp/.gif`）；
3. 把每个图片块改写成**只有绝对路径**的文本块（带扩展名）交给原始 handler ——
   内容里不再有图片块，`MODEL_DOES_NOT_SUPPORT_IMAGES` 等拒绝检查不会触发。

超限 / 非法图片仍按核心 `attachment-error` + 原 reason 返回，提示不变。

## 2. read_image_free 工具（内化 image-read-free 技能）

注册一个模型可直接调用的动态工具 `read_image_free`：读取本地图片，以 base64
调用**智谱 GLM-4.1V-Thinking-Flash**（OpenAI 兼容接口，免费）做：

- OCR 文字提取（文档、截图、表格、海报、代码…）
- 画面描述（照片、插画、UI、图表、表情包…）
- 图中文字翻译、表格提取、UI 复刻、图中内容问答

模型无需再依赖 image-read-free 技能指令；工具对不支持图片输入的模型同样可用。

参数：`file_path`（图片绝对路径，必填）、`prompt`（本次要提取/回答什么，可选，
默认自动分析）。

### Key 配置（优先级从高到低）

1. 插件行 `config.apiKey`（见下方示例）
2. 环境变量 `IMAGE_READER_API_KEY`
3. `~/.config/image-read-free/config.json`（与旧技能脚本共用，已有 key 无需迁移）

免费申请：https://bigmodel.cn/apikey/platform

## 安装 / 更新

```bash
cd ~/.dsh/profiles/web
pnpm add file:/Users/xcodebuild/code/dsh-plugin-read-image-free
```

`cordis.patch.yml` 追加（`?v=` 数字每次改插件代码后递增，可热加载新代码，
无需重启）：

```yaml
- insert:
    - id: read-image-free
      name: 'file:///Users/xcodebuild/code/dsh-plugin-read-image-free/lib/index.js?v=4'
      config:
        # apiKey: '你的智谱KEY'   # 可选；不填则读环境变量 / config.json
```

## 卸载

```bash
cd ~/.dsh/profiles/web
pnpm remove dsh-plugin-read-image-free
# 从 cordis.patch.yml 删除对应 insert 行
```

## 验证

```bash
cd ~/.dsh/profiles/web
node -e "import('dsh-plugin-read-image-free').then(m => console.log(m.default.name))"
```
