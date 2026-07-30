CREATE TYPE "NextAction" AS ENUM ('wait_for_user','retry_preflight','rebind_page','reauthenticate','inspect_call_record','stop');
CREATE TYPE "AuditAction" AS ENUM ('configure','publish','import_numbers','start_dial');
ALTER TABLE "ExecutionStep" ALTER COLUMN "status" TYPE "ExecutionStatus" USING "status"::"ExecutionStatus";
ALTER TABLE "ExecutionStep" ALTER COLUMN "nextAction" TYPE "NextAction" USING "nextAction"::"NextAction";
ALTER TABLE "AuditEvent" ALTER COLUMN "action" TYPE "AuditAction" USING "action"::"AuditAction";
