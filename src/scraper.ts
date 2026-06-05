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

// ─── Scraper State Machine ────────────────────────────────────────────────────

/**
 * Lifecycle states that the scraper goes through.
 * Exposed via getScraperStatus() so API routes can include them in responses.
 */
export type ScraperLifecycle =
  | "initializing"       // process just started, browser not yet launched
  | "loading"            // browser launching / navigating to site
  | "collecting"         // actively polling DOM for frame changes
  | "reloading"          // doing a full page reload after a complete rotation
  | "error"              // last cycle threw — will retry
  | "stopped"            // stopScraperLoop() called

export type ScraperStatus = {
  lifecycle: ScraperLifecycle
  framesCollectedThisPass: number
  totalFrames: number
  candidatesLoaded: number
  lastSuccessfulCycleAt: string | null  // ISO
  lastError: string | null
  cycleCount: number
  pendingReload: boolean
}

let scraperLifecycle: ScraperLifecycle = "initializing"
let lastError: string | null = null
let lastSuccessfulCycleAt: string | null = null
let cycleCount = 0

export function getScraperStatus(): ScraperStatus {
  return {
    lifecycle: scraperLifecycle,
    framesCollectedThisPass: visitedFrames.size,
    totalFrames: TOTAL_FRAMES,
    candidatesLoaded: candidateCache?.candidates.length ?? 0,
    lastSuccessfulCycleAt,
    lastError,
    cycleCount,
    pendingReload,
  }
}

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

// ─── Network API capture ──────────────────────────────────────────────────────
// When counting2026.com's React app fetches candidate data, we intercept the
// JSON response and store it here. This makes the scraper independent of
// whether the React app manages to render its DOM grid — which can fail if
// the site's API blocks datacenter IPs (common on AWS/Heroku ranges).
type NetworkCandidate = {
  name?: string
  ballot?: number | string
  votes?: number | string
  place?: string
  rank?: number | string
  [key: string]: unknown
}
let capturedNetworkCandidates: NetworkCandidate[] | null = null
let capturedNetworkFrame: string | null = null
let capturedApiUrl: string | null = null

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GRID_SELECTOR =
  'article[class*="grid-cols"], div[class*="grid-cols"]'

/**
 * Wait until at least one candidate row element is present in the DOM.
 *
 * counting2026.com is a React SPA: after domcontentloaded the shell loads,
 * then React hydrates, fetches vote data from the site's own API, and renders
 * the grid. waitForSelector blocks until that render completes instead of
 * guessing with a fixed timer.
 *
 * Max wait: 30 s (generous for slow Heroku → site network round-trips).
 * If nothing appears in 30 s we log a warning and continue — readCurrentDOM
 * will see rows=0 and the cycle will retry in 10 s.
 */
async function waitForGrid(pg: Page): Promise<void> {
  console.log("[scraper] Waiting for candidate grid to render...")
  try {
    await pg.waitForSelector(GRID_SELECTOR, { timeout: 30_000 })
    console.log("[scraper] Candidate grid ready.")
  } catch {
    console.warn(
      "[scraper] Grid not found within 30s — " +
      "site may still be loading or the selector changed."
    )
  }
}

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
      // Bot-evasion: prevents navigator.webdriver being set to true
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    headless: true,
    timeout: 30_000,
  })

  page = await browser.newPage()

  // Patch navigator.webdriver so the site doesn't detect headless Chrome
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false })
  })

  // ── Network response interception ───────────────────────────────────────────
  // Capture JSON responses from counting2026.com so we can read candidate data
  // directly from the API, regardless of whether React renders the DOM grid.
  await page.setRequestInterception(true)
  page.on("request", (req) => req.continue())
  page.on("response", async (response) => {
    const url = response.url()
    if (!url.includes("counting2026.com")) return
    const ct = response.headers()["content-type"] ?? ""
    if (!ct.includes("json")) return
    if (response.status() !== 200) return
    try {
      const body = await response.text()
      console.log(`[scraper] JSON from: ${url.slice(0, 100)}`)
      const json = JSON.parse(body)
      // Try to extract candidate array regardless of exact API shape
      const arr: NetworkCandidate[] = Array.isArray(json)
        ? json
        : (json.candidates ?? json.data ?? json.results ?? null)
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0]
        // Must look like a candidate object
        if ("name" in first || "ballot" in first || "votes" in first) {
          console.log(`[scraper] ✅ Network capture: ${arr.length} candidates from ${url.slice(0, 80)}`)
          capturedNetworkCandidates = arr
          capturedApiUrl = url
        }
      }
      // Also try to find frame number in the response
      if (typeof json === "object" && (json.frame || json.frameNumber)) {
        capturedNetworkFrame = String(json.frame ?? json.frameNumber)
      }
    } catch { /* ignore parse errors */ }
  })

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
  console.log("[scraper] DOM loaded.")

  // Wait for React to hydrate and render the candidate grid.
  // domcontentloaded fires before React's data-fetch + render completes,
  // so we must wait for the actual row elements — not just a fixed timer.
  await waitForGrid(page)

  // Initial load already counts as the reload
  pendingReload = false

  return { browser, page: page! }
}

// ─── Page Extraction ──────────────────────────────────────────────────────────

type RawPageData = {
  frameNumber: string | null
  rows: string[]
  noticeText: string | null
  // Populated only when rows=0 to help debug selector mismatches
  diagnostics?: {
    bodyPreview: string
    selectorsTried: string[]
    matchCounts: Record<string, number>
    gridClassSamples: string[]
    tagSamples: string[]
  }
}

// All selectors to try, in priority order.
// We log which one matched so we can narrow down the correct one from logs.
const ROW_SELECTORS = [
  'article[class*="grid-cols"]',
  'div[class*="grid-cols"]',
  'li[class*="grid-cols"]',
  'tr[class*="grid-cols"]',
  '[class*="grid-cols"]',             // any element
  '[class*="candidate"]',
  'tbody tr',                         // plain table rows
]

/**
 * Read the current DOM state without reloading the page.
 * The site rotates frames on its own schedule; we just snapshot whatever
 * frame is currently displayed.
 */
async function readCurrentDOM(pg: Page): Promise<RawPageData> {
  return pg.evaluate((selectors: string[]): RawPageData => {
    const bodyText = document.body?.innerText ?? ""

    const frameMatch = bodyText.match(/Frame\s+(\d+)\/(\d+)/i)
    const frameNumber = frameMatch ? frameMatch[1] : null

    // Try each selector until we find one with rows matching the pattern
    let rows: string[] = []
    let matchedSelector = ""
    const matchCounts: Record<string, number> = {}

    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel))
      const texts = els
        .map((r) => (r as HTMLElement).innerText)
        .filter((t) => /^\d+\n\d+/.test(t))
      matchCounts[sel] = texts.length
      if (texts.length > 0 && rows.length === 0) {
        rows = texts
        matchedSelector = sel
      }
    }

    const noticeEl = document.querySelector("div.notice-marquee span")
    const noticeText = noticeEl
      ? (noticeEl as HTMLElement).innerText.trim()
      : null

    // When rows are still empty, capture diagnostic info for Heroku logs
    const diagnostics = rows.length === 0 ? {
      bodyPreview: bodyText.slice(0, 500),
      selectorsTried: selectors,
      matchCounts,
      gridClassSamples: Array.from(document.querySelectorAll('[class*="grid"]'))
        .slice(0, 8)
        .map(el => `${el.tagName}.${el.className.split(' ').find(c => c.includes('grid')) ?? '?'}`),
      tagSamples: Array.from(document.body.querySelectorAll('article, li, tr, [class*="row"], [class*="item"]'))
        .slice(0, 5)
        .map(el => `<${el.tagName.toLowerCase()} class="${(el as HTMLElement).className.slice(0, 80)}">`),
    } : undefined

    if (matchedSelector) {
      console.log(`[scraper-eval] Matched selector: ${matchedSelector} (${rows.length} rows)`)
    }

    return { frameNumber, rows, noticeText, diagnostics }
  }, ROW_SELECTORS)
}

/**
 * Full page reload — only called after a complete 12-frame rotation to
 * force counting2026.com to re-fetch the latest vote counts from its API.
 */
async function reloadForFreshData(pg: Page): Promise<void> {
  console.log("[scraper] Full rotation complete — reloading for fresh vote counts...")
  await pg.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
  await waitForGrid(pg)
}

// ─── Row Parsing ──────────────────────────────────────────────────────────────

function parseRows(rawRows: string[]): Partial<Candidate>[] {
  return rawRows.map((text) => {
    const parts = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)

    // Site column order (confirmed from live HTML):
    //   parts[0] = S. No (rank — discarded, we compute our own)
    //   parts[1] = Ballot No  → serial
    //   parts[2] = Candidate name
    //   parts[3] = Place / Judgeship
    //   parts[4] = Votes  ← LAST column in the grid
    return {
      serial: parts[1] || "",
      name: parts[2] || "",
      place: parts[3] || "",
      votes: Number(parts[4]) || 0,
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

// Hard upper bound on a single cycle — prevents page.goto / puppeteer.launch
// from hanging forever and blocking scheduleNext() from ever firing.
const CYCLE_HARD_TIMEOUT_MS = 90_000

async function runScrapeCycle(): Promise<void> {
  if (isScraping) return
  isScraping = true

  const hardTimeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(
        `Cycle hard-timeout after ${CYCLE_HARD_TIMEOUT_MS / 1000}s — ` +
        `browser launch or page.goto may be stuck`
      )),
      CYCLE_HARD_TIMEOUT_MS
    )
  )

  try {
    await Promise.race([runCycleBody(), hardTimeout])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[scraper] Cycle error:", msg)
    lastError = msg
    scraperLifecycle = "error"
    try { browser?.close() } catch { /* ignore */ }
    browser = null
    page = null
    pendingReload = true
  } finally {
    isScraping = false
  }
}

async function runCycleBody(): Promise<void> {
  scraperLifecycle = "loading"
  const { page: pg } = await ensureBrowser()

  if (pendingReload) {
    scraperLifecycle = "reloading"
    await reloadForFreshData(pg)
    pendingReload = false
  }

  scraperLifecycle = "collecting"
  const data = await readCurrentDOM(pg)

  // ── Notice cache ──────────────────────────────────────────────────────────
  if (data.noticeText !== null) {
    const STOP_PATTERNS = [/counting\s+stop/i, /halt/i, /suspended/i]
    const maintenanceMode = STOP_PATTERNS.some((p) => p.test(data.noticeText!))
    noticeCache = {
      text: data.noticeText,
      maintenanceMode,
      updatedAt: new Date().toISOString(),
    }
  }

  // ── Candidate cache ───────────────────────────────────────────────────────
  // Primary: DOM rows (fast, live)
  // Fallback: Network-intercepted JSON from counting2026.com's own API
  //           (works even when bot-detection prevents the React app from rendering)

  const frameNumber = data.frameNumber ?? capturedNetworkFrame
  const domRows = data.rows

  if (frameNumber && domRows.length > 0) {
    // ── Path A: DOM scraping succeeded ─────────────────────────────────────
    const isNew = !visitedFrames.has(frameNumber)
    if (isNew) {
      visitedFrames.add(frameNumber)
      const parsed = parseRows(domRows)
      const existing = candidateCache?.candidates ?? []
      const merged = mergeAndRank(existing, parsed)
      candidateCache = {
        candidates: merged,
        updatedAt: new Date().toISOString(),
        framesCollected: visitedFrames.size,
        totalFrames: TOTAL_FRAMES,
      }
      console.log(
        `[scraper] ✅ DOM Frame ${frameNumber}/${TOTAL_FRAMES} — ` +
        `${merged.length} candidates | top: ${merged[0]?.name ?? "?"} ${merged[0]?.votes}v`
      )
      if (visitedFrames.size >= TOTAL_FRAMES) {
        console.log(`[scraper] 🔄 All ${TOTAL_FRAMES} frames collected. Scheduling reload.`)
        visitedFrames.clear()
        pendingReload = true
      }
    } else {
      console.log(
        `[scraper] Frame ${frameNumber} seen (${visitedFrames.size}/${TOTAL_FRAMES} captured)`
      )
    }
  } else if (capturedNetworkCandidates && capturedNetworkCandidates.length > 0) {
    // ── Path B: DOM rendering failed, use network-intercepted data ──────────
    console.log(
      `[scraper] ⚡ Using network-captured data: ` +
      `${capturedNetworkCandidates.length} candidates from ${capturedApiUrl?.slice(0, 80) ?? "?"}`
    )
    // Map from network API shape → our Candidate shape
    const parsed: Partial<Candidate>[] = capturedNetworkCandidates.map((c) => ({
      serial: String(c.ballot ?? c.ballotNo ?? c.serial ?? ""),
      name: String(c.name ?? c.candidateName ?? ""),
      place: String(c.place ?? c.judgeship ?? c.district ?? ""),
      votes: Number(c.votes ?? c.voteCount ?? 0),
      barAssociation: "",
      judgeship: "",
      enrollmentDate: "",
      share: 0,
      transfer: 0,
      status: "",
      standing: "",
      trend: 0,
    }))
    const existing = candidateCache?.candidates ?? []
    const merged = mergeAndRank(existing, parsed)
    candidateCache = {
      candidates: merged,
      updatedAt: new Date().toISOString(),
      framesCollected: TOTAL_FRAMES, // treat network data as complete
      totalFrames: TOTAL_FRAMES,
    }
    console.log(
      `[scraper] ✅ Network data: ${merged.length} candidates | top: ${merged[0]?.name ?? "?"} ${merged[0]?.votes}v`
    )
    capturedNetworkCandidates = null // consume and clear
    capturedNetworkFrame = null
  } else {
    // ── Path C: Nothing available ───────────────────────────────────────────
    console.warn(
      `[scraper] No data — DOM rows=${domRows.length}, network=${capturedNetworkCandidates?.length ?? 0}`
    )
    if (data.diagnostics) {
      console.warn("  body:", data.diagnostics.bodyPreview.replace(/\n/g, " | ").slice(0, 300))
      console.warn("  selectors:", JSON.stringify(data.diagnostics.matchCounts))
      console.warn("  grid els:", data.diagnostics.gridClassSamples.join(", "))
      console.warn("  tags:", data.diagnostics.tagSamples.join(", "))
    }
  }

  lastError = null
  lastSuccessfulCycleAt = new Date().toISOString()
  cycleCount++
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

  // If the first cycle itself errors/hangs, scheduleNext still fires
  runScrapeCycle().finally(() => scheduleNext())
}

export function stopScraperLoop(): void {
  isRunning = false
  scraperLifecycle = "stopped"
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
