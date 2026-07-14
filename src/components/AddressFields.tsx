'use client'

import { useState, useRef, useEffect } from 'react'
import { Input, Field } from '@/components/ui'

type AddressSuggestion = {
  street: string
  postalCode: string
  city: string
}

/**
 * Adressfelder (Straße, Hausnummer, PLZ, Ort) mit vollständigen
 * Adress-Vorschlägen während der Eingabe (OpenStreetMap Nominatim,
 * kostenlos, kein API-Key nötig) - nutzt die STRUKTURIERTE "street="-Suche
 * statt einer freien Textsuche, da diese zuverlässiger auch kleinere Orte
 * findet (freie Textsuche gewichtet bekannte Großstädte oft zu stark).
 * Jeder Vorschlag zeigt Straße + PLZ/Ort zweizeilig an. Beim Anklicken
 * werden Straße, PLZ UND Ort automatisch übernommen.
 *
 * Zusätzlich: tippt man die PLZ manuell ein (ohne einen Vorschlag
 * anzuklicken), wird der Ort separat automatisch nachgeladen
 * (Zippopotam.us).
 *
 * Beide Dienste sind Best-Effort: schlägt eine Anfrage fehl, kann
 * weiterhin ganz normal manuell getippt werden - nichts wird blockiert.
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
  const lastPickedRef = useRef(false) // verhindert, dass direkt nach Auswahl eines Vorschlags erneut gesucht wird

  function handleStreetChange(value: string) {
    setStreet(value)
    lastPickedRef.current = false
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        // Photon (komoot) statt Nominatim - eigens für "während des Tippens
        // vorschlagen" gebaut (nicht nur allgemeine Geokodierung), findet
        // erfahrungsgemäß auch Straßen in kleineren Orten zuverlässiger.
        // Ebenfalls auf OpenStreetMap-Daten basierend, kostenlos, kein Key.
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(value)}&lat=51.16&lon=10.45&zoom=10&limit=20&lang=de&osm_tag=highway`
        )
        if (!res.ok) return
        const data: { features?: { properties?: { name?: string; street?: string; postcode?: string; city?: string; district?: string; countrycode?: string } }[] } = await res.json()

        const seen = new Set<string>()
        const results: AddressSuggestion[] = []
        ;(data.features ?? []).forEach((f) => {
          const p = f.properties
          if (!p || p.countrycode !== 'DE') return
          const road = p.street ?? p.name
          const postcode = p.postcode ?? ''
          const place = p.city ?? p.district
          if (!road || !place) return
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
    lastPickedRef.current = true
    setStreet(s.street)
    setPostalCode(s.postalCode)
    setCity(s.city)
    setShowSuggestions(false)
  }

  // Ort automatisch nachladen, sobald eine gültige 5-stellige PLZ manuell
  // eingetippt wurde (unabhängig davon, ob ein Straßen-Vorschlag angeklickt
  // wurde - falls doch, überspringen wir das, da der Ort dann schon
  // korrekt aus dem Vorschlag gesetzt wurde).
  useEffect(() => {
    if (lastPickedRef.current) { lastPickedRef.current = false; return }
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
              <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
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
            onChange={(e) => { lastPickedRef.current = false; setPostalCode(e.target.value.replace(/\D/g, '').slice(0, 5)) }}
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
