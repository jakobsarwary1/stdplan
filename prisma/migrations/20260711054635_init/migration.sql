-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('super_admin', 'company_owner', 'dispatcher', 'driver');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('active', 'workshop', 'out_of_service', 'sold');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('company', 'leasing', 'financing', 'private');

-- CreateEnum
CREATE TYPE "DriverRole" AS ENUM ('stamm', 'zweit', 'vertretung', 'minijob', 'aushilfe', 'springer');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('fulltime', 'parttime', 'minijob', 'shortterm', 'workingStudent', 'auxiliary', 'freelancer');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('active', 'inactive', 'terminated');

-- CreateEnum
CREATE TYPE "CompensationMode" AS ENUM ('hourly', 'formula');

-- CreateEnum
CREATE TYPE "ShiftTemplateMode" AS ENUM ('fixed', 'flexible');

-- CreateEnum
CREATE TYPE "DemandLevel" AS ENUM ('niedrig', 'mittel', 'hoch', 'sehr_hoch');

-- CreateEnum
CREATE TYPE "RevenuePeriodType" AS ENUM ('day', 'week');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "taxId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_members" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bundesland" TEXT NOT NULL DEFAULT 'NW',
    "nightStart" TEXT NOT NULL DEFAULT '22:00',
    "nightEnd" TEXT NOT NULL DEFAULT '06:00',
    "minRestHours" DOUBLE PRECISION NOT NULL DEFAULT 11,
    "maxAbsenceHours" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "cashNettingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minijobMonthlyEarningLimit" DOUBLE PRECISION NOT NULL DEFAULT 603,
    "minijobKvFlatRate" DOUBLE PRECISION NOT NULL DEFAULT 0.13,
    "minijobRvFlatRate" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "minijobU1Rate" DOUBLE PRECISION NOT NULL DEFAULT 0.011,
    "minijobU2Rate" DOUBLE PRECISION NOT NULL DEFAULT 0.0024,
    "minijobInsolvenzRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0006,
    "minijobPauschsteuerRate" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "minijobOtherRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "licensePlate" TEXT NOT NULL,
    "vin" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "mileage" INTEGER NOT NULL DEFAULT 0,
    "status" "VehicleStatus" NOT NULL DEFAULT 'active',
    "ownershipType" "OwnershipType" NOT NULL DEFAULT 'company',
    "registrationDate" TIMESTAMP(3),
    "concessionNumber" TEXT,
    "tuvUntil" TIMESTAMP(3),
    "rentalPermitUntil" TIMESTAMP(3),
    "envBadge" TEXT,
    "euroNorm" TEXT,
    "shiftTemplateId" TEXT,
    "defaultDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_documents" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT,
    "fileUrl" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryDate" TIMESTAMP(3),

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_costs" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "vehicle_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_driver_assignments" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "role" "DriverRole" NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "vehicle_driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3),
    "birthPlace" TEXT,
    "birthCountry" TEXT,
    "street" TEXT,
    "houseNumber" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "idNumber" TEXT,
    "idExpiry" TIMESTAMP(3),
    "licenseNumber" TEXT,
    "licenseClass" TEXT,
    "licenseIssueDate" TIMESTAMP(3),
    "licenseExpiry" TIMESTAMP(3),
    "pbeScheinNumber" TEXT,
    "pbeScheinExpiry" TIMESTAMP(3),
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'fulltime',
    "status" "DriverStatus" NOT NULL DEFAULT 'active',
    "employeeNumber" TEXT,
    "qualifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compensationMode" "CompensationMode" NOT NULL DEFAULT 'hourly',
    "compensationFormulaId" TEXT,
    "hourlyRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_documents" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT,
    "fileUrl" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiryDate" TIMESTAMP(3),

    CONSTRAINT "driver_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_unavailability" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "driver_unavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_high_demand_windows" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "label" TEXT,
    "startDow" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endDow" INTEGER NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "driver_high_demand_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minijob_settings" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "legalCompliant" BOOLEAN NOT NULL DEFAULT true,
    "monthlyEarningLimit" DOUBLE PRECISION,
    "employeePaysRV" BOOLEAN NOT NULL DEFAULT true,
    "overrideCompanyDefaults" BOOLEAN NOT NULL DEFAULT false,
    "kvFlatRate" DOUBLE PRECISION,
    "rvFlatRate" DOUBLE PRECISION,
    "u1Rate" DOUBLE PRECISION,
    "u2Rate" DOUBLE PRECISION,
    "insolvenzRate" DOUBLE PRECISION,
    "pauschsteuerRate" DOUBLE PRECISION,
    "otherRate" DOUBLE PRECISION,

    CONSTRAINT "minijob_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "mode" "ShiftTemplateMode" NOT NULL DEFAULT 'fixed',
    "singleDriverMode" BOOLEAN NOT NULL DEFAULT false,
    "holidaysEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_template_shifts" (
    "id" TEXT NOT NULL,
    "shiftTemplateId" TEXT NOT NULL,
    "holidayForTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "driverCount" INTEGER NOT NULL DEFAULT 1,
    "weekdays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
    "requiredQualification" TEXT,
    "earliestStart" TEXT NOT NULL,
    "latestStart" TEXT NOT NULL,
    "targetNetHours" DOUBLE PRECISION NOT NULL,
    "maxShiftHours" DOUBLE PRECISION NOT NULL,
    "flexibleStart" BOOLEAN NOT NULL DEFAULT true,
    "prioritizeDemand" BOOLEAN NOT NULL DEFAULT false,
    "optimizeNightSurcharge" BOOLEAN NOT NULL DEFAULT false,
    "autoBreak" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "shift_template_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "level" "DemandLevel" NOT NULL,

    CONSTRAINT "demand_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "commuteMinutes" INTEGER NOT NULL DEFAULT 0,
    "generated" BOOLEAN NOT NULL DEFAULT false,
    "isSubstitute" BOOLEAN NOT NULL DEFAULT false,
    "primaryDriverId" TEXT,
    "fromShiftTemplateId" TEXT,
    "shiftName" TEXT,
    "isHoliday" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_breaks" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,

    CONSTRAINT "shift_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_formulas" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_formulas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "periodType" "RevenuePeriodType" NOT NULL,
    "netRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tip" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "surcharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashPayout" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashHandedIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "mileage" INTEGER,
    "cost" DOUBLE PRECISION,
    "note" TEXT,
    "nextDueDate" TIMESTAMP(3),
    "nextDueMileage" INTEGER,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_members_userId_idx" ON "company_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "company_members_companyId_userId_key" ON "company_members"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_companyId_key" ON "company_settings"("companyId");

-- CreateIndex
CREATE INDEX "vehicles_companyId_idx" ON "vehicles"("companyId");

-- CreateIndex
CREATE INDEX "vehicle_documents_vehicleId_idx" ON "vehicle_documents"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_costs_vehicleId_idx" ON "vehicle_costs"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_driver_assignments_vehicleId_idx" ON "vehicle_driver_assignments"("vehicleId");

-- CreateIndex
CREATE INDEX "vehicle_driver_assignments_driverId_idx" ON "vehicle_driver_assignments"("driverId");

-- CreateIndex
CREATE INDEX "drivers_companyId_idx" ON "drivers"("companyId");

-- CreateIndex
CREATE INDEX "driver_documents_driverId_idx" ON "driver_documents"("driverId");

-- CreateIndex
CREATE INDEX "driver_unavailability_driverId_idx" ON "driver_unavailability"("driverId");

-- CreateIndex
CREATE INDEX "driver_high_demand_windows_driverId_idx" ON "driver_high_demand_windows"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "minijob_settings_driverId_key" ON "minijob_settings"("driverId");

-- CreateIndex
CREATE INDEX "shift_templates_companyId_idx" ON "shift_templates"("companyId");

-- CreateIndex
CREATE INDEX "shift_template_shifts_shiftTemplateId_idx" ON "shift_template_shifts"("shiftTemplateId");

-- CreateIndex
CREATE INDEX "demand_profiles_companyId_weekday_idx" ON "demand_profiles"("companyId", "weekday");

-- CreateIndex
CREATE INDEX "shifts_companyId_date_idx" ON "shifts"("companyId", "date");

-- CreateIndex
CREATE INDEX "shifts_vehicleId_date_idx" ON "shifts"("vehicleId", "date");

-- CreateIndex
CREATE INDEX "shifts_driverId_date_idx" ON "shifts"("driverId", "date");

-- CreateIndex
CREATE INDEX "shift_breaks_shiftId_idx" ON "shift_breaks"("shiftId");

-- CreateIndex
CREATE INDEX "compensation_formulas_companyId_idx" ON "compensation_formulas"("companyId");

-- CreateIndex
CREATE INDEX "revenue_entries_companyId_driverId_idx" ON "revenue_entries"("companyId", "driverId");

-- CreateIndex
CREATE INDEX "maintenance_records_vehicleId_idx" ON "maintenance_records"("vehicleId");

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_shiftTemplateId_fkey" FOREIGN KEY ("shiftTemplateId") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_costs" ADD CONSTRAINT "vehicle_costs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_driver_assignments" ADD CONSTRAINT "vehicle_driver_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_driver_assignments" ADD CONSTRAINT "vehicle_driver_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_compensationFormulaId_fkey" FOREIGN KEY ("compensationFormulaId") REFERENCES "compensation_formulas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_documents" ADD CONSTRAINT "driver_documents_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_unavailability" ADD CONSTRAINT "driver_unavailability_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_high_demand_windows" ADD CONSTRAINT "driver_high_demand_windows_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minijob_settings" ADD CONSTRAINT "minijob_settings_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_template_shifts" ADD CONSTRAINT "shift_template_shifts_shiftTemplateId_fkey" FOREIGN KEY ("shiftTemplateId") REFERENCES "shift_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_template_shifts" ADD CONSTRAINT "shift_template_shifts_holidayForTemplateId_fkey" FOREIGN KEY ("holidayForTemplateId") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demand_profiles" ADD CONSTRAINT "demand_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_primaryDriverId_fkey" FOREIGN KEY ("primaryDriverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_breaks" ADD CONSTRAINT "shift_breaks_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_formulas" ADD CONSTRAINT "compensation_formulas_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
