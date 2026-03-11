# SuperRun Temporary Usage Guide

这是一份临时使用说明，描述的是仓库当前真实可用的用法，不是未来规划。

## 1. 先准备环境

要求：

- Node.js 20+
- 一个可用的 OpenAI-compatible 接口
- 对应的 API key

先安装依赖：

```bash
npm install
```

## 2. 配置 `.env`

当前项目会直接读取根目录下的 `.env`。
仓库里现在没有可靠的 `.env.example`，所以直接手动创建或修改 `.env` 即可。

最小配置如下：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=120000
```

字段说明：

- `OPENAI_API_KEY`: 必填
- `OPENAI_BASE_URL`: 可选，默认是 `https://api.openai.com/v1`
- `OPENAI_MODEL`: 可选，默认是 `gpt-4o-mini`
- `OPENAI_TIMEOUT_MS`: 可选，默认是 `120000`

如果没配 `OPENAI_API_KEY`，程序会直接报错。

## 3. 构建

先编译一次：

```bash
npm run build
```

## 4. 单轮使用

直接传一个 prompt：

```bash
npm run dev -- "Explain this repository"
```

或者先 build 之后直接跑编译产物：

```bash
node dist/index.js "Explain this repository"
```

输出会是流式的。

## 5. 多轮对话使用

不传 prompt，直接进入交互模式：

```bash
npm run dev --
```

或者：

```bash
node dist/index.js
```

进入后你会看到一个简单 TUI。当前支持这些本地命令：

- `/help`: 显示帮助
- `/clear`: 清屏并重绘头部
- `/exit`: 退出会话

注意：

- 多轮历史只保存在当前进程内
- 退出后不会自动持久化
- 下一次启动会话历史会重新开始

## 6. PowerShell 下的实际示例

单轮：

```powershell
npm run dev -- "帮我解释一下 src/agent/loop.ts"
```

进入多轮：

```powershell
npm run dev --
```

然后你可以这样连续问：

```text
你 > 先总结这个项目
superrun > ...

你 > 再解释一下 agent loop 是怎么记住上下文的
superrun > ...
```

## 7. 非交互模式 / 管道

当前项目也支持把多行输入通过管道喂给它：

```powershell
@"
My name is Ada.
What is my name?
/exit
"@ | npm run dev --
```

这种方式适合脚本测试，但不会显示完整 TUI 体验。

## 8. 验证当前功能是否正常

构建：

```bash
npm run build
```

测试：

```bash
npm test
```

如果你只是想确认“能不能聊”，最直接的是：

```bash
npm run dev --
```

然后输入一句话，看是否返回模型输出。

## 9. 当前阶段的已知限制

- 只有 OpenAI-compatible chat completion 路径
- 还没有工具调用
- 还没有会话持久化
- 还没有复杂 TUI，只是轻量终端界面
- 还没有完整参数系统，主要依赖 `.env`

## 10. 推荐你现在就这样用

如果你只是想实际体验当前版本，最短路径是：

1. 配好 `.env`
2. 运行 `npm install`
3. 运行 `npm run dev --`
4. 在交互界面里直接开始聊

如果你想确认单轮调用没问题，就运行：

```bash
npm run dev -- "hello"
```
