import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import { createElement, insert, setProp } from "@opentui/solid"

type Limit = {
  type: string
  unit?: number
  number?: number
  usage?: number
  currentValue?: number
  remaining?: number
  percentage?: number
  nextResetTime?: number
}

type QuotaData = {
  limits?: Limit[]
  level?: string
}

type Window = {
  pct: number
  resetMs: number
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready"
      level: string
      fiveHour?: Window
      weekly?: Window
      mcpUsed: number
      mcpTotal: number
    }

const DEFAULTS = {
  baseUrl: "https://api.z.ai",
  pollMs: 60_000,
}
const MIN_POLL_MS = 10_000
const FETCH_TIMEOUT_MS = 15_000

// Same location Kilo itself uses: $XDG_DATA_HOME/kilo, falling back to ~/.local/share/kilo.
function authFile(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "kilo", "auth.json")
}

async function readApiKey(): Promise<string> {
  const fromEnv = process.env.Z_AI_API_KEY || process.env.ZHIPU_API_KEY
  if (fromEnv) return fromEnv
  const file = authFile()
  let auth: any
  try {
    auth = JSON.parse(await readFile(file, "utf8"))
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const key = auth?.["zai-coding-plan"]?.key ?? auth?.["zhipuai-coding-plan"]?.key
  if (typeof key === "string" && key.length > 0) return key
  throw new Error(`no z.ai key in ${file} (run kilo auth)`)
}

async function fetchQuota(key: string, baseUrl: string, signal: AbortSignal): Promise<QuotaData> {
  const res = await fetch(`${baseUrl}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: key, "Accept-Language": "en-US,en" },
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json: any = await res.json()
  if (!json?.data) throw new Error(json?.msg || "no data")
  return json.data
}

// z.ai encodes the window length as unit + number: unit 3 = hours, unit 6 = weeks.
function findTokenWindow(limits: Limit[] | undefined, unit: number, number: number): Window | undefined {
  const limit = limits?.find((l) => l.type === "TOKENS_LIMIT" && l.unit === unit && l.number === number)
  if (!limit || typeof limit.percentage !== "number") return undefined
  return { pct: limit.percentage, resetMs: limit.nextResetTime ?? 0 }
}

// Empty when the API gives no reset time (e.g. right after the window rolled over).
function fmtReset(resetMs: number): string {
  if (!resetMs) return ""
  const ms = resetMs - Date.now()
  if (ms <= 0) return "now"
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${String(min % 60).padStart(2, "0")}m`
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`
}

// Solid's universal renderer has no h(tag, props, children): build the node the way
// the JSX transform would, so the plugin needs no JSX compilation step.
function text(fg: unknown, content: string) {
  const el = createElement("text")
  setProp(el, "fg", fg)
  insert(el, content)
  return el
}

export default {
  id: "zai-usage",
  tui: async (api: any, options: any) => {
    const opts = { ...DEFAULTS, ...(options || {}) }
    const baseUrl = String(opts.baseUrl).replace(/\/+$/, "")
    const pollMs = Number.isFinite(opts.pollMs) ? Math.max(opts.pollMs, MIN_POLL_MS) : DEFAULTS.pollMs
    const disposed: AbortSignal | undefined = api?.lifecycle?.signal
    const [state, setState] = createSignal<State>({ status: "loading" })
    let inFlight = false

    const refresh = async () => {
      if (inFlight || disposed?.aborted) return
      inFlight = true
      try {
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
        const signal = disposed ? AbortSignal.any([disposed, timeout]) : timeout
        const key = await readApiKey()
        const data = await fetchQuota(key, baseUrl, signal)
        const fiveHour = findTokenWindow(data.limits, 3, 5)
        const weekly = findTokenWindow(data.limits, 6, 1)
        const mcp = data.limits?.find((l) => l.type === "TIME_LIMIT")
        if (!fiveHour && !weekly) {
          setState({ status: "error", message: "no token limit in response" })
          return
        }
        setState({
          status: "ready",
          level: data.level ?? "",
          fiveHour,
          weekly,
          mcpUsed: mcp?.currentValue ?? 0,
          mcpTotal: mcp?.usage ?? 0,
        })
      } catch (err) {
        if (disposed?.aborted) return
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      } finally {
        inFlight = false
      }
    }

    void refresh()
    const timer = setInterval(() => void refresh(), pollMs)
    api?.lifecycle?.onDispose(() => clearInterval(timer))

    // Color by whichever window is closer to its limit.
    const pctColor = (ctx: any, s: { fiveHour?: Window; weekly?: Window }) => {
      const pct = Math.max(s.fiveHour?.pct ?? 0, s.weekly?.pct ?? 0)
      return pct >= 85 ? ctx.theme.current.error : pct >= 60 ? ctx.theme.current.warning : ctx.theme.current.text
    }

    api.slots.register({
      slots: {
        home_footer: (ctx: any) => {
          const s = state()
          if (s.status === "loading") return text(ctx.theme.current.textMuted, "z.ai …")
          if (s.status === "error")
            return text(ctx.theme.current.error, `z.ai usage unavailable: ${s.message}`)
          const parts = [s.level ? `z.ai ${s.level}` : "z.ai"]
          if (s.fiveHour) {
            parts.push(`5h ${s.fiveHour.pct}%`)
            const reset = fmtReset(s.fiveHour.resetMs)
            if (reset) parts.push(`reset ${reset}`)
          }
          if (s.weekly) {
            const reset = fmtReset(s.weekly.resetMs)
            parts.push(reset ? `week ${s.weekly.pct}% (${reset})` : `week ${s.weekly.pct}%`)
          }
          parts.push(`mcp ${s.mcpUsed}/${s.mcpTotal}`)
          return text(pctColor(ctx, s), parts.join(" · "))
        },
        session_prompt_right: (ctx: any) => {
          const s = state()
          if (s.status === "loading") return text(ctx.theme.current.textMuted, "z.ai …")
          if (s.status === "error") return null
          const parts = ["z.ai"]
          if (s.fiveHour) {
            const reset = fmtReset(s.fiveHour.resetMs)
            parts[0] += ` ${s.fiveHour.pct}%`
            if (reset) parts.push(reset)
          }
          if (s.weekly) parts.push(`wk ${s.weekly.pct}%`)
          return text(pctColor(ctx, s), parts.join(" · "))
        },
      },
    })
  },
}
