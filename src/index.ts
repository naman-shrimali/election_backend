import "dotenv/config"
import express, { Request, Response } from "express"
import cors from "cors"

import {
  startScraperLoop,
  stopScraperLoop,
  getCandidateCache,
  getNoticeCache,
  SCRAPE_INTERVAL_MS,
} from "./scraper"
import { encryptPayload } from "./crypto"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 5001)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET ?? ""

if (!ENCRYPTION_SECRET) {
  console.error("[server] ENCRYPTION_SECRET is not set — aborting.")
  process.exit(1)
}

// Vercel domain(s) that are allowed to call this backend.
// Set ALLOWED_ORIGINS in Heroku config vars as a comma-separated list, e.g.:
//   https://your-app.vercel.app,https://your-custom-domain.com
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
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return callback(null, true)

      // Always allow localhost for local dev
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) {
        return callback(null, true)
      }

      // Allow any *.vercel.app preview/production URL
      if (origin.endsWith(".vercel.app")) {
        return callback(null, true)
      }

      // Allow explicitly configured domains (production custom domains)
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true)
      }

      callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    methods: ["GET"],
  })
)

app.use(express.json())

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Liveness + readiness check. Shows whether the scraper has populated
 * the cache at least once.
 */
app.get("/health", (_req: Request, res: Response) => {
  const candidates = getCandidateCache()
  const notice = getNoticeCache()

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    scrapeIntervalMs: SCRAPE_INTERVAL_MS,
    cache: {
      candidates: candidates
        ? {
            updatedAt: candidates.updatedAt,
            count: candidates.candidates.length,
            framesCollected: candidates.framesCollected,
            totalFrames: candidates.totalFrames,
          }
        : null,
      notice: notice
        ? { updatedAt: notice.updatedAt, maintenanceMode: notice.maintenanceMode }
        : null,
    },
  })
})

/**
 * GET /api/pulse
 * Returns AES-256-CBC encrypted live candidate results.
 *
 * Encrypted payload shape (after decryption):
 *   {
 *     candidates: Candidate[],
 *     updatedAt: string,
 *     framesCollected: number,
 *     totalFrames: number
 *   }
 *
 * Response: { payload: "<base64>", ts: "<ISO>" }
 */
app.get("/api/pulse", (_req: Request, res: Response) => {
  const cache = getCandidateCache()

  if (!cache) {
    res.status(503).json({
      error:
        "Data not yet available — scraper is warming up. Retry in ~40 seconds.",
    })
    return
  }

  const payload = encryptPayload(cache, ENCRYPTION_SECRET)

  res.setHeader("Cache-Control", "no-store, max-age=0")
  res.json({ payload, ts: cache.updatedAt })
})

/**
 * GET /api/signal
 * Returns AES-256-CBC encrypted notice/announcement data.
 *
 * Encrypted payload shape (after decryption):
 *   { text: string, maintenanceMode: boolean, updatedAt: string }
 *
 * Response: { payload: "<base64>", ts: "<ISO>" }
 */
app.get("/api/signal", (_req: Request, res: Response) => {
  const cache = getNoticeCache()

  if (!cache) {
    res.status(503).json({
      error: "Notice not yet available — scraper is warming up.",
    })
    return
  }

  const payload = encryptPayload(cache, ENCRYPTION_SECRET)

  res.setHeader("Cache-Control", "no-store, max-age=0")
  res.json({ payload, ts: cache.updatedAt })
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
