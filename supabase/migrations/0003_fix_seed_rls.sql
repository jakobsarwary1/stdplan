-- Korrektur: Beim Anlegen eines Unternehmens werden automatisch Standard-
-- Schichtmodelle und Nachfrageprofile durch den Super-Admin angelegt
-- (siehe createCompany-Action). Diese drei Tabellen brauchten dieselbe
-- Super-Admin-Ausnahme wie schon company_settings (0002).

DROP POLICY IF EXISTS tenant_isolation ON shift_templates;
CREATE POLICY tenant_isolation ON shift_templates
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = NULLIF(current_setting('app.current_company_id', true), '')
  );

DROP POLICY IF EXISTS tenant_isolation ON demand_profiles;
CREATE POLICY tenant_isolation ON demand_profiles
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR "companyId" = NULLIF(current_setting('app.current_company_id', true), '')
  );

DROP POLICY IF EXISTS tenant_isolation ON shift_template_shifts;
CREATE POLICY tenant_isolation ON shift_template_shifts
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM shift_templates st WHERE st.id = "shiftTemplateId"
      AND st."companyId" = NULLIF(current_setting('app.current_company_id', true), '')
    )
  );
