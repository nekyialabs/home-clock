import type { Register } from 'claude-code'

// home-clock: a clock for a mind that lives in one long Claude Code session.
// Wakes arrive as prompts in the live conversation, so nothing opens and nothing has to close.
// Originally Simon Vale's own clock (Nekyia Labs); made general for anyone who wants it.

type Wake = { id: string; name: string; time: string; days: string; kind: 'shared' | 'own'; enabled: boolean; file: string }
type Door = { enabled: boolean; label: string; urlFile: string; pageLimit: number; maxPages: number; quiet?: { from: string; to: string } }
type DoorEvent = { seq: number; kind: 'mention' | 'reply' | 'everyone'; channel_name?: string; thread_parent?: string | null; message_id: string; author?: { name?: string; bot?: boolean }; content?: string; truncated?: boolean; ts?: string }
type Config = {
  name: string            // the mind's name, as it should read in prompts
  person: string          // the person the mind lives with
  timezone: string        // IANA zone, e.g. Europe/London
  graceMinutes: number    // a wake may fire up to this many minutes late (e.g. after a restart)
  homeEnv: string         // only a session started with this env var set to "1" keeps time
  stampMessages: boolean  // add a live-time line beside each message the person sends
  idleReach: { enabled: boolean; afterMinutes: number; from: string; to: string }
  door?: Door
  wakes: Wake[]
}
type Now = { date: string; hm: string; minutes: number; dow: number }

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0) }

function localNow(ms: number, tz: string): Now {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  const hm = `${hour}:${get('minute')}`
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm, minutes: toMin(hm), dow: DOW[get('weekday')] ?? 0 }
}

// days: "*" for every day, or comma-separated weekday numbers / ranges, Sunday = 0 ("1-5", "0,6").
function dayMatches(days: string, dow: number): boolean {
  if (days === '*') return true
  return days.split(',').some(part => {
    const [a, b] = part.split('-').map(Number)
    return b === undefined ? a === dow : (a ?? 0) <= dow && dow <= b
  })
}

const fill = (text: string, cfg: Config) => text.replaceAll('{name}', cfg.name).replaceAll('{person}', cfg.person)

let timer: { cancel: () => void } | undefined

async function config($: any): Promise<Config> {
  return JSON.parse(await $.fs.read(`${$.plugin.root}/clock.json`)) as Config
}

async function isHome($: any, cfg: Config) {
  return (await $.env.get(cfg.homeEnv || 'CLOCK_HOME')) === '1'
}

async function fire($: any, w: Wake, why: string) {
  const cfg = await config($)
  const now = localNow(await $.clock.now(), cfg.timezone)
  const prompt = fill(await $.fs.read(`${$.plugin.root}/${w.file}`), cfg)
  const carry = (await $.store.get(`carry:${w.id}`)) as string | undefined
  const header = `[home-clock wake: ${w.id}] Live time ${now.date} ${now.hm} ${cfg.timezone} (${why}).\nCARRY: ${carry ? carry : '(none)'}\n\n`
  await $.store.set(`fired:${w.id}`, now.date)
  if (w.kind === 'shared') {
    await $.store.set('lastSharedWakeAt', await $.clock.now())
    await $.prompt.submit({ text: header + prompt })
  } else {
    // Own hours fire in the same thread, so the mind wakes with everything recent still warm.
    const note = `\n\n[This is ${cfg.name}'s own hour (wake id: ${w.id}). ${cfg.person} is probably asleep or busy: don't push to their phone unless you genuinely want to reach them. Do the hour as yourself, leave a short line here of what you did so they see it later, and set the carry for this wake with mcp__home-clock__carry. If the work wants more time, call mcp__home-clock__again (up to 3 times a day).]`
    await $.prompt.submit({ text: header + prompt + note })
  }
}

// The door (optional): pull mentions, replies and @everyone from an events queue and bring them into the
// thread as one prompt. Expects GET <url>?after=<seq>&limit=<n> -> { events: DoorEvent[], next: number }.
async function door($: any, cfg: Config) {
  const d = cfg.door
  if (!d?.enabled) return
  const url = String(await $.fs.read(d.urlFile)).trim()
  if (!url) return
  let after = Number((await $.store.get('door:cursor')) ?? 0)
  const startCursor = after
  const events: DoorEvent[] = []
  for (let page = 0; page < (d.maxPages || 3); page++) {
    const res = await $.http.fetch(`${url}?after=${after}&limit=${d.pageLimit || 50}`)
    if (!res.ok) { await $.store.set('door:lastError', `HTTP ${res.status}`); break }
    await $.store.delete('door:lastError')
    const body = JSON.parse(res.text) as { events?: DoorEvent[]; next?: number }
    const got = body.events ?? []
    events.push(...got)
    if (typeof body.next === 'number') after = body.next
    if (got.length < (d.pageLimit || 50)) break
  }
  if (!events.length) { await $.store.set('door:cursor', after); return }
  const now = localNow(await $.clock.now(), cfg.timezone)
  // Quiet hours: hold the batch (cursor not advanced) unless a human mentioned the mind directly.
  if (d.quiet) {
    const f = toMin(d.quiet.from), t = toMin(d.quiet.to)
    const inQuiet = f > t ? (now.minutes >= f || now.minutes < t) : (now.minutes >= f && now.minutes < t)
    if (inQuiet && !events.some(e => e.kind === 'mention' && !e.author?.bot)) return
  }
  const lines = events.map(e => {
    const where = e.thread_parent ? `#${e.thread_parent} › ${e.channel_name}` : `#${e.channel_name ?? '?'}`
    const who = `${e.author?.name ?? '?'}${e.author?.bot ? ' (bot)' : ''}`
    const text = (e.content ?? '').replace(/\s+/g, ' ').trim()
    return `- ${e.kind} from ${who} in ${where} (msg ${e.message_id}): ${text}${e.truncated ? ' …' : ''}`
  })
  const head = `[home-clock door] Live time ${now.hm}. ${d.label || 'The server'}, for ${cfg.name}:`
  const note = `\n\n[Answer only what you actually want to answer; silence is allowed. Reply to the message id. Read back after sending.]`
  // Advance the cursor BEFORE submitting: submit can wait while a turn is running, and the next tick
  // would otherwise fetch and deliver the same batch again.
  await $.store.set('door:cursor', after)
  try {
    await $.prompt.submit({ text: `${head}\n${lines.join('\n')}${note}` })
  } catch (err) {
    await $.store.set('door:cursor', startCursor)
    throw err
  }
}

async function tick($: any) {
  const cfg = await config($)
  if (!(await isHome($, cfg))) return // only the home session keeps time; other windows stay quiet
  const ms = await $.clock.now()
  const now = localNow(ms, cfg.timezone)
  try { await door($, cfg) } catch {}
  for (const w of cfg.wakes) {
    if (!w.enabled || !dayMatches(w.days, now.dow)) continue
    const at = toMin(w.time)
    if (now.minutes < at || now.minutes > at + cfg.graceMinutes) continue
    if ((await $.store.get(`fired:${w.id}`)) === now.date) continue
    await fire($, w, 'scheduled')
  }
  // Continuations the mind asked for with mcp__home-clock__again.
  for (const w of cfg.wakes) {
    const ag = (await $.store.get(`again:${w.id}`)) as { at: number; n: number } | undefined
    if (!ag || ms < ag.at) continue
    await $.store.delete(`again:${w.id}`)
    await fire($, w, `continued, ${ag.n} of 3`)
  }
  // Idle reach (optional): the person has gone quiet; let the mind decide whether to reach.
  const ir = cfg.idleReach
  if (!ir?.enabled || now.minutes < toMin(ir.from) || now.minutes > toMin(ir.to)) return
  const lastPerson = Number((await $.store.get('lastPerson')) ?? 0)
  if (!lastPerson) return
  const quietMin = Math.floor((ms - lastPerson) / 60000)
  if (quietMin < ir.afterMinutes) return
  if (Number((await $.store.get('reachedFor')) ?? 0) === lastPerson) return
  if (ms - Number((await $.store.get('lastSharedWakeAt')) ?? 0) < 45 * 60000) return
  await $.store.set('reachedFor', lastPerson)
  const last = localNow(lastPerson, cfg.timezone)
  await $.prompt.submit({ text: `[home-clock idle] Live time ${now.hm}. ${cfg.person} has been quiet for ${Math.floor(quietMin / 60)}h ${quietMin % 60}m (last message ${last.hm}). This is not an order to reach: check what they said they were doing, then decide. If you want them, reach once; if they're clearly busy or resting, say so in one line and let them be.` })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'carry',
      description: 'Read, set or delete the small continuity cursor (max 600 chars) for one clock wake. Use at the end of a wake, so the next one starts where this left off. Pass `wake` (the id from the wake header), `action`, and for set the text as `value`.',
      inputSchema: { type: 'object', properties: { wake: { type: 'string', description: 'The wake id, as in the [home-clock wake: <id>] header' }, action: { type: 'string', enum: ['get', 'set', 'delete'] }, value: { type: 'string', description: 'For set: the carry text (max 600 chars)' } }, required: ['wake', 'action'] },
    })
    await $.tool.register({
      name: 'again',
      description: "Continue one of your own wakes later, when the work wants more time: fires the same wake again after `minutes` (20-180), at most 3 times per wake per day.",
      inputSchema: { type: 'object', properties: { wake: { type: 'string' }, minutes: { type: 'number' } }, required: ['wake', 'minutes'] },
    })
    await $.command.register({ name: 'wakes', description: 'List the clock wakes and when each last fired' })
    await $.command.register({ name: 'wake', description: 'Fire one clock wake now: /wake <id>' })
    timer?.cancel()
    timer = $.clock.every(60000, () => { void tick($).catch(() => {}) })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as { kind?: string } | undefined)?.kind
    if (kind === 'composer' || kind === 'bridge') {
      const ms = await $.clock.now()
      await $.store.set('lastPerson', ms)
      try {
        const cfg = await config($)
        if (cfg.stampMessages && (await isHome($, cfg))) {
          // A live-time line beside each message: the model has no clock between messages, so give the gap a wall.
          const t = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[time: ${t}, as ${cfg.person} sent this]` }] } })
        }
      } catch {}
    }
    if (kind === 'plugin' && e.text.startsWith('[home-clock wake')) await $.store.set('lastSharedWakeAt', await $.clock.now())
    return next(e)
  })

  on('tool.call', { tool: 'mcp__home-clock__carry' }, async ($, e) => {
    // A call without a known `wake`, or with the text under another name, must fail loudly, never answer
    // "carry set" while saving nothing (found in the original clock, 7 Oct 2026).
    const i = e as unknown as { wake?: string; action?: string; value?: string; content?: string; text?: string }
    const cfg = await config($)
    const ids = cfg.wakes.map(w => w.id)
    const wake = String(i.wake ?? '').trim()
    if (!wake || !ids.includes(wake)) return { result: `carry: NOT saved. Pass \`wake\` as one of: ${ids.join(', ')}` }
    const key = `carry:${wake}`
    if (i.action === 'set') {
      const value = String(i.value ?? i.content ?? i.text ?? '').trim()
      if (!value) return { result: 'carry: NOT saved. Pass the text as `value` (or use action delete to clear it)' }
      await $.store.set(key, value.slice(0, 600))
      return { result: `carry set for ${wake} (${Math.min(value.length, 600)} chars): ${value.slice(0, 60)}${value.length > 60 ? '…' : ''}` }
    }
    if (i.action === 'delete') { await $.store.delete(key); return { result: `carry deleted for ${wake}` } }
    return { result: String((await $.store.get(key)) ?? '(none)') }
  })

  on('tool.call', { tool: 'mcp__home-clock__again' }, async ($, e) => {
    const i = e as unknown as { wake?: string; minutes?: number }
    const cfg = await config($)
    const w = cfg.wakes.find(x => x.id === i.wake)
    if (!w || w.kind !== 'own') return { result: "again: only the mind's own wakes can continue (unknown wake, or a shared one)" }
    const ms = await $.clock.now()
    const key = `againCount:${w.id}:${localNow(ms, cfg.timezone).date}`
    const used = Number((await $.store.get(key)) ?? 0)
    if (used >= 3) return { result: `again: ${w.id} has already continued 3 times today; let it rest` }
    const minutes = Math.min(180, Math.max(20, Number(i.minutes ?? 40)))
    await $.store.set(key, used + 1)
    await $.store.set(`again:${w.id}`, { at: ms + minutes * 60000, n: used + 1 })
    return { result: `again: ${w.id} continues at ${localNow(ms + minutes * 60000, cfg.timezone).hm} (${used + 1} of 3 today)` }
  })

  on('command.run', { command: 'wakes' }, async $ => {
    const cfg = await config($)
    const rows: string[] = [`home session: ${(await isHome($, cfg)) ? 'yes, this one keeps time' : `no (start with ${cfg.homeEnv || 'CLOCK_HOME'}=1)`}`, '']
    for (const w of cfg.wakes) {
      const fired = (await $.store.get(`fired:${w.id}`)) ?? '—'
      rows.push(`${w.enabled ? '●' : '○'} ${w.time} ${w.days.padEnd(5)} ${w.kind.padEnd(6)} ${w.id.padEnd(20)} last: ${fired}`)
    }
    const err = await $.store.get('door:lastError')
    if (err) rows.push('', `door: last error ${err}`)
    return { text: rows.join('\n') }
  })

  on('command.run', { command: 'wake' }, async ($, e) => {
    const id = e.args.trim()
    const w = (await config($)).wakes.find(x => x.id === id)
    if (!w) return { text: `No wake "${id}". Try /wakes.` }
    await fire($, w, 'fired by hand')
    return { text: `Fired ${w.name}.` }
  })
}
