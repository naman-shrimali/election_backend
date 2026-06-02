/**
 * scraper.ts  (election_backend)
 *
 * Persistent Puppeteer browser that scrapes counting2026.com every
 * SCRAPE_INTERVAL_MS milliseconds. Results are stored in memory and
 * served by the Express routes — no file I/O needed.
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

export const SCRAPE_INTERVAL_MS = Number(
  process.env.SCRAPE_INTERVAL_MS ?? 30_000
)

// How long to wait after page.reload() for the site's own React/data-fetch
// to complete before we read the DOM.
const POST_RELOAD_SETTLE_MS = 8_000

// ─── Public Types ─────────────────────────────────────────────────────────────

export type Candidate = {
  id: number
  rank: number
  serial: string       // ballot number (e.g. "182")
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
  updatedAt: string         // ISO timestamp of last successful scrape
  framesCollected: number
  totalFrames: number
}

export type NoticeCache = {
  text: string
  maintenanceMode: boolean  // true when notice mentions counting stop/halt
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
let visitedFrames: Set<string> = new Set()
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

  // @sparticuz/chromium provides a pre-built Chromium binary for Linux cloud
  // environments (Heroku, Lambda, etc.). executablePath() extracts and returns
  // the path — no buildpack or manual Chrome download needed.
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

  // Disable HTTP cache so every reload fetches fresh data from the server
  await page.setCacheEnabled(false)

  // Strip any cache-friendly headers the site might set on responses
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

  return { browser, page: page! }
}

// ─── Page Extraction ──────────────────────────────────────────────────────────

type RawPageData = {
  frameNumber: string | null
  rows: string[]
  noticeText: string | null
}

async function extractPageData(pg: Page): Promise<RawPageData> {
  // Full reload ensures counting2026.com's own APIs re-fetch fresh vote data
  console.log("[scraper] Reloading page for fresh data...")
  await pg.reload({ waitUntil: "networkidle2", timeout: 60_000 })

  // Let the site's React app finish fetching and rendering
  console.log(`[scraper] Settling ${POST_RELOAD_SETTLE_MS / 1000}s...`)
  await new Promise<void>((r) => setTimeout(r, POST_RELOAD_SETTLE_MS))

  return pg.evaluate((): RawPageData => {
    const bodyText = document.body?.innerText ?? ""

    // The site shows "Frame X/12" in the UI — we use this to track coverage
    const frameMatch = bodyText.match(/Frame\s+(\d+)\/(\d+)/i)
    const frameNumber = frameMatch ? frameMatch[1] : null

    // Candidate rows: <article class*="grid-cols"> or <div class*="grid-cols">
    // Each row's innerText (after filter) is:
    //   parts[0]=SrNo  parts[1]=BallotNo  parts[2]=Name  parts[3]=Votes  parts[4]=Place
    const rows = Array.from(
      document.querySelectorAll(
        'article[class*="grid-cols"], div[class*="grid-cols"]'
      )
    )
      .map((r) => (r as HTMLElement).innerText)
      .filter((t) => /^\d+\n\d+/.test(t))

    // Notice banner: <div class="notice-marquee ..."><span>text</span></div>
    const noticeEl = document.querySelector("div.notice-marquee span")
    const noticeText = noticeEl
      ? (noticeEl as HTMLElement).innerText.trim()
      : null

    return { frameNumber, rows, noticeText }
  })}

// ─── Row Parsing ──────────────────────────────────────────────────────────────

function parseRows(rawRows: string[]): Partial<Candidate>[] {
  return rawRows.map((text) => {
    const parts = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)

    // After filter(Boolean) the layout is:
    //   parts[0] = Sr. No.    (site rank — discarded)
    //   parts[1] = Ballot No. → serial
    //   parts[2] = Name
    //   parts[3] = Votes      ← votes BEFORE place in the DOM
    //   parts[4] = Place
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
    const data = await extractPageData(pg)

    // ── Update notice cache ──────────────────────────────────────────────────
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
      console.log(
        `[scraper] Notice: "${data.noticeText.slice(0, 80)}${data.noticeText.length > 80 ? "..." : ""}"`
      )
    }

    // ── Update candidate cache ───────────────────────────────────────────────
    if (data.frameNumber && data.rows.length > 0) {
      const isNew = !visitedFrames.has(data.frameNumber)
      if (isNew) visitedFrames.add(data.frameNumber)

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
        `[scraper] Frame ${data.frameNumber}${isNew ? " (new)" : ""} — ` +
          `${merged.length} candidates | #1: ${merged[0]?.name ?? "?"} ` +
          `Ballot ${merged[0]?.serial} ${merged[0]?.votes}v`
      )

      // Reset after full rotation so vote counts keep refreshing
      if (visitedFrames.size >= TOTAL_FRAMES) {
        visitedFrames.clear()
        console.log("[scraper] Full rotation — resetting frame tracker")
      }
    } else {
      console.warn(
        `[scraper] Could not extract frame data (frameNumber=${data.frameNumber}, rows=${data.rows.length})`
      )
    }
  } catch (err) {
    console.error("[scraper] Cycle error:", err)
    // Reset browser so the next cycle gets a fresh one
    browser = null
    page = null
  } finally {
    isScraping = false
  }
}

// ─── Background Loop ──────────────────────────────────────────────────────────

function scheduleNext(): void {
  scraperTimer = setTimeout(async () => {
    await runScrapeCycle()
    scheduleNext()
  }, SCRAPE_INTERVAL_MS)
}

export function startScraperLoop(): void {
  if (isRunning) {
    console.log("[scraper] Already running")
    return
  }
  isRunning = true
  console.log(
    `[scraper] Starting — interval ${SCRAPE_INTERVAL_MS / 1000}s, ` +
      `target ${TARGET_URL}`
  )

  // First cycle fires immediately (fire-and-forget)
  runScrapeCycle().then(() => scheduleNext())
}

export function stopScraperLoop(): void {
  isRunning = false
  if (scraperTimer) {
    clearTimeout(scraperTimer)
    scraperTimer = null
  }
  if (browser) {
    browser.close().catch(() => {})
    browser = null
    page = null
  }
  console.log("[scraper] Stopped")
}
