import { createClient } from '@/lib/supabase/server'

/**
 * Lädt eine Datei in den Supabase-Storage-Bucket "documents" hoch, unter
 * einem nach Unternehmen getrennten Pfad (companyId/...), und gibt eine
 * signierte, zeitlich befristete URL zurück (Bucket ist NICHT öffentlich,
 * da Fahrer-/Fahrzeugdokumente sensible Daten wie Ausweiskopien enthalten
 * können).
 *
 * Setzt voraus, dass im Supabase-Dashboard unter Storage ein privater
 * Bucket namens "documents" existiert (siehe README, Abschnitt "Storage
 * einrichten").
 */
export async function uploadDocument(companyId: string, file: File): Promise<string> {
  const supabase = createClient()
  const ext = file.name.split('.').pop()
  const path = `${companyId}/${crypto.randomUUID()}.${ext}`

  const { error } = await supabase.storage.from('documents').upload(path, file, {
    contentType: file.type,
    upsert: false
  })

  if (error) throw new Error(`Upload fehlgeschlagen: ${error.message}`)

  return path
}

/** Erzeugt eine befristet gültige Download-URL (1 Stunde) für einen gespeicherten Dokumentenpfad. */
export async function getDocumentUrl(path: string): Promise<string | null> {
  const supabase = createClient()
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(path, 3600)
  if (error) return null
  return data.signedUrl
}
