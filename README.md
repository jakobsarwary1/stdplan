# FleetOS – Phase 1: Fundament

Multi-Tenant-Fundament: Next.js + Supabase (Auth/DB/Storage) + Prisma +
Row-Level-Security + Super-Admin-Bereich zum Anlegen/Verwalten von
Unternehmen. Enthält bewusst noch KEINE Fahrzeug-/Fahrer-/Schichtverwaltung
(Phase 2–8, siehe Super-Prompt).

**Wichtiger Hinweis:** Dieses Projekt wurde ohne Internetzugriff geschrieben
und konnte daher nicht selbst installiert/gestartet getestet werden (kein
`npm install`, kein `npm run build` möglich). Der Code folgt etablierten,
gut dokumentierten Mustern (Next.js App Router, `@supabase/ssr`, Prisma),
trotzdem: nach der Installation gründlich durchklicken und bei Bedarf mit
Claude Code weiter debuggen, falls beim ersten Start etwas hakt.

## 1. Voraussetzungen

- Node.js 20+ auf deinem Rechner
- Ein kostenloses Konto auf [supabase.com](https://supabase.com)
- Ein GitHub-Account + neues, leeres Repository

## 2. Supabase-Projekt anlegen

1. Neues Projekt auf supabase.com erstellen, Region z. B. `eu-central-1`
   (Frankfurt) für niedrige Latenz aus Deutschland.
2. **Project Settings → API**: `Project URL` und `anon public key` notieren.
3. **Project Settings → API**: `service_role` Key notieren (geheim halten!).
4. **Project Settings → Database → Connection string**: sowohl die
   "Transaction" (gepoolt, Port 6543) als auch die "Session"-Variante
   (direkt, Port 5432) kopieren.

## 3. Projekt lokal einrichten

```bash
npm install
cp .env.example .env
# .env mit den Werten aus Schritt 2 befüllen
```

## 4. Datenbank-Schema anlegen

```bash
npm run prisma:migrate
```

Das erzeugt alle Tabellen aus `prisma/schema.prisma` in deiner Supabase-DB.

## 5. Row-Level-Security aktivieren (wichtig, nicht überspringen!)

1. Supabase-Dashboard → **SQL Editor**
2. Inhalt von `supabase/migrations/0001_rls_policies.sql` einfügen
3. **Vor dem Ausführen**: das Platzhalter-Passwort
   `BITTE_SICHERES_PASSWORT_EINTRAGEN` durch ein echtes, sicheres Passwort
   ersetzen
4. Ausführen
5. Danach in deiner `.env` `DATABASE_URL` und `DIRECT_URL` so anpassen, dass
   sie **als `app_user` verbinden** statt als `postgres`
   (Nutzername im Connection-String austauschen, Passwort aus Schritt 3
   verwenden) – sonst greift die Mandantentrennung nicht wirklich (siehe
   Kommentar oben in der SQL-Datei).

## 6. Ersten Super-Admin anlegen

```bash
SEED_SUPER_ADMIN_EMAIL=du@beispiel.de SEED_SUPER_ADMIN_PASSWORD=EinSicheresPasswort123 npm run prisma:seed
```

## 6b. Storage-Bucket für Dokumente einrichten (für Phase 2 nötig)

Fahrer- und Fahrzeugdokumente (Führerschein, Fahrzeugschein, TÜV-Bericht etc.)
werden in Supabase Storage abgelegt.

1. Supabase-Dashboard → **Storage** → **New bucket**
2. Name: **`documents`** (exakt so, wird im Code referenziert)
3. **Public bucket: AUS lassen** (Dokumente sind sensibel, Zugriff läuft
   ausschließlich über befristete, signierte URLs aus der App heraus)
4. Erstellen

## 7. Lokal starten

```bash
npm run dev
```

Unter `http://localhost:3000/login` mit den Zugangsdaten aus Schritt 6
einloggen → landet automatisch im Super-Admin-Bereich (`/admin`).

## 8. Auf GitHub + Vercel deployen

1. Repo auf GitHub erstellen, Projekt pushen (`git init`, `git add .`,
   `git commit`, `git remote add origin ...`, `git push`).
2. Auf [vercel.com](https://vercel.com) mit GitHub einloggen, das Repo
   importieren.
3. Alle Variablen aus `.env` bei Vercel unter **Settings → Environment
   Variables** eintragen.
4. Deploy auslösen – ab jetzt deployt Vercel automatisch bei jedem Push auf
   `main`.

## Was als Nächstes kommt (Phase 3+)

**Phase 2 (Fahrzeug- und Fahrerverwaltung) ist bereits enthalten:** Fahrzeuge
und Fahrer anlegen/bearbeiten/löschen, Dokumenten-Upload, Fahrzeug-Fahrer-
Zuordnung mit Rollen (Stammfahrer etc.). OCR-Datenübernahme kommt bewusst
erst in Phase 8.

Siehe Super-Prompt Abschnitt 7 für den Rest: Schichtmodelle &
Nachfrageprofile, die Auto-Planungs-Engine, der Dienstplan, Vergütung/
Lohnabrechnung, Finanzen & Wartung.
