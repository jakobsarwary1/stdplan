-- Bereinigt bereits entstandene Duplikat-Schichten (gleiches Fahrzeug +
-- gleiches Datum, mehrfach angelegt durch wiederholtes "Übernehmen" vor
-- dem Fix). Behält jeweils die ZULETZT erstellte Schicht, löscht ältere
-- Duplikate für dieselbe Fahrzeug+Datum-Kombination.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "vehicleId", date
           ORDER BY "createdAt" DESC
         ) AS rn
  FROM shifts
)
DELETE FROM shifts
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
