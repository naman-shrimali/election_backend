import "dotenv/config"
import express, { Request, Response } from "express"
import cors from "cors"

import { startPoller, stopPoller, getPulseCache, getSignalCache } from "./poller"
import { encryptPayload } from "./crypto"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 5001)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET ?? ""

if (!ENCRYPTION_SECRET) {
  console.error("[server] ENCRYPTION_SECRET is not set in .env — aborting.")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express()

app.use(
  cors({
    // Allow requests from the Next.js dev server and any localhost port
    origin: (origin, callback) => {
      if (
        !origin ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) {
        callback(null, true)
      } else {
        callback(new Error("Not allowed by CORS"))
      }
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
 * Quick liveness check. Returns cache status so you can monitor
 * whether data has been fetched at least once.
 */
app.get("/health", (_req: Request, res: Response) => {
  const pulse = getPulseCache()
  const signal = getSignalCache()

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cache: {
      pulse: pulse
        ? { fetchedAt: pulse.fetchedAt, pollCount: pulse.pollCount }
        : null,
      signal: signal
        ? { fetchedAt: signal.fetchedAt, pollCount: signal.pollCount }
        : null,
    },
  })
})

/**
 * GET /api/pulse
 * Returns AES-256-CBC encrypted live results data.
 *
 * Response shape:
 *   { payload: "<base64 encrypted string>", ts: "<ISO timestamp>" }
 *
 * The `ts` (timestamp) field tells the client when the upstream was last
 * fetched. It is NOT encrypted so it can be used as a cache-busting hint
 * without revealing business data.
 */
app.get("/api/pulse", (_req: Request, res: Response) => {
  const cache = getPulseCache()

  if (!cache) {
    res.status(503).json({
      error: "Data not yet available — poller is warming up. Retry in a few seconds.",
    })
    return
  }

  const payload = encryptPayload(cache.data, ENCRYPTION_SECRET)

  res.setHeader("Cache-Control", "no-store, max-age=0")
  res.json({
    payload,
    ts: cache.fetchedAt.toISOString(),
  })
})

/**
 * GET /api/signal
 * Returns AES-256-CBC encrypted broadcast/notice data.
 */
app.get("/api/signal", (_req: Request, res: Response) => {
  const cache = getSignalCache()

  if (!cache) {
    res.status(503).json({
      error: "Data not yet available — poller is warming up. Retry in a few seconds.",
    })
    return
  }

  const payload = encryptPayload(cache.data, ENCRYPTION_SECRET)

  res.setHeader("Cache-Control", "no-store, max-age=0")
  res.json({
    payload,
    ts: cache.fetchedAt.toISOString(),
  })
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
  console.log(`[server] Secret loaded (first 8 chars): ${ENCRYPTION_SECRET.slice(0, 8)}... (total: ${ENCRYPTION_SECRET.length} chars)`)
  console.log(`[server] Upstream: ${process.env.UPSTREAM_BASE_URL ?? "https://counting2026.com"}`)
  console.log(`[server] Poll interval: ${process.env.POLL_INTERVAL_MS ?? 3000}ms`)
  startPoller()
})

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n[server] Received ${signal} — shutting down gracefully...`)
  stopPoller()
  server.close(() => {
    console.log("[server] Closed.")
    process.exit(0)
  })
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
