/**
 * Kalodata CLI 模块：帮助渲染、参数解码与 API 调用。
 *
 * 这是工具插件与（可能的）终端入口共用的单一实现：`runCli(argv)` 返回
 * `{ exitCode, stdout }`，由调用方决定如何展示。帮助文本与参数校验全部
 * 从 {@link ../spec} 的接口规格派生，避免把整套文档塞进模型上下文——
 * agent 通过 `show_help` 按需获取单个接口的细节。
 * @module @deepseek-ai/dsh-kalodata-demo/cli
 */

import { DEFAULT_BASE_URL, ENDPOINTS, findEndpoint, type EndpointSpec, type ParamSpec } from './spec.ts'

/** `runCli` 的运行选项；全部可选，用于注入依赖或覆盖环境。 */
export interface CliOptions {
  /** 显式 secret key；缺省时回退到 `KALODATA_SECRET_KEY` 环境变量。 */
  secretKey?: string
  /** API 基地址覆盖（默认 `https://www.kalodata.com`）。 */
  baseUrl?: string
  /** fetch 实现覆盖（默认 `globalThis.fetch`），测试注入用。 */
  fetchImpl?: typeof fetch
  /** 转发给 HTTP 请求的取消信号。 */
  signal?: AbortSignal
  /** 榜单数组默认显示的条数（默认 20；`--full` 忽略此值）。 */
  maxItems?: number
  /** 是否显示全部榜单条目（对应 `--full`）。 */
  full?: boolean
}

/** 一次 CLI 运行的结果：进程退出码与标准输出文本。 */
export interface CliResult {
  readonly exitCode: number
  readonly stdout: string
}

/** 排行榜数据数组的默认截断条数。 */
export const DEFAULT_MAX_ITEMS = 20

/** 解析后的 argv：命令、参数键值对与命令行开关。 */
interface ParsedArgs {
  command?: string
  params: Record<string, string>
  help: boolean
  full: boolean
  maxItems: number
  secretKey?: string
  baseUrl?: string
}

/** 运行 CLI。返回 `{ exitCode, stdout }`，不抛异常（网络异常与参数错误也折叠为失败结果）。 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (parsed.command === undefined) return ok(renderOverview())
  const endpoint = findEndpoint(parsed.command)
  if (endpoint === undefined) {
    return fail(`未知接口：${parsed.command}\n可用接口：${ENDPOINTS.map(e => e.command).join('、')}`)
  }
  if (parsed.help) return ok(renderEndpointHelp(endpoint))

  const body = buildRequestBody(endpoint, parsed.params)
  if (body.error !== undefined) return fail(body.error)
  return callApi(endpoint, body.value, parsed, options)
}

/** 将 `--key=value` 参数按接口规格解码为请求体；返回错误文本或请求体。 */
function buildRequestBody(
  endpoint: EndpointSpec,
  params: Record<string, string>,
): { value: Record<string, unknown>; error?: undefined } | { value?: undefined; error: string } {
  const body: Record<string, unknown> = {}
  const errors: string[] = []
  for (const [key, raw] of Object.entries(params)) {
    const spec = endpoint.params.find(p => p.name === key)
    if (spec === undefined) {
      errors.push(`未知参数：${key}（该接口支持的参数见 "${endpoint.command} --help"）`)
      continue
    }
    if (spec.name.includes('.')) {
      errors.push(`参数 ${spec.name} 是 ${spec.name.split('.')[0]} 对象的子字段，请直接传父对象，如 --${spec.name.split('.')[0]}=${spec.example}`)
      continue
    }
    try {
      body[key] = decodeParam(spec, raw)
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  if (errors.length > 0) return { error: errors.join('\n') }
  const missing = endpoint.params.filter(p => p.required && !(p.name in body))
  if (missing.length > 0) {
    return { error: `缺少必填参数：${missing.map(p => p.name).join('、')}` }
  }
  return { value: body }
}

/** 按声明的类型解码一个参数值；类型不匹配时抛出带提示的错误。 */
export function decodeParam(spec: ParamSpec, raw: string): unknown {
  switch (spec.type) {
    case 'string':
      return raw
    case 'integer':
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`参数 ${spec.name} 需要 ${spec.type}，得到 "${raw}"`)
      const value = spec.type === 'integer' ? Number.parseInt(raw, 10) : Number(raw)
      if (spec.min !== undefined && value < spec.min) throw new Error(`参数 ${spec.name} 不能小于 ${spec.min}，得到 ${value}`)
      if (spec.max !== undefined && value > spec.max) throw new Error(`参数 ${spec.name} 不能大于 ${spec.max}，得到 ${value}`)
      return value
    }
    case 'boolean': {
      if (raw === 'true' || raw === '1') return true
      if (raw === 'false' || raw === '0') return false
      throw new Error(`参数 ${spec.name} 需要 boolean（true/false），得到 "${raw}"`)
    }
    case 'object': {
      try {
        const value: unknown = JSON.parse(raw)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
        return value
      } catch {
        throw new Error(`参数 ${spec.name} 需要 JSON 对象，得到 "${raw}"；示例：${spec.example}`)
      }
    }
    default: {
      if (!spec.type.startsWith('array<')) {
        throw new Error(`参数 ${spec.name} 的类型 ${spec.type} 不受支持`)
      }
      const inner = spec.type === 'array<integer>' || spec.type === 'array<number>' ? spec.type.slice(6, -1) : 'string'
      let parts: unknown
      try {
        parts = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').map(item => item.trim())
      } catch {
        throw new Error(`参数 ${spec.name} 需要数组，得到 "${raw}"`)
      }
      if (!Array.isArray(parts)) throw new Error(`参数 ${spec.name} 需要数组，得到 "${raw}"`)
      return parts.map((item, index) => {
        if (inner === 'string') return String(item)
        const text = String(item).trim()
        if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`参数 ${spec.name}[${index}] 需要 ${inner}，得到 "${text}"`)
        return inner === 'integer' ? Number.parseInt(text, 10) : Number(text)
      })
    }
  }
}

/** 发起 POST 并格式化输出；失败以非零退出码 + 错误文本返回。 */
async function callApi(
  endpoint: EndpointSpec,
  body: Record<string, unknown>,
  parsed: ParsedArgs,
  options: CliOptions,
): Promise<CliResult> {
  const secretKey = [parsed.secretKey, options.secretKey, process.env.KALODATA_SECRET_KEY]
    .find(key => key !== undefined && key.length > 0)
  if (!secretKey) {
    return fail('未提供 secret key：设置环境变量 KALODATA_SECRET_KEY，或在插件 config 里配置 secretKey。')
  }
  const baseUrl = parsed.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = `${baseUrl}${endpoint.path}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'secret-key': secretKey },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted) return fail('请求已取消')
    return fail(`请求失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    envelope = null
  }
  const record = envelope as Record<string, unknown> | null
  if (!response.ok || record === null || record.success === false) {
    const pretty = record === null ? text : JSON.stringify(record, null, 2)
    return fail(`请求失败（HTTP ${response.status}${record === null ? '，响应不是 JSON' : ''}）：\n${pretty}`)
  }
  return ok(formatSuccess(record, parsed.maxItems, options.full ?? parsed.full))
}

/** 汇总成功响应：状态行 + data（数组按条数截断）。 */
function formatSuccess(record: Record<string, unknown>, maxItems: number, full: boolean): string {
  const data = record.data
  const status: string[] = ['请求成功']
  if (record.cached !== undefined) status.push(`cached=${String(record.cached)}`)
  if (typeof record.message === 'string' && record.message.length > 0) status.push(`message=${record.message}`)
  if (!Array.isArray(data)) {
    return `${status.join(', ')}\n${JSON.stringify(data ?? record, null, 2)}`
  }
  const total = data.length
  const cap = full ? total : Math.min(maxItems, total)
  if (total > cap) status.push(`共 ${total} 条，显示前 ${cap} 条`)
  const lines = [status.join(', '), JSON.stringify(data.slice(0, cap), null, 2)]
  if (total > cap) lines.push(`[已截断：共 ${total} 条；用 --full 显示全部]`)
  return lines.join('\n')
}

/** 渲染概览帮助（无命令参数时）。 */
export function renderOverview(): string {
  const lines = [
    'Kalodata TikTok 电商数据 CLI',
    '',
    '用法：',
    '  kalodata <command> --help              查看指定接口的参数与响应字段',
    '  kalodata <command> --<param>=<value>   调用接口（如 --region=US）',
    '  kalodata                               （此帮助）',
    '',
    '接口（command）：',
    ...ENDPOINTS.map(e => `  ${e.command.padEnd(16)}${e.title}`),
    '',
    '通用说明：',
    '  - 所有接口均为 POST + JSON，请求头携带 secret-key 认证。',
    '  - 公共必填参数：region、language、currency、date_range。',
    '  - secret key 来源：环境变量 KALODATA_SECRET_KEY 或插件 config 的 secretKey。',
    '  - 数组参数支持逗号分隔（category_ids=1,2）或 JSON（category_ids=[1,2]）；对象参数用 JSON（sort_field={"field":"revenue","type":"DESC"}）。',
    '  - 榜单结果默认只显示前 20 条，--full 显示全部，--max-items N 调整条数。',
  ]
  return lines.join('\n')
}

/** 渲染单个接口的参考文档（请求参数 + 响应字段）。 */
export function renderEndpointHelp(endpoint: EndpointSpec): string {
  const lines = [
    `Kalodata — ${endpoint.command}（${endpoint.title}）`,
    `POST ${DEFAULT_BASE_URL}${endpoint.path}`,
    '',
    '请求参数：',
    ...renderParams(endpoint.params.filter(p => p.required), '必填'),
    ...renderParams(endpoint.params.filter(p => !p.required), '可选'),
    '',
    '响应字段：',
    ...endpoint.response.map(field => `  ${field.name} (${field.type}): ${field.description}`),
  ]
  return lines.join('\n')
}

/** 按分组（必填/可选）渲染参数行。 */
function renderParams(params: readonly ParamSpec[], label: string): string[] {
  if (params.length === 0) return [`  （无${label}参数）`]
  return [
    `  ${label}：`,
    ...params.map(p => `    ${p.name} (${p.type}): ${p.description} 示例：${p.example}`),
  ]
}

/** 解析 argv 为命令、参数与开关。第一个位置参数是命令，其余 `--key` 归为参数。 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { params: {}, help: false, full: false, maxItems: DEFAULT_MAX_ITEMS }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--help' || arg === '-h') {
      result.help = true
      index += 1
      continue
    }
    if (arg === '--full') {
      result.full = true
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=')
      const key = equal === -1 ? arg.slice(2) : arg.slice(2, equal)
      let value: string
      if (equal !== -1) {
        value = arg.slice(equal + 1)
      } else {
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith('--')) {
          value = next
          index += 1
        } else {
          value = 'true'
        }
      }
      switch (key) {
        case 'full':
          result.full = value !== 'false'
          break
        case 'max-items': {
          const count = Number(value)
          if (!Number.isInteger(count) || count < 1) {
            throw new Error(`--max-items 需要正整数，得到 "${value}"`)
          }
          result.maxItems = count
          break
        }
        case 'secret-key':
          result.secretKey = value
          break
        case 'base-url':
          result.baseUrl = value
          break
        default:
          result.params[key] = value
          break
      }
      index += 1
      continue
    }
    if (result.command === undefined) {
      result.command = arg
    } else {
      throw new Error(`多余的位置参数：${arg}`)
    }
    index += 1
  }
  return result
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout }
}

function fail(stdout: string): CliResult {
  return { exitCode: 1, stdout }
}

/**
 * 终端入口：`tsx src/cli.ts <command> [--param=value ...]`。工具插件导入本
 * 模块时 `import.meta.main` 为 false，不会触发副作用。包不发布 bin（应用
 * 启动必须走 dsh profile，见 docs/architecture.md#application-launch），
 * 终端调试直接通过 tsx 运行本文件。
 */
if (import.meta.main) {
  const result = await runCli(process.argv.slice(2))
  process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`)
  process.exitCode = result.exitCode
}
