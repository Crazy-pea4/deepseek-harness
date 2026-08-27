/**
 * Kalodata 工具插件：把 {@link runCli} 封装成模型可调用的 `kalodata` 工具。
 *
 * 模型先以 `show_help: true` 获取指定接口的参数文档（按需拉取，避免把整套
 * API 文档塞进上下文），再以 `params` 传入具体参数调用。工具与终端一样走
 * 同一个 CLI 实现。无 default export——Loader 需要命名导出以保留
 * `name`/`inject`/`Config`（见 docs/postmortem/0001）。
 * @module @deepseek-ai/dsh-kalodata-demo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { DEFAULT_BASE_URL, ENDPOINTS } from './spec.ts'
import { runCli } from './cli.ts'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'tool-kalodata'

/** 工具注册所需的运行时服务。 */
export const inject = ['tools'] as const

/** 插件配置：部署相关值从 cordis.yml 传入，不硬编码在代码里。 */
export interface Config {
  /** secret key 覆盖；缺省回退到 `KALODATA_SECRET_KEY` 环境变量。 */
  secretKey?: string
  /** 榜单数组默认显示的条数（默认 20）。 */
  maxItems?: number
  /** API 基地址覆盖（默认 `https://www.kalodata.com`）。 */
  baseUrl?: string
}

export const Config: z<Config> = z.object({
  secretKey: z.string().default(''),
  maxItems: z.number().default(20),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
})

/** schemastery 填充默认值后的完整配置。 */
type ResolvedConfig = Required<Config>

/** 注册 `kalodata` 工具。注册是 effect——插件 fiber 卸载时自动注销。 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  ctx.tools.register(defineTool({
    name: 'kalodata',
    description: `查询 Kalodata TikTok 电商数据。第一次调用先设 show_help: true 查看指定 command 的请求参数与响应字段，再按文档以 params 传参调用。command 取值：${ENDPOINTS.map(e => e.command).join('、')}。`,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: `接口名，取值：${ENDPOINTS.map(e => e.command).join('、')}。`,
      },
      show_help: {
        type: 'boolean',
        description: '为 true 时返回该接口的参考文档（请求参数 + 响应字段），不调用 API。',
      },
      params: {
        type: 'json',
        description: '接口请求参数对象（键值对），如 {"region":"US","language":"en-US","currency":"USD","date_range":"last7Day"}；类型按接口文档。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const argv = toolArgsToArgv(args)
      const result = await runCli(argv, {
        signal: exec.signal,
        secretKey: resolved.secretKey,
        baseUrl: resolved.baseUrl,
        maxItems: resolved.maxItems,
      })
      if (result.exitCode !== 0) throw new Error(result.stdout)
      return result.stdout
    },
  }))
}

/** 工具参数结构：命令、帮助开关、请求参数对象。 */
interface KalodataToolArgs {
  command: string
  show_help?: boolean
  params?: JsonValue
}

/** 把工具参数组装成 CLI argv。显示帮助时忽略 params；params 非对象时报错。 */
function toolArgsToArgv(args: KalodataToolArgs): string[] {
  if (args.show_help) return [args.command, '--help']
  const argv = [args.command]
  if (args.params === undefined) return argv
  if (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) {
    throw new Error(`kalodata params 需要 JSON 对象，得到 ${JSON.stringify(args.params)}`)
  }
  for (const [key, value] of Object.entries(args.params)) {
    argv.push(`--${key}=${serializeParam(value)}`)
  }
  return argv
}

/** 把 JSON 值序列化为 CLI 参数值字符串。 */
function serializeParam(value: JsonValue): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}
