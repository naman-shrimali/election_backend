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
import puppeteerExtra from "puppeteer-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"
import { type Browser, type Page } from "puppeteer-core"

// Apply stealth ONCE at module load — patches 10+ Cloudflare fingerprinting vectors:
// navigator.webdriver, navigator.plugins, WebGL, window.chrome, Notification,
// navigator.languages, screen dimensions, iframe contentWindow, etc.
puppeteerExtra.use(StealthPlugin())

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
  rank: number           // our display rank (1-indexed, always sequential)
  siteRank: number       // S.No from counting2026.com — authoritative vote order
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
    await pg.waitForSelector(ARTICLE_SELECTOR, { timeout: 30_000 })
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

  browser = await puppeteerExtra.launch({
    args: [
      ...chromium.args,
      "--disable-application-cache",
      "--disable-cache",
    ],
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    headless: true,
    timeout: 30_000,
  }) as unknown as Browser

  page = await browser.newPage()


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

/** Structured row data extracted directly from DOM elements (no innerText parsing). */
type RawRow = {
  siteRank: number  // parts[0]: S.No from the site
  serial: string    // parts[1]: Ballot No
  name: string      // h2 inside parts[2]
  place: string     // p  inside parts[2]
  votes: number     // parts[3]: last column
}

type RawPageData = {
  frameNumber: string | null
  rows: RawRow[]
  noticeText: string | null
  // Populated only when rows=0 to help debug
  diagnostics?: {
    bodyPreview: string
    articleCount: number
    firstArticleChildCount: number
  }
}

/** CSS selector that reliably matches candidate article rows. */
const ARTICLE_SELECTOR = 'article.grid'

/**
 * Read the current DOM state without reloading the page.
 *
 * IMPORTANT: We do NOT use article.innerText because CSS Grid can change how
 * headless Chrome renders text boundaries, producing unexpected whitespace.
 * Instead we query each child element by its grid column index and read
 * textContent directly — guaranteed correct regardless of CSS layout.
 *
 * Article DOM structure (4 grid columns):
 *   children[0]  S.No      <div class="text-gold">1</div>
 *   children[1]  Ballot    <div class="text-slate">182</div>
 *   children[2]  Name+Pl.  <div class="min-w-0"><h2>NAME</h2><p>PLACE</p></div>
 *   children[3]  Votes     <div class="text-right">1299</div>
 */
async function readCurrentDOM(pg: Page): Promise<RawPageData> {
  return pg.evaluate((articleSel: string): RawPageData => {
    const bodyText = document.body?.textContent ?? ""

    const frameMatch = bodyText.match(/Frame\s+(\d+)\/(\d+)/i)
    const frameNumber = frameMatch ? frameMatch[1] : null

    const articles = Array.from(document.querySelectorAll(articleSel))

    const rows: RawRow[] = []
    for (const art of articles) {
      const cols = art.children
      if (cols.length < 4) continue

      const siteRankText = (cols[0] as HTMLElement).textContent?.trim() ?? ""
      const serialText   = (cols[1] as HTMLElement).textContent?.trim() ?? ""
      const votesText    = (cols[3] as HTMLElement).textContent?.trim() ?? ""

      // Validate: first two columns must be integers (S.No and Ballot)
      if (!/^\d+$/.test(siteRankText) || !/^\d+$/.test(serialText)) continue

      const nameEl  = cols[2].querySelector("h2")
      const placeEl = cols[2].querySelector("p")

      rows.push({
        siteRank: Number(siteRankText),
        serial:   serialText,
        name:     (nameEl  as HTMLElement | null)?.textContent?.trim() ??
                  (cols[2] as HTMLElement).textContent?.trim() ?? "",
        place:    (placeEl as HTMLElement | null)?.textContent?.trim() ?? "",
        votes:    /^\d+$/.test(votesText) ? Number(votesText) : 0,
      })
    }

    const noticeEl  = document.querySelector("div.notice-marquee span")
    const noticeText = noticeEl
      ? (noticeEl as HTMLElement).textContent?.trim() ?? null
      : null

    const diagnostics = rows.length === 0 ? {
      bodyPreview:             bodyText.slice(0, 400),
      articleCount:            articles.length,
      firstArticleChildCount:  articles[0]?.children.length ?? 0,
    } : undefined

    return { frameNumber, rows, noticeText, diagnostics }
  }, ARTICLE_SELECTOR)
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

/** Maps structured DOM rows to Candidate partials. Trivial now that readCurrentDOM
 *  queries each column element directly instead of splitting innerText strings. */
function parseRows(rawRows: RawRow[]): Partial<Candidate>[] {
  return rawRows.map((row) => ({
    siteRank:      row.siteRank,
    serial:        row.serial,
    name:          row.name,
    place:         row.place,
    votes:         row.votes,
    barAssociation: "",
    judgeship:     "",
    enrollmentDate: "",
    share:         0,
    transfer:      0,
    status:        "",
    standing:      "",
    trend:         0,
  }))
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
        // Always update siteRank when we get a fresh value
        siteRank: raw.siteRank || prev.siteRank,
      })
    } else {
      map.set(serial, {
        id: nextId++,
        rank: 0,
        siteRank: raw.siteRank || 0,
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

  // Sort by the site's S.No (siteRank) — counting2026.com already ranks by
  // votes descending so this preserves the authoritative ordering.
  // Candidates whose frame hasn't been seen yet have siteRank=0; put them last.
  merged.sort((a, b) => {
    if (a.siteRank && b.siteRank) return a.siteRank - b.siteRank
    if (a.siteRank) return -1  // a has rank, b doesn't → a first
    if (b.siteRank) return 1   // b has rank, a doesn't → b first
    return Number(a.serial) - Number(b.serial)  // both unranked → sort by ballot
  })

  // Assign sequential display rank (1-indexed)
  merged.forEach((c, i) => { c.rank = i + 1 })
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
      console.warn("  article elements found:", data.diagnostics.articleCount)
      console.warn("  first article child count:", data.diagnostics.firstArticleChildCount)
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
