# @deepseek-ai/dsh-kalodata-demo

Kalodata TikTok 电商数据 CLI + 模型工具（bundle）。

Kalodata 是获取 TikTok 电商数据（达人 / 类目 / 店铺 / 商品）的服务。本包把 8 个
接口的文档编码成结构化规格（[`src/spec.ts`](src/spec.ts)），提供一个进程内 CLI
（[`src/cli.ts`](src/cli.ts)），并把 CLI 封装成模型可调用的 `kalodata` 工具
（[`src/index.ts`](src/index.ts)）。

## 设计

- **按需取文档，避免塞爆上下文。** 工具只暴露极简 schema（`command` +
  `show_help` + `params`）。agent 先 `show_help: true` 拿到单个接口的参数与响应
  字段，再以具体参数调用；整套 API 文档不会常驻上下文。
- **CLI 是唯一实现。** 工具进程内调用 `runCli(argv)`，与终端入口（tsx 直接运行
  `src/cli.ts`）共享同一份解析、校验与输出逻辑。不发布 package `bin`——应用启动
  必须走 `dsh` profile（见 `docs/architecture.md#application-launch`）。
- **参数按规格解码与校验。** 类型（string/integer/boolean/array/object）与真实
  接口约束（如 `page_size` 最小 5）都在本地拦截，带中文错误提示。

## 安装与使用

环境变量提供 secret key：

```sh
export KALODATA_SECRET_KEY=<你的 key>
```

作为 bundle 装进 profile：

```sh
pnpm install                                   # 建立 workspace 链接
dsh plugin --profile headless add ./packages/examples/kalodata
pnpm dsh --profile headless "帮我查一下美国达人榜单前几名"
```

`dsh plugin add` 会把包 link 进对应 profile 并追加到 `dsh.profile.bundles`，
重启 profile 即生效。其他 profile（如 `web`）同理。

## 终端用法

```sh
pnpm exec tsx packages/examples/kalodata/src/cli.ts --help
pnpm exec tsx packages/examples/kalodata/src/cli.ts creator/rank --help
KALODATA_SECRET_KEY=xxx pnpm exec tsx packages/examples/kalodata/src/cli.ts \
  creator/rank --region=US --language=en-US --currency=USD --date_range=last7Day --page_size=20
```

数组参数接受逗号分隔（`category_ids=601450,223`）或 JSON
（`category_ids=[601450,223]`）；对象参数用 JSON
（`sort_field={"field":"revenue","type":"DESC"}`）。榜单结果默认只显示前 20 条，
`--full` 显示全部。

## 模型侧用法

工具：`kalodata(command, show_help?, params?)`。示例：

1. `kalodata(command="creator/rank", show_help=true)` → 返回该接口文档。
2. `kalodata(command="creator/rank", params={"region":"US","language":"en-US","currency":"USD","date_range":"last7Day","page_size":20})` → 返回榜单 JSON。

## 已知限制

- 文档字段随 Kalodata 官网演进；`src/spec.ts` 是唯一事实来源，改动文档时同步更新。
