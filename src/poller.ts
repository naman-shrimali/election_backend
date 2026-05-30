/**
 * Background poller that continuously fetches live election data
 * from counting2026.com and stores results in an in-memory cache.
 *
 * All downstream API calls get the cached snapshot, so there is
 * no delay for clients and no risk of hammering the upstream.
 */

const UPSTREAM_BASE_URL =
  process.env.UPSTREAM_BASE_URL ?? "https://counting2026.com"

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000)

// Shared browser-like headers to reduce the chance of being blocked
const UPSTREAM_HEADERS = {
  accept: "*/*",
  referer: `${UPSTREAM_BASE_URL}/`,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T
  fetchedAt: Date
  pollCount: number
}

let pulseCache: CacheEntry<unknown> | null = null
let signalCache: CacheEntry<unknown> | null = null

let pollCount = 0

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function getPulseCache() {
  return pulseCache
}

export function getSignalCache() {
  return signalCache
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchPulse(): Promise<void> {
  try {
    const res = await fetch(`${UPSTREAM_BASE_URL}/api/candidates`, {
      headers: UPSTREAM_HEADERS,
    })

    if (!res.ok) {
      console.warn(`[poller] upstream /candidates returned ${res.status}`)
      return
    }

    const data = await res.json()
    pulseCache = { data, fetchedAt: new Date(), pollCount }
    console.log(
      `[poller] ✓ pulse updated — ${Array.isArray(data) ? data.length : "?"} records (poll #${pollCount})`
    )
  } catch (err) {
    console.error("[poller] ✗ pulse fetch failed:", (err as Error).message)
  }
}

/**
 * Fragments of the upstream disclaimer we want to detect.
 * We match partial phrases so small upstream wording tweaks don't break it.
 */
const UPSTREAM_DISCLAIMER_PATTERNS = [
  /this application is only made for the convenience/i,
  /not the official platform provided by the bar council/i,
  /official data provided by the bar council of rajasthan/i,
]

const REPLACEMENT_DISCLAIMER =
  "This is an unofficial convenience tool for legal professionals. " +
  "Data displayed here is indicative only. " +
  "Kindly refer to the Bar Council of Rajasthan's official records for authoritative results."

/**
 * Replaces any known upstream disclaimer text in the notice payload
 * with our own paraphrased version, leaving all other fields untouched.
 */
function sanitizeSignal(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data

  const notice = data as Record<string, unknown>

  if (typeof notice.text === "string") {
    const hasDisclaimer = UPSTREAM_DISCLAIMER_PATTERNS.some((pattern) =>
      pattern.test(notice.text as string)
    )

    if (hasDisclaimer) {
      console.log("[poller] signal: replaced upstream disclaimer text")
      return { ...notice, text: REPLACEMENT_DISCLAIMER }
    }
  }

  return data
}

async function fetchSignal(): Promise<void> {
  try {
    const res = await fetch(`${UPSTREAM_BASE_URL}/api/notice`, {
      headers: UPSTREAM_HEADERS,
    })

    if (!res.ok) {
      console.warn(`[poller] upstream /notice returned ${res.status}`)
      return
    }

    const raw = await res.json()
    const data = sanitizeSignal(raw)
    signalCache = { data, fetchedAt: new Date(), pollCount }
    console.log(`[poller] ✓ signal updated (poll #${pollCount})`)
  } catch (err) {
    console.error("[poller] ✗ signal fetch failed:", (err as Error).message)
  }
}

async function runPoll(): Promise<void> {
  pollCount++
  await Promise.allSettled([fetchPulse(), fetchSignal()])
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startPoller(): void {
  console.log(
    `[poller] Starting — polling every ${POLL_INTERVAL_MS}ms from ${UPSTREAM_BASE_URL}`
  )

  // Fetch immediately so cache is warm before the first client request
  void runPoll()

  intervalHandle = setInterval(() => void runPoll(), POLL_INTERVAL_MS)
}

export function stopPoller(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
    console.log("[poller] Stopped.")
  }
}
