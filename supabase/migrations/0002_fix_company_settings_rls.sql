-- Korrektur: company_settings brauchte eine Super-Admin-Ausnahme, da beim
-- Anlegen eines neuen Unternehmens durch den Super-Admin automatisch ein
-- zugehöriger Einstellungs-Datensatz mit angelegt wird.

DROP POLICY IF EXISTS tenant_isolation ON company_settings;

CREATE POLICY tenant_isolation ON company_settings
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = NULLIF(current_setting('app.current_company_id', true), '')
  );
