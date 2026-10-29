-- DropForeignKey
ALTER TABLE "routines" DROP CONSTRAINT "routines_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "routines" DROP CONSTRAINT "routines_team_id_fkey";

-- DropForeignKey
ALTER TABLE "routines" DROP CONSTRAINT "routines_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "routine_runs" DROP CONSTRAINT "routine_runs_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "routine_runs" DROP CONSTRAINT "routine_runs_routine_id_fkey";

-- DropTable
DROP TABLE "routines";

-- DropTable
DROP TABLE "routine_runs";

-- DropEnum
DROP TYPE "RoutineProvider";

-- DropEnum
DROP TYPE "RoutineRunsOn";

-- DropEnum
DROP TYPE "RoutineOrigin";

-- DropEnum
DROP TYPE "RoutineStatus";

-- DropEnum
DROP TYPE "RoutineScheduleKind";

-- DropEnum
DROP TYPE "RoutineNotifyMode";

-- DropEnum
DROP TYPE "RoutineRunsIn";

-- DropEnum
DROP TYPE "RoutineRunStatus";

-- DropEnum
DROP TYPE "RoutineComponentKind";
