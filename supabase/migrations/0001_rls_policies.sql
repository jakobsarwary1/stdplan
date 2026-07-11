-- FleetOS: Row-Level-Security (RLS) für die Mandantentrennung
--
-- WICHTIG, unbedingt lesen: Die Standard-Verbindungszeichenfolge, die Supabase
-- unter "Connection string" anzeigt, verbindet sich als Postgres-Superuser
-- ("postgres"). Ein Superuser UMGEHT Row-Level-Security automatisch,
-- unabhängig davon, welche Policies hier definiert werden! Würde Prisma über
-- diese Verbindung laufen, wäre die komplette RLS wirkungslos - reine
-- Kosmetik. Deshalb legen wir hier eine EIGENE, eingeschränkte Datenbank-
-- Rolle an, die KEINEN RLS-Bypass hat, und Prisma verbindet sich über DIESE
-- Rolle (DATABASE_URL/DIRECT_URL in .env entsprechend anpassen, siehe README).
--
-- Ausführen: Supabase-Dashboard -> SQL Editor -> dieses Skript einfügen und
-- ausführen, NACHDEM `npx prisma migrate dev` die Tabellen angelegt hat.

-- 1) Eingeschränkte Rolle für die Anwendung (kein BYPASSRLS, kein Superuser)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'BITTE_SICHERES_PASSWORT_EINTRAGEN';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- 2) RLS aktivieren auf allen mandantenspezifischen Tabellen
ALTER TABLE companies                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members               ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_costs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_driver_assignments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_unavailability         ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_high_demand_windows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE minijob_settings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_templates               ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_template_shifts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_breaks                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE compensation_formulas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_entries                ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_records             ENABLE ROW LEVEL SECURITY;

-- 3) Session-Variablen, die die App pro Request/Transaktion setzt:
--    app.current_company_id  -> UUID des Unternehmens des eingeloggten Nutzers
--    app.is_super_admin      -> 'true' | 'false'
--    Siehe src/lib/prisma.ts (withTenantContext) für das Setzen dieser Werte.

-- companies: Super-Admin sieht alle, normale Nutzer nur ihr eigenes Unternehmen
CREATE POLICY companies_isolation ON companies
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
  );

-- company_members: Super-Admin sieht alle, sonst nur Mitglieder des eigenen Unternehmens
CREATE POLICY company_members_isolation ON company_members
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid
  );

-- Alle übrigen Tabellen: strikt auf companyId des aktuellen Kontexts beschränkt
-- (Super-Admin hat hier bewusst KEINEN Zugriff - operative Daten sind nicht
-- seine Aufgabe, siehe Rollenmodell im Super-Prompt Abschnitt 3).
CREATE POLICY tenant_isolation ON company_settings
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON vehicles
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON drivers
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON shift_templates
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON demand_profiles
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON shifts
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON compensation_formulas
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON revenue_entries
  USING ("companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- Tabellen ohne eigene companyId-Spalte: Isolation über die Elterntabelle (Join)
CREATE POLICY tenant_isolation ON vehicle_documents
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = "vehicleId"
    AND v."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON vehicle_costs
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = "vehicleId"
    AND v."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON vehicle_driver_assignments
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = "vehicleId"
    AND v."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON maintenance_records
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = "vehicleId"
    AND v."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON driver_documents
  USING (EXISTS (SELECT 1 FROM drivers d WHERE d.id = "driverId"
    AND d."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON driver_unavailability
  USING (EXISTS (SELECT 1 FROM drivers d WHERE d.id = "driverId"
    AND d."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON driver_high_demand_windows
  USING (EXISTS (SELECT 1 FROM drivers d WHERE d.id = "driverId"
    AND d."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON minijob_settings
  USING (EXISTS (SELECT 1 FROM drivers d WHERE d.id = "driverId"
    AND d."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON shift_template_shifts
  USING (EXISTS (SELECT 1 FROM shift_templates st WHERE st.id = "shiftTemplateId"
    AND st."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
CREATE POLICY tenant_isolation ON shift_breaks
  USING (EXISTS (SELECT 1 FROM shifts s WHERE s.id = "shiftId"
    AND s."companyId" = NULLIF(current_setting('app.current_company_id', true), '')::uuid));
