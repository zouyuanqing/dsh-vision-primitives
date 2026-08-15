# dsh-vision-primitives

**Native interactive visual-reasoning plugin for DeepSeek Harness (DSH).**

给纯文本智能体装上"精确的眼睛":以 **Set-of-Mark 编号网格 + 确定性像素坐标数学** 为核心,让 Harness 智能体对屏幕/图片做精确到像素的视觉交互推理 —— 全程零外部 MCP 服务器,视觉推理内核 100% 在 DSH Host 运行时内以纯 JS 执行。

Design inspired by [vision-primitives-mcp](https://github.com/zouyuanqing/vision-primitives-mcp), re-implemented as a **native DSH plugin** (official profile bundle: host half + WebUI client half).

## 特性

| | |
|---|---|
| 🧠 **智能体即视觉模型** | 插件产出图片路径 + 确定性坐标数学;Harness 多模态智能体(或内置 MiMo 后端)看图决策,插件把"模糊感知"换算成"精确像素" |
| 🎯 **SOM 编号网格** | `vision_grid` 叠加编号网格 → `vision_resolve(cell)` 得格子中心精确坐标,消除视觉模型坐标误差 |
| 🔍 **局部无损放大** | `vision_zoom` 最近邻放大(像素级保真),保留到原帧的坐标映射链 |
| 📐 **几何验证** | `vision_annotate` / `vision_measure` / `vision_diff` / `vision_find_color` / `vision_ocr` 确定性验证 |
| 🖥️ **MiMo V2.5 后端** | `vision_describe` / `vision_locate`(多模态理解 + 视觉定位),并注册 `mimo` 模型路由(LlmAdapter,流式/函数调用/图像输入全支持) |
| 📋 **聊天框贴图(paste-to-path)** | 纯文本模型下聊天框粘贴图片 → 自动转为"文件路径 + MiMo 内容摘要"文本注入(社区 paste-to-path 方案原生实现);视觉模型(如 mimo-v2.5)保持原生图片附件不受影响 |
| 🧱 **最小 OS 边界** | 仅截屏 / OCR / 二进制落盘 3 类走 Host 原生 `subprocess` 服务调用 Windows PowerShell 系统脚本;不含桌面键鼠控制 |
| 🔒 **零硬编码密钥** | MiMo API key 从 DSH credentials 惰性读取,不写入源码 |

## 安装(官方 profile bundle 方式)

纯 JS 包,无 build 脚本,无需 pnpm `allowBuilds` 许可:

```sh
dsh plugin --profile <name> add github:zouyuanqing/dsh-vision-primitives
```

然后启动 DSH 即可;插件注册 `vision_*` 工具集到当前会话。

> 也支持 `github:zouyuanqing/dsh-vision-primitives#<commit-sha>` 固定版本安装。
> 该包同时是一个 npm 包(`dsh-vision-primitives`),`dsh plugin add dsh-vision-primitives` 也可。

## 配置 MiMo 后端(可选)

`vision_describe` / `vision_locate` 与 `mimo` 模型路由需要 MiMo API key:

```sh
dsh credentials set MIMO_API_KEY <your-key>
```

模型:`mimo-v2.5`(Xiaomi 官方 API,OpenAI 兼容,1M 上下文,全模态理解)。未配置 key 时,相关工具会给出明确报错提示;纯本地视觉原语(网格/缩放/标注/测量/差分/颜色/OCR)不需要任何 key。

## 工具集

| 工具 | 功能 |
|---|---|
| `vision_capture` | 截屏(全屏/区域,多显示器合并)或读取工作区 PNG → 会话帧 |
| `vision_grid` | Set-of-Mark 编号网格叠加,返回带编号图片 + 每格精确 box/center |
| `vision_resolve` | 格子/框/点 → 帧内精确像素坐标 + 绝对屏幕坐标,记为定位锚点 |
| `vision_zoom` | 局部无损放大(最近邻,像素级保真),保留到原帧的坐标映射链 |
| `vision_annotate` | box/point/cross/line/text 标注绘制(视觉验证) |
| `vision_measure` | 两点距离/位移/夹角,或框面积 |
| `vision_diff` | 帧差分(确定性变化检测):变化像素 bbox/比例 + 高亮图 |
| `vision_find_color` | 颜色分割 + 连通域(CV 像素级定位,零视觉模型) |
| `vision_ocr` | Windows 原生 OCR,返回词的文本框与帧/屏幕坐标(文本锚定) |
| `vision_describe` | MiMo 描述当前帧(多模态理解,需 API key) |
| `vision_locate` | MiMo 视觉定位,返回包围盒,自动反算原帧/屏幕坐标(需 API key) |
| `vision_state` / `vision_reset` | 会话状态查看 / 清空 |

## 配置(WebUI + CLI)

插件注册 `vision-primitives` 配置项,在 **设置 → 插件配置** 页出现 "Vision Primitives" 卡片,可配置:

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | 空 | MiMo API key(secret,经 credentials 域保存,不回显) |
| `baseUrl` | `https://api.xiaomimimo.com/v1` | MiMo OpenAI 兼容端点 |
| `model` | `mimo-v2.5` | 模型名 |
| `timeoutMs` | `300000` | 单次调用超时 |
| `pasteToPath` | `true` | 纯文本模型下聊天框贴图接管(路径+摘要文本) |
| `autoDescribe` | `true` | 粘贴图片自动生成 MiMo 内容摘要 |

也可用 CLI / 行配置:

```sh
# CLI 设置 API key(等价于 WebUI 卡片)
dsh credentials set MIMO_API_KEY <your-key>
```

插件行 `config`(cordis.patch.yml)作为配置 base 层:

```yaml
- insert:
    - id: vision-primitives
      name: dsh-vision-primitives
      config:
        baseUrl: https://api.xiaomimimo.com/v1
        model: mimo-v2.5
        timeoutMs: 300000
```

解析优先级:WebUI 用户设置 > 行配置 > 默认值;`apiKey` 先查设置再查 credentials。未配置 key 时,相关工具会给出明确报错提示;纯本地视觉原语(网格/缩放/标注/测量/差分/颜色/OCR)不需要任何 key。

## 聊天框图片输入(两种模式)

1. **视觉模型原生贴图**:会话模型切到 **MiMo V2.5**(支持 image 输入)后,聊天框可直接粘贴图片作为消息附件 —— 插件注册的 `mimo` 模型路由即为此服务
2. **纯文本模型 paste-to-path**:使用 deepseek 等纯文本模型时,聊天框粘贴图片会被插件接管(默认开启 `pasteToPath`),自动转为:
   ```
   C:\Users\<你>\.vispri\paste-xxx.png 【图片内容: <MiMo 摘要,需 API Key>】
   ```
   模型看到的是"文件路径 + 内容摘要"纯文本,可继续用 `read_image` / `vision_*` 工具深入处理;不再触发 "model does not support images" 报错。视觉模型粘贴不会被劫持(保持原生缩略图附件)

## 典型工作流(交互式图形推理协议)

```
vision_capture(screen|file) → vision_grid → read_image 选格
→ vision_resolve(cell) 得精确坐标 → vision_zoom 局部放大精修
→ vision_annotate / vision_measure / vision_ocr / vision_find_color 验证
→ vision_capture + vision_diff 变化检测
```

## 原生内核(纯 JS,已验证)

- **inflate**(RFC1951 全块类型:stored/fixed/dynamic)+ zlib 包装 —— 经 Node zlib 差分对拍 7/7 样本通过
- **PNG 编解码**(RGBA/灰度/调色板,8/16bit,5 种滤波器;编码用 stored-deflate)—— 2560×1600 真实截屏解码 ~60ms,编码回环逐字节一致
- CRC32/Adler32、最近邻缩放、5×7 点阵字体、SOM 网格、Bresenham 线、连通域分析、帧差分

## 运行测试

```sh
node kernel-test.js        # 内核自测(解码真实截屏 + 编码回环比对)
node inflate-diff-test.js  # inflate 与 Node zlib 差分对拍
```

## 文件

- `index.js` —— bundle Host 入口(官方 `defineTool` 门面 + 插件体加载 + settings 注册)
- `client.js` —— bundle Client 半部(WebUI 设置 → 插件配置 卡片)
- `plugin.host.js` —— 插件源码(与 DSH 动态插件沙箱 `code.host` 完全同一份)
- `mimo-client.cjs` —— node 子进程 SSE 客户端(直连 Xiaomi MiMo API)
- `cordis.patch.yml` —— bundle 补丁层
- `kernel-test.js` / `inflate-diff-test.js` / `smoke-test.mjs` —— 测试

## 已知限制

- 屏幕截取 / 原生 OCR 目前为 Windows 实现(PowerShell `Graphics.CopyFromScreen` / WinRT `OcrEngine`)
- 帧文件存储于 `sandboxPolicy.workspaceRoot/.vispri`
- 动态插件沙箱形态(`cordis_define` 创建的开发态插件)因审批策略为 `never` 无法激活 Client 半部,故 WebUI 配置卡片仅在 bundle 安装形态下可用;动态形态可用 CLI `dsh credentials set MIMO_API_KEY <key>` 配置

## License

[MIT](./LICENSE)
