-- Neue Felder im Fahrerprofil (Beschäftigung-Tab): Eintrittsdatum,
-- SV-Nummer, Krankenkasse, Steuer-ID.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "hireDate" TIMESTAMP(3);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "socialSecurityNumber" TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "healthInsuranceProvider" TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS "taxId" TEXT;
