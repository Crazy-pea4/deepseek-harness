/**
 * `runCli` 的键控-free 单元测试：帮助渲染、参数解码、请求构造与输出格式化，
 * 全部通过注入的 `fetchImpl` mock，不触碰真实网络。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.ts'

/** 构造一个最小可用的 fetch Response 形状。 */
function makeResponse(init: { ok: boolean; status: number; body: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: async () => init.body,
  } as Response
}

/** 捕获请求的 fetch mock。 */
function mockFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    return handler(String(url), init ?? {})
  }) as typeof fetch
}

const SECRET = 'test-secret-key'

beforeAll(() => {
  // 保持环境干净，避免宿主机设置了真实 key 影响用例。
  vi.stubEnv('KALODATA_SECRET_KEY', '')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function makeOptions(handler: (url: string, init: RequestInit) => Response) {
  return { fetchImpl: mockFetch(handler), secretKey: SECRET, baseUrl: 'https://example.test' }
}

describe('runCli 帮助', () => {
  it('无参数时输出概览，含接口清单与 key 提示', async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Kalodata TikTok 电商数据 CLI')
    expect(result.stdout).toContain('creator/rank')
    expect(result.stdout).toContain('product/rank')
    expect(result.stdout).toContain('KALODATA_SECRET_KEY')
  })

  it('--help 输出概览，-h 等价', async () => {
    const help = await runCli(['--help'])
    const short = await runCli(['-h'])
    expect(help.stdout).toBe(short.stdout)
    expect(help.stdout).toContain('接口（command）')
  })

  it('指定接口的 --help 输出请求参数与响应字段', async () => {
    const result = await runCli(['creator/rank', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('creator/rank（获取达人榜单列表）')
    expect(result.stdout).toContain('POST https://www.kalodata.com/openapi/v1/tiktok/creator/rank')
    expect(result.stdout).toContain('必填：')
    expect(result.stdout).toContain('region (string)')
    expect(result.stdout).toContain('sort_field (object)')
    expect(result.stdout).toContain('响应字段：')
    expect(result.stdout).toContain('data.creator_id (string)')
  })
})

describe('runCli 参数解析与请求构造', () => {
  it('把字符串参数原样发送，长数字 ID 不被 JSON 强转', async () => {
    const seen = { body: '' as string }
    const options = makeOptions((_url, init) => {
      seen.body = init.body as string
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: {} }) })
    })
    const result = await runCli(
      ['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=6937492675021095937'],
      options,
    )
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.creator_id).toBe('6937492675021095937')
    expect(body.region).toBe('US')
  })

  it('发送 POST + JSON + secret-key 头到正确 URL', async () => {
    const seen = { url: '', headers: {} as Record<string, string> }
    const options = makeOptions((url, init) => {
      seen.url = url
      seen.headers = init.headers as Record<string, string>
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: {} }) })
    })
    await runCli(['category/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day'], options)
    expect(seen.url).toBe('https://example.test/openapi/v1/tiktok/category/rank')
    expect(seen.headers['Content-Type']).toBe('application/json')
    expect(seen.headers['secret-key']).toBe(SECRET)
  })

  it('按声明类型解码布尔、数组、对象参数', async () => {
    const seen = { body: '' as string }
    const options = makeOptions((_url, init) => {
      seen.body = init.body as string
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: [] }) })
    })
    await runCli(
      [
        'creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day',
        '--category_ids=[601450,223]', '--sort_field={"field":"revenue","type":"DESC"}', '--page_size=20',
      ],
      options,
    )
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.category_ids).toEqual([601450, 223])
    expect(body.sort_field).toEqual({ field: 'revenue', type: 'DESC' })
    expect(body.page_size).toBe(20)
  })

  it('布尔参数显式 false 解码为 false', async () => {
    const seen = { body: '' as string }
    const options = makeOptions((_url, init) => {
      seen.body = init.body as string
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: [] }) })
    })
    await runCli(['product/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--need_extra=false'], options)
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.need_extra).toBe(false)
  })

  it('数组参数也接受逗号分隔形式', async () => {
    const seen = { body: '' as string }
    const options = makeOptions((_url, init) => {
      seen.body = init.body as string
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: [] }) })
    })
    await runCli(['category/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--category_ids=601450,223'], options)
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.category_ids).toEqual(['601450', '223'])
  })

  it('bare 布尔开关解析为 true', async () => {
    const seen = { body: '' as string }
    const options = makeOptions((_url, init) => {
      seen.body = init.body as string
      return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: {} }) })
    })
    await runCli(['product/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--need_all'], options)
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.need_all).toBe(true)
  })

  it('缺失必填参数时非零退出并列出缺项', async () => {
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: '{}' }))
    const result = await runCli(['creator/detail', '--region=US'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('缺少必填参数')
    expect(result.stdout).toContain('language')
    expect(result.stdout).toContain('creator_id')
  })

  it('未知参数失败并提示查看帮助', async () => {
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: '{}' }))
    const result = await runCli(['creator/detail', '--bogus=1', '--region=US'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('未知参数：bogus')
    expect(result.stdout).toContain('--help')
  })

  it('类型不匹配（非整数）失败', async () => {
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: '{}' }))
    const result = await runCli(['creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--page_size=abc'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('page_size 需要 integer')
  })

  it('数值参数越界（page_size 最小值 5）在本地拦截，不发起网络请求', async () => {
    const fetchSpy = vi.fn(() => makeResponse({ ok: true, status: 200, body: '{}' }))
    const options = { fetchImpl: fetchSpy as unknown as typeof fetch, secretKey: SECRET, baseUrl: 'https://example.test' }
    const result = await runCli(['creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--page_size=2'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('page_size 不能小于 5')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('未知接口失败并列出可用接口', async () => {
    const result = await runCli(['nope'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('未知接口：nope')
    expect(result.stdout).toContain('creator/detail')
  })

  it('缺少 secret key 时给出配置提示', async () => {
    const options = { fetchImpl: mockFetch(() => makeResponse({ ok: true, status: 200, body: '{}' })), baseUrl: 'https://example.test' }
    const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('KALODATA_SECRET_KEY')
  })

  it('未显式传 key 时回退到环境变量', async () => {
    vi.stubEnv('KALODATA_SECRET_KEY', SECRET)
    try {
      const seen = { headers: {} as Record<string, string> }
      const options = { fetchImpl: mockFetch((_url, init) => {
        seen.headers = init.headers as Record<string, string>
        return makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data: {} }) })
      }), baseUrl: 'https://example.test' }
      const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
      expect(result.exitCode).toBe(0)
      expect(seen.headers['secret-key']).toBe(SECRET)
    } finally {
      vi.stubEnv('KALODATA_SECRET_KEY', '')
    }
  })
})

describe('runCli 响应处理', () => {
  it('成功响应输出状态行与 data JSON', async () => {
    const options = makeOptions(() => makeResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ success: true, cached: false, message: 'ok', data: { shop_id: '1' } }),
    }))
    const result = await runCli(['shop/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--shop_id=1'], options)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('请求成功')
    expect(result.stdout).toContain('cached=false')
    expect(result.stdout).toContain('"shop_id": "1"')
  })

  it('HTTP 非 2xx 时非零退出并保留响应体', async () => {
    const options = makeOptions(() => makeResponse({ ok: false, status: 401, body: JSON.stringify({ code: 'UNAUTHORIZED' }) }))
    const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('HTTP 401')
    expect(result.stdout).toContain('UNAUTHORIZED')
  })

  it('success=false 视为失败', async () => {
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: false, message: 'rate limited' }) }))
    const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('rate limited')
  })

  it('榜单数组默认截断到 20 条并标记，--full 显示全部', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ i }))
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data }) }))
    const truncated = await runCli(['creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day'], options)
    expect(truncated.stdout).toContain('共 30 条，显示前 20 条')
    expect(truncated.stdout).toContain('[已截断：共 30 条；用 --full 显示全部]')
    const full = await runCli(['creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--full'], options)
    expect(full.stdout).not.toContain('已截断')
  })

  it('--max-items 调整截断条数', async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ i }))
    const options = makeOptions(() => makeResponse({ ok: true, status: 200, body: JSON.stringify({ success: true, data }) }))
    const result = await runCli(['creator/rank', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--max-items', '2'], options)
    expect(result.stdout).toContain('共 5 条，显示前 2 条')
    expect(result.stdout).toContain('"i": 1')
    expect(result.stdout).not.toContain('"i": 2')
  })

  it('网络错误折叠为失败结果', async () => {
    const options = { fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch, secretKey: SECRET }
    const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('请求失败：ECONNREFUSED')
  })

  it('取消信号中止时报告已取消', async () => {
    const controller = new AbortController()
    controller.abort()
    const options = {
      fetchImpl: (async () => { throw new DOMException('Aborted', 'AbortError') }) as typeof fetch,
      secretKey: SECRET,
      signal: controller.signal,
    }
    const result = await runCli(['creator/detail', '--region=US', '--language=en-US', '--currency=USD', '--date_range=last7Day', '--creator_id=1'], options)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('请求已取消')
  })

  it('--max-items 非法值报错且不抛异常', async () => {
    const result = await runCli(['--max-items', 'abc'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('--max-items 需要正整数')
  })

  it('多余位置参数报错且不抛异常', async () => {
    const result = await runCli(['creator/rank', 'extra'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('多余的位置参数：extra')
  })
})
