-- Rückbau auf ein reines Plan-Werkzeug (eine Firma):
-- entfernt Dokumente, Wartung, Fahrzeugkosten, Umsatz, Vergütungsformeln,
-- Minijob-Einstellungen, Monatsbestätigungen und die Super-Admin-Rolle.
-- Fahrer.hourlyRate bleibt (Lohn-Zusammenfassung im Dienstplan-Excel).

-- AlterEnum: super_admin entfällt. Bestehende super_admin-Zeilen vorher auf
-- company_owner umstellen, sonst scheitert der Cast auf das neue Enum.
BEGIN;
CREATE TYPE "MemberRole_new" AS ENUM ('company_owner', 'dispatcher', 'driver');
UPDATE "company_members" SET "role" = 'company_owner' WHERE "role" = 'super_admin';
ALTER TABLE "company_members" ALTER COLUMN "role" TYPE "MemberRole_new" USING ("role"::text::"MemberRole_new");
ALTER TYPE "MemberRole" RENAME TO "MemberRole_old";
ALTER TYPE "MemberRole_new" RENAME TO "MemberRole";
DROP TYPE "MemberRole_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "vehicle_documents" DROP CONSTRAINT "vehicle_documents_vehicleId_fkey";
ALTER TABLE "vehicle_costs" DROP CONSTRAINT "vehicle_costs_vehicleId_fkey";
ALTER TABLE "drivers" DROP CONSTRAINT "drivers_compensationFormulaId_fkey";
ALTER TABLE "driver_monthly_confirmations" DROP CONSTRAINT "driver_monthly_confirmations_driverId_fkey";
ALTER TABLE "driver_documents" DROP CONSTRAINT "driver_documents_driverId_fkey";
ALTER TABLE "minijob_settings" DROP CONSTRAINT "minijob_settings_driverId_fkey";
ALTER TABLE "compensation_formulas" DROP CONSTRAINT "compensation_formulas_companyId_fkey";
ALTER TABLE "revenue_entries" DROP CONSTRAINT "revenue_entries_companyId_fkey";
ALTER TABLE "revenue_entries" DROP CONSTRAINT "revenue_entries_driverId_fkey";
ALTER TABLE "maintenance_records" DROP CONSTRAINT "maintenance_records_vehicleId_fkey";

-- AlterTable
ALTER TABLE "company_settings" DROP COLUMN "cashNettingEnabled",
DROP COLUMN "minijobInsolvenzRate",
DROP COLUMN "minijobKvFlatRate",
DROP COLUMN "minijobMonthlyEarningLimit",
DROP COLUMN "minijobOtherRate",
DROP COLUMN "minijobPauschsteuerRate",
DROP COLUMN "minijobRvFlatRate",
DROP COLUMN "minijobU1Rate",
DROP COLUMN "minijobU2Rate";

-- AlterTable
ALTER TABLE "drivers" DROP COLUMN "compensationFormulaId",
DROP COLUMN "compensationMode";

-- DropTable
DROP TABLE "vehicle_documents";
DROP TABLE "vehicle_costs";
DROP TABLE "driver_monthly_confirmations";
DROP TABLE "driver_documents";
DROP TABLE "minijob_settings";
DROP TABLE "compensation_formulas";
DROP TABLE "revenue_entries";
DROP TABLE "maintenance_records";

-- DropEnum
DROP TYPE "CompensationMode";
DROP TYPE "RevenuePeriodType";
