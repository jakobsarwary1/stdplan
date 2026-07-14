import Link from 'next/link'

type ShiftEntry = {
  id: string
  driverName: string | null
  start: string
  end: string
  isSubstitute: boolean
}

const WEEKDAY_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

function isNightShift(start: string, end: string, nightStart: string, nightEnd: string): boolean {
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  let s = toMin(start)
  let e = toMin(end)
  if (e <= s) e += 1440
  const nsMin = toMin(nightStart)
  let neMin = toMin(nightEnd)
  if (neMin <= nsMin) neMin += 1440
  const overlap = Math.min(e, nsMin + 1440) > Math.max(s, nsMin) ? Math.min(e, neMin) - Math.max(s, nsMin) : 0
  return overlap >= 120
}

export function MonthCalendar({
  year,
  month, // 1-12
  shiftsByDate,
  nightStart = '22:00',
  nightEnd = '06:00',
  basePath
}: {
  year: number
  month: number
  shiftsByDate: Map<string, ShiftEntry[]>
  nightStart?: string
  nightEnd?: string
  basePath: string
}) {
  const firstOfMonth = new Date(year, month - 1, 1)
  const daysInMonth = new Date(year, month, 0).getDate()
  // Montag = 0 ... Sonntag = 6 für die Gridausrichtung
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7

  const cells: (number | null)[] = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)

  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year

  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{monthNames[month - 1]} {year}</h2>
        <div className="flex gap-2 text-sm">
          <Link href={`${basePath}?year=${prevYear}&month=${prevMonth}`} className="rounded-lg border border-border px-3 py-1 text-textMuted hover:text-text">
            ← Vorheriger Monat
          </Link>
          <Link href={`${basePath}?year=${nextYear}&month=${nextMonth}`} className="rounded-lg border border-border px-3 py-1 text-textMuted hover:text-text">
            Nächster Monat →
          </Link>
        </div>
      </div>

      <div className="mb-2 flex gap-4 text-xs text-textMuted">
        <span>🌙 Nachtschicht</span>
        <span className="text-danger">● Sonntag</span>
      </div>

      <div className="grid grid-cols-7 gap-1.5 rounded-xl border border-border bg-surface p-2">
        {WEEKDAY_HEADERS.map((h, i) => (
          <div key={h} className={`px-1 pb-1 text-center text-xs font-semibold uppercase ${i === 6 ? 'text-danger' : 'text-textMuted'}`}>
            {h}
          </div>
        ))}

        {cells.map((day, idx) => {
          if (day === null) return <div key={idx} className="min-h-[60px] rounded-lg" />

          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const isSunday = idx % 7 === 6
          const dayShifts = shiftsByDate.get(dateStr) ?? []

          return (
            <div
              key={idx}
              className={`min-h-[60px] rounded-lg border p-1.5 ${isSunday ? 'border-danger/30 bg-danger/5' : 'border-border'}`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className={`text-xs font-semibold ${isSunday ? 'text-danger' : 'text-textMuted'}`}>{day}</span>
                {isSunday && <span className="text-danger">●</span>}
              </div>
              <div className="space-y-0.5">
                {dayShifts.length > 0 && dayShifts.map((s) => {
                    const night = isNightShift(s.start, s.end, nightStart, nightEnd)
                    return (
                      <div key={s.id} className="truncate rounded bg-surfaceAlt px-1 py-0.5 text-[10px]" title={`${s.driverName ?? '—'} ${s.start}-${s.end}`}>
                        {night && '🌙'} {s.driverName?.split(' ')[0] ?? '—'} {s.start}
                        {s.isSubstitute && ' (V)'}
                      </div>
                    )
                  })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
