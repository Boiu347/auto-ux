import { ExecutionStatusSchema } from "@app/contracts";

if (!ExecutionStatusSchema.safeParse("unknown").success) {
  throw new Error("@app/contracts did not expose ExecutionStatusSchema");
}
