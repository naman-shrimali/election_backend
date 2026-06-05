import "dotenv/config"
import express, { Request, Response } from "express"
import cors from "cors"

import {
  startScraperLoop,
  stopScraperLoop,
  getCandidateCache,
  getNoticeCache,
  getScraperStatus,
  SCRAPE_INTERVAL_MS,
} from "./scraper"
import { encryptPayload } from "./crypto"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 5001)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET ?? ""
const SERVER_START = new Date().toISOString()

if (!ENCRYPTION_SECRET) {
  console.error("[server] ENCRYPTION_SECRET is not set — aborting.")
  process.exit(1)
}

const ALLOWED_ORIGINS: string[] = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express()

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) return callback(null, true)
      if (origin.endsWith(".vercel.app")) return callback(null, true)
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
      callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    methods: ["GET"],
  })
)

app.use(express.json())

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NO_CACHE = "no-store, max-age=0"

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health  — always 200, machine-readable liveness + readiness.
 *
 * Frontend devs can hit this to understand exactly what the scraper is doing
 * without touching any backend code. Fields:
 *
 *   serverStart      ISO timestamp of when the process started
 *   uptime           seconds the process has been running
 *   scraper          full ScraperStatus snapshot (lifecycle, errors, counts…)
 *   cache.candidates { count, framesCollected, totalFrames, updatedAt } | null
 *   cache.notice     { maintenanceMode, updatedAt } | null
 */
app.get("/health", (_req: Request, res: Response) => {
  const candidateCache = getCandidateCache()
  const noticeCache = getNoticeCache()

  res.setHeader("Cache-Control", NO_CACHE)
  res.json({
    status: "ok",
    serverStart: SERVER_START,
    uptime: Math.round((Date.now() - new Date(SERVER_START).getTime()) / 1000),
    scrapeIntervalMs: SCRAPE_INTERVAL_MS,
    scraper: getScraperStatus(),
    cache: {
      candidates: candidateCache
        ? {
            count: candidateCache.candidates.length,
            framesCollected: candidateCache.framesCollected,
            totalFrames: candidateCache.totalFrames,
            updatedAt: candidateCache.updatedAt,
          }
        : null,
      notice: noticeCache
        ? { maintenanceMode: noticeCache.maintenanceMode, updatedAt: noticeCache.updatedAt }
        : null,
    },
  })
})

/**
 * GET /api/pulse  — always 200, never 503.
 *
 * Response shape — two possible variants:
 *
 * A) Scraper is still warming up (no candidate data yet):
 *    {
 *      status:        "warming_up",
 *      scraper:       ScraperStatus,        ← full diagnostic
 *      candidates:    [],
 *      framesCollected: 0,
 *      totalFrames:   12,
 *      updatedAt:     null,
 *      nextRefreshInMs: number
 *    }
 *
 * B) Data available (AES-256-CBC encrypted payload):
 *    {
 *      status:    "ok",
 *      payload:   "<base64 encrypted>",
 *      ts:        "<ISO>",
 *      scraper:   ScraperStatus            ← always included for debug
 *    }
 *
 *    Decrypted payload shape:
 *    { candidates, updatedAt, framesCollected, totalFrames }
 *
 * The Vercel proxy (/api/pulse in v0-election-web-app) detects `status` and
 * either passes through the warming_up body or decrypts the payload.
 */
app.get("/api/pulse", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", NO_CACHE)

  const scraperStatus = getScraperStatus()
  const cache = getCandidateCache()

  if (!cache) {
    // Scraper hasn't completed its first cycle yet.
    // Return an informative 200 — not a 503 — so the UI can show a
    // meaningful loading state instead of an error page.
    res.json({
      status: "warming_up",
      scraper: scraperStatus,
      candidates: [],
      framesCollected: scraperStatus.framesCollectedThisPass,
      totalFrames: scraperStatus.totalFrames,
      updatedAt: null,
      nextRefreshInMs: SCRAPE_INTERVAL_MS,
    })
    return
  }

  try {
    const payload = encryptPayload(cache, ENCRYPTION_SECRET)
    res.json({ status: "ok", payload, ts: cache.updatedAt, scraper: scraperStatus })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[server] /api/pulse encryption error:", msg)
    // Even encryption errors return 200 with a structured body.
    res.json({
      status: "error",
      code: "ENCRYPTION_FAILED",
      message: "Failed to encrypt candidate payload. Check server logs.",
      scraper: scraperStatus,
      candidates: [],
      framesCollected: scraperStatus.framesCollectedThisPass,
      totalFrames: scraperStatus.totalFrames,
      updatedAt: null,
      nextRefreshInMs: SCRAPE_INTERVAL_MS,
    })
  }
})

/**
 * GET /api/signal  — always 200, never 503.
 *
 * Response shape:
 * {
 *   status:  "ok" | "warming_up",
 *   payload: "<base64 encrypted>" | undefined,
 *   ts:      "<ISO>"
 * }
 *
 * When warming up, an empty-notice payload is encrypted and returned so
 * the frontend decryption path stays uniform.
 */
app.get("/api/signal", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", NO_CACHE)

  const now = new Date().toISOString()
  // Fall back to empty notice during warmup so the UI never errors.
  const cache = getNoticeCache() ?? {
    text: "",
    maintenanceMode: false,
    updatedAt: now,
  }
  const status = getNoticeCache() ? "ok" : "warming_up"

  const payload = encryptPayload(cache, ENCRYPTION_SECRET)
  res.json({ status, payload, ts: cache.updatedAt })
})

// 404 fallthrough
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" })
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[server] 🚀 Election backend running on http://localhost:${PORT}`)
  console.log(`[server] Encryption: AES-256-CBC`)
  console.log(
    `[server] Secret loaded (first 8 chars): ${ENCRYPTION_SECRET.slice(0, 8)}...`
  )
  console.log(`[server] Debug endpoint: GET /health`)
  startScraperLoop()
})

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n[server] Received ${signal} — shutting down...`)
  stopScraperLoop()
  server.close(() => {
    console.log("[server] Closed.")
    process.exit(0)
  })
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
