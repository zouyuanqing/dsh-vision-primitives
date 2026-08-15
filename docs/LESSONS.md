# dsh-vision-primitives 开发经验总结(Lessons Learned)

> 从动态插件原型到官方 bundle 发布的全过程复盘。每一条都对应一次真实踩坑。

## 一、项目成果(v1.0.0 → v1.6.1)

- 14 个 `vision_*` 工具:纯 JS 视觉内核(PNG 编解码/RFC1951 inflate/SOM 网格/连通域/帧差分)+ MiMo V2.5 后端(VEP 视觉证据协议)+ Windows OCR/截屏
- 三种聊天框图片输入模式:视觉模型原生直发 / **发送时图片桥接**(默认,缓存→地址给模型)/ paste-to-path(默认关闭)
- WebUI 配置卡片(官方折叠样式、主题安全、7 个配置项)
- 官方规范发布:bundle 格式、`dsh-plugin` topic、12+ 个 GitHub Release、官方 Discussions 帖

## 二、架构经验

1. **一份代码两种形态**:`plugin.host.js` 是动态沙箱函数体;`index.js` 用 `new Function('ctx','harness', ...)` 包装同一份代码,`harness` 门面把 `defineTool/registerTool` 翻译成官方 `@deepseek-ai/dsh-tools` + `ctx.tools`。两种环境行为一致。
2. **服务就绪回调 > 一次性探测**:`ctx.inject([...], cb)` 是官方推荐模式(`installSettingsSection` 同款);`ctx.get()` 在 apply 时做一次性判断**踩了两次**:
   - webServer 路由没注册 → paste 裁决 404
   - attachments/llm 未就绪 → 图片桥接静默跳过
3. **模型能力判定必须用"原始"引用**:桥接 wrap `resolveModelInfo` 后,判断"该不该重写"要用未 wrap 的原函数,否则视觉模型也会被重写。
4. **消息改写点**:`llm.streamWithRegistration(options, prepared)` 是 `llm.stream` 与 `preparedCall.stream` 的公共入口,adapter 序列化前改写 messages 的唯一干净位置(社区 dsh-image-to-text 已验证)。
5. **凭据契约**:`credentials.resolve(ref) → { value }`,没有 `get()`;`set(ref, value)` 存在。WebUI 卡片写 key 走 `api.credentials.set`,读状态走 `describe({refs})`。

## 三、DSH 官方发布规范(逐条踩出来的)

| 规范 | 坑 |
|---|---|
| 包名 `dsh-*` 前缀 + topic `dsh-plugin` | 官方发布文档 `docs/user/develop/basic/publish.md` |
| `dsh.bundle.patch` + `cordis.patch.yml` | bundle 行 `name:` 必须等于包名 |
| **`exports` 必须导出 `./package.json`** | `dsh-client-modules` 用 `require.resolve('<pkg>/package.json')` 扫描 → 缺了它 client 半部被静默跳过(对比 mimo-search 发现) |
| `dsh.client = { platform:'web', inject:[客户端包名...] }` | 包名列表只属于 package.json;**插件代码的 `export inject` 是 Cordis 服务名**(`['slots','locale','connection','remote','settingsScope']`)—— 混淆会导致 `pending` boot 失败 |
| client.js 用 `__ModuleLoader__.load({id, factory})` | **id 必须等于包名**(无 `/client` 后缀),与 boot graph 行 id 一致 |
| 纯 JS 包无 build 脚本 | 免 pnpm `allowBuilds` 许可;git 安装的官方推荐形态 |
| 配置面 = `settings` namespace(schemastery)+ 卡片 slot | `settings.plugin.item` 无通用表单,卡片必须自带;`role('secret')` 字段不回显 |

## 四、踩坑清单(现象 → 根因 → 修法)

1. **黑底黑字**:`var(--input-background,#1a1a1a)` 浅色主题未定义 → 深色 fallback。修:透明背景 + 中性边框 `rgba(127,127,127,.4)` + `color:inherit`。
2. **PNG inflate "distance too far back"**:`lens[i++] = lens[i-1]` 求值顺序(i++ 先执行)→ 缓存 prev。
3. **PS `FromBase64String` 逗号解析**:方法参数内表达式逗号 → `$()` 包裹。
4. **OCR UNABLE_TO_MASK_PATH**:WinRT 不接受混合分隔符路径 → `[IO.Path]::GetFullPath` 归一化。
5. **PS 5.1 UTF-8 中文参数乱码**:写 `'\uFEFF' + JSON`,node 端剥 BOM。
6. **动态沙箱 `btoa` 是 UTF-8 语义**:二进制→base64 自实现 `b64encode`。
7. **MiMo 客户端脚本转义爆炸**:`\\n` → 模板换行 → 语法错误;改用 `String.fromCharCode` 无转义版本。
8. **`agent/request` 不能改消息**:waterfall 只换 LlmCallConfig;消息改写要走 `agent/pre-step`(晚于准入检查)或 stream 入口。
9. **api-proxy 准入检查硬编码**:`MODEL_DOES_NOT_SUPPORT_IMAGES` 在 `dsh-host-apiproxy` 的 `prompt()/admit()`;无配置开关 → 用 `resolveModelInfo` wrap 绕过(社区方案)。
10. **pnpm git 依赖连环坑**:SSH host key 缺失(老 OpenSSH 不支持 GitHub KEX)→ API 写 known_hosts;`insteadOf` 对 pnpm 内部 git 调用不生效 → **codeload tarball URL 兜底**(纯 HTTP,免 git);store 缓存旧 commit → 清 `store/v3` 条目重装。
11. **DSH 错误提示残留**:官方 window 层检查先跑,接管成功后错误条仍在 → MutationObserver 清扫 status/alert/toast 容器。
12. **"重启了还不行"的诊断顺序**:先确认进程加载了哪个版本(进程启动时间/`__DSH_BOOT__` rev/路由实测),再怀疑逻辑 —— 多次问题其实是"页面旧 JS"或"服务时序",不是逻辑错。

## 五、流程经验

1. **先实测再修**:浏览器注入探针(`fetch` 路由、模拟 paste 事件、查 boot graph/slot occupants)比读代码快一个数量级。
2. **冒烟测试随功能演进**:mock 要模拟**时序失败**(服务缺失/晚到),否则测不出 inject 类 bug —— v1.6.0 的桥接静默跳过就是 mock 全就绪掩盖的。
3. **社区调研省大量弯路**:modlens 的 paste-to-path、dsh-image-to-text 的 wrap 方案、mimo-search 的 exports 对比,三次直接决定了实现路径。
4. **发布节奏**:每修一个 bug 一个 patch 版本 + Release notes 写根因;官方 Discussions 持续更新,社区可见进展。
5. **秘钥纪律**:任何提交/发布前 grep `sk-`;发布版不做 credential 落库、不改用户默认模型、不开激进默认行为(paste-to-path 默认关闭)。

## 六、遗留与改进方向

- 桥接 wrap 的是 DSH 内部方法(`resolveModelInfo`/`streamWithRegistration`),DSH 升级需适配 → 向官方提 PR:`agent/image-admit` 桥接钩子上游化
- `agent/request` 与 `llm/stream` waterfall 的可达性未验证(备选更官方的拦截点)
- 物化缓存 `bridgeFiles` 无上限/无 TTL;视觉证据协议可加确定性 OCR 预处理
- 端到端自动化测试(真实 web profile 流程)尚未落地,目前靠人工重启验证
