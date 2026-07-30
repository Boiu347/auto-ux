ALTER TABLE "ExecutionStep"
ADD COLUMN "sequence" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "ExecutionStep_sequence_key"
ON "ExecutionStep"("sequence");

CREATE UNIQUE INDEX "Confirmation_tokenHash_key"
ON "Confirmation"("tokenHash");
