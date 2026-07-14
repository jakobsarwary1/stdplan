'use client'

import { useState, useRef, useEffect } from 'react'
import { Input, Field } from '@/components/ui'

/**
 * Adressfelder (Straße, Hausnummer, PLZ, Ort) mit:
 * - Straßen-Vorschlägen während der Eingabe (OpenStreetMap Nominatim,
 *   kostenlos, kein API-Key nötig)
 * - automatischem Ausfüllen des Orts, sobald eine gültige 5-stellige PLZ
 *   eingegeben wurde (Zippopotam.us, kostenlos, kein API-Key nötig)
 *
 * Beide Diensте sind Best-Effort: schlägt die Anfrage fehl (z. B. keine
 * Internetverbindung), kann weiterhin ganz normal manuell getippt werden -
 * nichts wird blockiert.
 */
export function AddressFields({
  defaultStreet, defaultHouseNumber, defaultPostalCode, defaultCity
}: {
  defaultStreet?: string
  defaultHouseNumber?: string
  defaultPostalCode?: string
  defaultCity?: string
}) {
  const [street, setStreet] = useState(defaultStreet ?? '')
  const [postalCode, setPostalCode] = useState(defaultPostalCode ?? '')
  const [city, setCity] = useState(defaultCity ?? '')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Straßen-Vorschläge nachladen, während getippt wird (debounced, damit
  // nicht bei jedem Tastendruck eine Anfrage rausgeht)
  function handleStreetChange(value: string) {
    setStreet(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 3) {
      setSuggestions([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const query = city ? `${value}, ${postalCode} ${city}, Deutschland` : `${value}, Deutschland`
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=de&limit=5&q=${encodeURIComponent(query)}`
        )
        if (!res.ok) return
        const data: { address?: { road?: string } }[] = await res.json()
        const roads = Array.from(new Set(data.map((d) => d.address?.road).filter((r): r is string => !!r)))
        setSuggestions(roads)
        setShowSuggestions(roads.length > 0)
      } catch {
        // Netzwerkfehler o.ä. - Vorschläge einfach weglassen, manuelle Eingabe bleibt möglich
      }
    }, 400)
  }

  // Ort automatisch nachladen, sobald eine gültige 5-stellige PLZ eingetippt wurde
  useEffect(() => {
    if (!/^\d{5}$/.test(postalCode)) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`https://api.zippopotam.us/de/${postalCode}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const placeName = data?.places?.[0]?.['place name']
        if (placeName && !cancelled) setCity(placeName)
      } catch {
        // Best-Effort - bei Fehler bleibt das Feld einfach manuell editierbar
      }
    })()
    return () => { cancelled = true }
  }, [postalCode])

  return (
    <>
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-4">
        <Field label="Straße">
          <div className="relative">
            <Input
              name="street"
              value={street}
              onChange={(e) => handleStreetChange(e.target.value)}
              onFocus={() => setShowSuggestions(suggestions.length > 0)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              autoComplete="off"
            />
            {showSuggestions && (
              <ul className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface shadow-lg">
                {suggestions.map((s) => (
                  <li
                    key={s}
                    className="cursor-pointer px-3 py-2 text-sm hover:bg-surfaceAlt"
                    onMouseDown={() => { setStreet(s); setShowSuggestions(false) }}
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>
        <Field label="Hausnummer">
          <Input name="houseNumber" defaultValue={defaultHouseNumber ?? ''} />
        </Field>
        <Field label="PLZ">
          <Input
            name="postalCode"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            maxLength={5}
          />
        </Field>
      </div>
      <Field label="Ort">
        <Input name="city" value={city} onChange={(e) => setCity(e.target.value)} />
      </Field>
    </>
  )
}
