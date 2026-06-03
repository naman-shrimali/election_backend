/**
 * scraper.ts  (election_backend)
 *
 * Persistent Puppeteer browser that scrapes counting2026.com.
 * Results are stored in memory and served by the Express routes.
 *
 * Strategy:
 *   - counting2026.com rotates through 12 frames on its own timer (~30s/frame).
 *   - We poll the live DOM every FRAME_POLL_MS (10s) WITHOUT reloading the page,
 *     so we catch each frame as the site naturally advances it.
 *   - Each new frame's rows are merged into the candidate cache.
 *   - Only after seeing ALL 12 frames do we do a full page.reload() to get fresh
 *     vote counts, then start the next collection pass.
 *   - The frontend /api/pulse will return whatever candidates have been collected
 *     so far, along with framesCollected/totalFrames so the UI can show progress.
 *
 * Extracts:
 *   1. Candidate rows  (ballot no, name, votes, place)  → candidateCache
 *   2. Notice banner   (div.notice-marquee span text)   → noticeCache
 */

import chromium from "@sparticuz/chromium"
import puppeteer, { type Browser, type Page } from "puppeteer-core"

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_URL =
  process.env.UPSTREAM_BASE_URL ?? "https://counting2026.com"

const TOTAL_FRAMES = 12

// How often to poll the DOM for a frame change (no page reload)
const FRAME_POLL_MS = 10_000

// How long to wait after a full-rotation reload for React to re-render
const POST_RELOAD_SETTLE_MS = 10_000

// Exported so the API route can include it in the response
export const SCRAPE_INTERVAL_MS = FRAME_POLL_MS

// ─── Public Types ─────────────────────────────────────────────────────────────

export type Candidate = {
  id: number
  rank: number
  serial: string
  name: string
  place: string
  barAssociation: string
  judgeship: string
  enrollmentDate: string
  votes: number
  share: number
  transfer: number
  status: string
  standing: string
  trend: number
}

export type CandidateCache = {
  candidates: Candidate[]
  updatedAt: string
  framesCollected: number
  totalFrames: number
}

export type NoticeCache = {
  text: string
  maintenanceMode: boolean
  updatedAt: string
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

let candidateCache: CandidateCache | null = null
let noticeCache: NoticeCache | null = null

export function getCandidateCache(): CandidateCache | null {
  return candidateCache
}

export function getNoticeCache(): NoticeCache | null {
  return noticeCache
}

// ─── Singleton Browser State ──────────────────────────────────────────────────

let browser: Browser | null = null
let page: Page | null = null
let scraperTimer: ReturnType<typeof setTimeout> | null = null

// Tracks which frames have been captured in the current pass
let visitedFrames: Set<string> = new Set()

// When true, the next cycle will do a full page.reload() before reading
// This is set on startup and after every complete 12-frame rotation
let pendingReload = true

let isRunning = false
let isScraping = false

// ─── Browser Management ───────────────────────────────────────────────────────

async function ensureBrowser(): Promise<{ browser: Browser; page: Page }> {
  if (browser && page) {
    try {
      await page.title()
      return { browser, page }
    } catch {
      console.log("[scraper] Browser unresponsive — restarting...")
      browser = null
      page = null
    }
  }

  console.log("[scraper] Launching Puppeteer...")

  const executablePath = await chromium.executablePath()
  console.log(`[scraper] Chrome: ${executablePath}`)

  browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--disable-application-cache",
      "--disable-cache",
    ],
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    headless: true,
  })

  page = await browser.newPage()

  await page.setCacheEnabled(false)
  await page.setExtraHTTPHeaders({
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  })

  await page.setViewport({ width: 1280, height: 900 })
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  )

  console.log(`[scraper] Navigating to ${TARGET_URL}...`)
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60_000 })
  console.log("[scraper] Initial page load complete.")

  // Initial load already counts as the reload
  pendingReload = false

  // Settle so the React app can render the first frame
  console.log(`[scraper] Settling ${POST_RELOAD_SETTLE_MS / 1000}s after initial load...`)
  await new Promise<void>((r) => setTimeout(r, POST_RELOAD_SETTLE_MS))

  return { browser, page: page! }
}

// ─── Page Extraction ──────────────────────────────────────────────────────────

type RawPageData = {
  frameNumber: string | null
  rows: string[]
  noticeText: string | null
}

/**
 * Read the current DOM state without reloading the page.
 * The site rotates frames on its own schedule; we just snapshot whatever
 * frame is currently displayed.
 */
async function readCurrentDOM(pg: Page): Promise<RawPageData> {
  return pg.evaluate((): RawPageData => {
    const bodyText = document.body?.innerText ?? ""

    const frameMatch = bodyText.match(/Frame\s+(\d+)\/(\d+)/i)
    const frameNumber = frameMatch ? frameMatch[1] : null

    const rows = Array.from(
      document.querySelectorAll(
        'article[class*="grid-cols"], div[class*="grid-cols"]'
      )
    )
      .map((r) => (r as HTMLElement).innerText)
      .filter((t) => /^\d+\n\d+/.test(t))

    const noticeEl = document.querySelector("div.notice-marquee span")
    const noticeText = noticeEl
      ? (noticeEl as HTMLElement).innerText.trim()
      : null

    return { frameNumber, rows, noticeText }
  })
}

/**
 * Full page reload — only called after a complete 12-frame rotation to
 * force counting2026.com to re-fetch the latest vote counts from its API.
 */
async function reloadForFreshData(pg: Page): Promise<void> {
  console.log("[scraper] Full rotation complete — reloading for fresh vote counts...")
  await pg.reload({ waitUntil: "networkidle2", timeout: 60_000 })
  console.log(`[scraper] Settling ${POST_RELOAD_SETTLE_MS / 1000}s...`)
  await new Promise<void>((r) => setTimeout(r, POST_RELOAD_SETTLE_MS))
}

// ─── Row Parsing ──────────────────────────────────────────────────────────────

function parseRows(rawRows: string[]): Partial<Candidate>[] {
  return rawRows.map((text) => {
    const parts = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)

    // parts[0]=SrNo  parts[1]=BallotNo  parts[2]=Name  parts[3]=Votes  parts[4]=Place
    return {
      serial: parts[1] || "",
      name: parts[2] || "",
      votes: Number(parts[3]) || 0,
      place: parts[4] || "",
      barAssociation: "",
      judgeship: "",
      enrollmentDate: "",
      share: 0,
      transfer: 0,
      status: "",
      standing: "",
      trend: 0,
    }
  })
}

// ─── Merge + Rank ─────────────────────────────────────────────────────────────

function mergeAndRank(
  existing: Candidate[],
  incoming: Partial<Candidate>[]
): Candidate[] {
  const map = new Map<string, Candidate>(existing.map((c) => [c.serial, c]))
  let nextId = existing.length + 1

  for (const raw of incoming) {
    const serial = raw.serial!
    if (!serial) continue

    if (map.has(serial)) {
      const prev = map.get(serial)!
      const newVotes = raw.votes ?? prev.votes
      map.set(serial, {
        ...prev,
        votes: newVotes,
        trend: newVotes - prev.votes,
        place: raw.place || prev.place,
        name: raw.name || prev.name,
      })
    } else {
      map.set(serial, {
        id: nextId++,
        rank: 0,
        serial,
        name: raw.name || "",
        place: raw.place || "",
        barAssociation: "",
        judgeship: "",
        enrollmentDate: "",
        votes: raw.votes ?? 0,
        share: 0,
        transfer: 0,
        status: "",
        standing: "",
        trend: 0,
      })
    }
  }

  const merged = Array.from(map.values())
  merged.sort(
    (a, b) => b.votes - a.votes || Number(a.serial) - Number(b.serial)
  )
  merged.forEach((c, i) => {
    c.rank = i + 1
  })
  return merged
}

// ─── Single Scrape Cycle ──────────────────────────────────────────────────────

async function runScrapeCycle(): Promise<void> {
  if (isScraping) return
  isScraping = true

  try {
    const { page: pg } = await ensureBrowser()

    // Only do a full reload if a complete rotation just finished
    // (pendingReload is set after 12 frames are seen, or on errors)
    if (pendingReload) {
      await reloadForFreshData(pg)
      pendingReload = false
    }

    // Read the current DOM without touching the page —
    // the site's own timer advances the frame automatically
    const data = await readCurrentDOM(pg)

    // ── Update notice cache ────────────────────────────────────────────────────
    if (data.noticeText !== null) {
      const STOP_PATTERNS = [/counting\s+stop/i, /halt/i, /suspended/i]
      const maintenanceMode = STOP_PATTERNS.some((p) =>
        p.test(data.noticeText!)
      )
      noticeCache = {
        text: data.noticeText,
        maintenanceMode,
        updatedAt: new Date().toISOString(),
      }
    }

    // ── Update candidate cache ─────────────────────────────────────────────────
    if (data.frameNumber && data.rows.length > 0) {
      const isNew = !visitedFrames.has(data.frameNumber)

      if (isNew) {
        visitedFrames.add(data.frameNumber)

        const parsed = parseRows(data.rows)
        const existing = candidateCache?.candidates ?? []
        const merged = mergeAndRank(existing, parsed)

        candidateCache = {
          candidates: merged,
          updatedAt: new Date().toISOString(),
          framesCollected: visitedFrames.size,
          totalFrames: TOTAL_FRAMES,
        }

        console.log(
          `[scraper] ✅ Frame ${data.frameNumber}/${TOTAL_FRAMES} — ` +
          `${merged.length} total candidates | top: ${merged[0]?.name ?? "?"} ${merged[0]?.votes}v`
        )

        // After all 12 frames: flag for a fresh reload on the next cycle
        if (visitedFrames.size >= TOTAL_FRAMES) {
          console.log(
            `[scraper] 🔄 All ${TOTAL_FRAMES} frames collected (${merged.length} candidates). ` +
            `Will reload for fresh vote data.`
          )
          visitedFrames.clear()
          pendingReload = true
        }
      } else {
        // Same frame still showing — just log so we know we're alive
        console.log(
          `[scraper] Frame ${data.frameNumber} (waiting for rotation… ` +
          `${visitedFrames.size}/${TOTAL_FRAMES} frames captured)`
        )
      }
    } else {
      console.warn(
        `[scraper] No frame data (frameNumber=${data.frameNumber}, rows=${data.rows.length})`
      )
    }
  } catch (err) {
    console.error("[scraper] Cycle error:", err)
    browser = null
    page = null
    pendingReload = true   // force fresh load on recovery
  } finally {
    isScraping = false
  }
}

// ─── Background Loop ──────────────────────────────────────────────────────────

function scheduleNext(): void {
  scraperTimer = setTimeout(async () => {
    await runScrapeCycle()
    scheduleNext()
  }, FRAME_POLL_MS)
}

export function startScraperLoop(): void {
  if (isRunning) {
    console.log("[scraper] Already running")
    return
  }
  isRunning = true
  console.log(
    `[scraper] Starting — polling every ${FRAME_POLL_MS / 1000}s, ` +
    `target ${TARGET_URL}`
  )

  runScrapeCycle().then(() => scheduleNext())
}

export function stopScraperLoop(): void {
  isRunning = false
  if (scraperTimer) {
    clearTimeout(scraperTimer)
    scraperTimer = null
  }
  if (browser) {
    browser.close().catch(() => { })
    browser = null
    page = null
  }
  console.log("[scraper] Stopped")
}
