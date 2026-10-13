# stdplan – Dienstplan-Werkzeug

Schlankes Werkzeug zum **Erstellen des Dienstplans** für einen Fahrbetrieb
(eine Firma): Next.js + Supabase (Auth/DB) + Prisma + Row-Level-Security.
Enthält Fahrzeuge, Fahrer, Schichtmodelle, Nachfrageprofile, die
Auto-Planungs-Engine, den Dienstplan mit Zuschlägen (§ 3b EStG) und
Excel-Export. Bewusst ohne Lohnabrechnung, Dokumentenverwaltung oder
Mehrmandanten-Verwaltung.

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

## 6. Firma und Login anlegen

Legt die eine Firma, einen Firmen-Admin (Login) sowie die Standard-Schicht-
modelle und Nachfrageprofile an:

```bash
SEED_ADMIN_EMAIL=du@beispiel.de SEED_ADMIN_PASSWORD=EinSicheresPasswort123 SEED_COMPANY_NAME="Meine Firma" npm run prisma:seed
```

## 7. Lokal starten

```bash
npm run dev
```

Unter `http://localhost:3000/login` mit den Zugangsdaten aus Schritt 6
einloggen → landet auf der Übersicht (`/dashboard`).

## 8. Auf GitHub + Vercel deployen

1. Repo auf GitHub erstellen, Projekt pushen (`git init`, `git add .`,
   `git commit`, `git remote add origin ...`, `git push`).
2. Auf [vercel.com](https://vercel.com) mit GitHub einloggen, das Repo
   importieren.
3. Alle Variablen aus `.env` bei Vercel unter **Settings → Environment
   Variables** eintragen.
4. Deploy auslösen – ab jetzt deployt Vercel automatisch bei jedem Push auf
   `main`.

## Funktionsumfang

Fahrzeuge und Fahrer verwalten, Schichtmodelle und Nachfrageprofile
konfigurieren, den Dienstplan fahrzeug- oder stundenbasiert automatisch
erzeugen (gesetzeskonform: Ruhezeiten, Pausen, 6-Tage-Regel) und als Excel
mit Zuschlags- und Lohn-Zusammenfassung exportieren. Bezahlte Stunden =
Beginn→Ende (Pause bezahlt, Arbeitsweg zählt nicht).
