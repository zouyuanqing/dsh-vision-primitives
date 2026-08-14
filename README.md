# dsh-vision-primitives

**Native interactive visual-reasoning plugin for DeepSeek Harness (DSH).**

给纯文本智能体装上"精确的眼睛":以 **Set-of-Mark 编号网格 + 确定性像素坐标数学** 为核心,让 Harness 智能体对屏幕/图片做精确到像素的视觉交互推理 —— 全程零外部 MCP 服务器,视觉推理内核 100% 在 DSH Host 运行时内以纯 JS 执行。

Design inspired by [vision-primitives-mcp](https://github.com/zouyuanqing/vision-primitives-mcp), re-implemented as a **native DSH plugin** (dynamic Cordis plugin, Host-only package).

## 特性

| | |
|---|---|
| 🧠 **智能体即视觉模型** | 插件产出图片路径 + 确定性坐标数学;Harness 多模态智能体(或内置 MiMo 后端)看图决策,插件把"模糊感知"换算成"精确像素" |
| 🎯 **SOM 编号网格** | `vision_grid` 叠加编号网格 → `vision_resolve(cell)` 得格子中心精确坐标,消除视觉模型坐标误差 |
| 🔍 **局部无损放大** | `vision_zoom` 最近邻放大(像素级保真),保留到原帧的坐标映射链 |
| 📐 **几何验证** | `vision_annotate` / `vision_measure` / `vision_diff` / `vision_find_color` / `vision_ocr` 确定性验证 |
| 🖥️ **MiMo V2.5 后端** | `vision_describe` / `vision_locate`(多模态理解 + 视觉定位),并注册 `mimo` 模型路由(LlmAdapter,流式/函数调用/图像输入全支持) |
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

- `index.js` —— bundle 入口(官方 `defineTool` 门面 + 插件体加载)
- `plugin.host.js` —— 插件源码(与 DSH 动态插件沙箱 `code.host` 完全同一份)
- `mimo-client.cjs` —— node 子进程 SSE 客户端(直连 Xiaomi MiMo API)
- `cordis.patch.yml` —— bundle 补丁层
- `kernel-test.js` / `inflate-diff-test.js` —— 内核测试

## 已知限制

- 屏幕截取 / 原生 OCR 目前为 Windows 实现(PowerShell `Graphics.CopyFromScreen` / WinRT `OcrEngine`)
- 帧文件存储于 `sandboxPolicy.workspaceRoot/.vispri`
- 插件为 Host-only 包(无 Client UI 半部)

## License

[MIT](./LICENSE)
