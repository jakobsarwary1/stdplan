-- Erlaubt angemeldeten Nutzern (authenticated), Dateien im privaten
-- Storage-Bucket "documents" hochzuladen, zu lesen, zu aktualisieren und zu
-- löschen. Ohne diese Policies blockiert Supabase JEDEN Zugriff auf den
-- Bucket (Row-Level-Security ist für Storage standardmäßig restriktiv),
-- was zum Fehler "new row violates row-level security policy for table
-- objects" führt.
--
-- Die eigentliche Mandantentrennung (welche Firma welches Dokument sehen
-- darf) erfolgt bereits auf Anwendungsebene über die driver_documents- bzw.
-- vehicle_documents-Tabelle (dort greift die normale RLS mit
-- app.current_company_id) - ein Nutzer bekommt nur dann eine signierte
-- Download-URL für eine Datei, wenn er zuvor über diese Tabellen Zugriff
-- auf den zugehörigen Datensatz hatte. Diese Storage-Policy regelt nur die
-- technische Ebene (darf überhaupt hochgeladen/gelesen werden).

CREATE POLICY "Angemeldete Nutzer koennen Dokumente hochladen"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Angemeldete Nutzer koennen Dokumente lesen"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'documents');

CREATE POLICY "Angemeldete Nutzer koennen Dokumente aktualisieren"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'documents')
WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Angemeldete Nutzer koennen Dokumente loeschen"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'documents');
