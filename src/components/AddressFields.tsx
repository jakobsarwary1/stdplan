'use client'

import { useState, useRef } from 'react'
import { Input, Field } from '@/components/ui'

type AddressSuggestion = {
  street: string
  postalCode: string
  city: string
}

/**
 * Adressfelder (Straße, Hausnummer, PLZ, Ort) mit vollständigen
 * Adress-Vorschlägen während der Eingabe (OpenStreetMap Nominatim,
 * kostenlos, kein API-Key nötig). Jeder Vorschlag zeigt Straße + PLZ/Ort
 * zweizeilig an, z. B.:
 *   Maxmusterstr.
 *   12345 Musterstadt
 * Beim Anklicken eines Vorschlags werden Straße, PLZ UND Ort automatisch
 * übernommen - es muss nur noch die Hausnummer eingetippt werden.
 *
 * Best-Effort: schlägt die Anfrage fehl (z. B. keine Internetverbindung),
 * kann weiterhin ganz normal manuell getippt werden - nichts wird blockiert.
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
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adress-Vorschläge nachladen, während getippt wird (debounced, damit
  // nicht bei jedem Tastendruck eine Anfrage rausgeht). Liefert vollständige
  // Adressen (Straße + PLZ + Ort), nicht nur den Straßennamen - dieselbe
  // Straße kann ja in mehreren Städten vorkommen.
  function handleStreetChange(value: string) {
    setStreet(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=de&limit=8&q=${encodeURIComponent(value + ', Deutschland')}`
        )
        if (!res.ok) return
        const data: { address?: { road?: string; postcode?: string; city?: string; town?: string; village?: string; municipality?: string } }[] = await res.json()

        const seen = new Set<string>()
        const results: AddressSuggestion[] = []
        data.forEach((d) => {
          const road = d.address?.road
          const postcode = d.address?.postcode
          const place = d.address?.city ?? d.address?.town ?? d.address?.village ?? d.address?.municipality
          if (!road || !postcode || !place) return
          const key = `${road}|${postcode}|${place}`
          if (seen.has(key)) return
          seen.add(key)
          results.push({ street: road, postalCode: postcode, city: place })
        })

        setSuggestions(results)
        setShowSuggestions(results.length > 0)
      } catch {
        // Netzwerkfehler o.ä. - Vorschläge einfach weglassen, manuelle Eingabe bleibt möglich
      }
    }, 400)
  }

  function selectSuggestion(s: AddressSuggestion) {
    setStreet(s.street)
    setPostalCode(s.postalCode)
    setCity(s.city)
    setShowSuggestions(false)
  }

  return (
    <>
      <div className="grid grid-cols-[2fr_1fr] gap-4">
        <Field label="Straße">
          <div className="relative">
            <Input
              name="street"
              value={street}
              onChange={(e) => handleStreetChange(e.target.value)}
              onFocus={() => setShowSuggestions(suggestions.length > 0)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              autoComplete="off"
              placeholder="z. B. Musterstraße"
            />
            {showSuggestions && (
              <ul className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface shadow-lg">
                {suggestions.map((s, i) => (
                  <li
                    key={`${s.street}-${s.postalCode}-${i}`}
                    className="cursor-pointer px-3 py-2 text-sm hover:bg-surfaceAlt"
                    onMouseDown={() => selectSuggestion(s)}
                  >
                    <div>{s.street}</div>
                    <div className="text-xs text-textMuted">{s.postalCode} {s.city}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>
        <Field label="Hausnummer">
          <Input name="houseNumber" defaultValue={defaultHouseNumber ?? ''} />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-4">
        <Field label="PLZ">
          <Input
            name="postalCode"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
            inputMode="numeric"
            maxLength={5}
          />
        </Field>
        <Field label="Ort">
          <Input name="city" value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
      </div>
    </>
  )
}
