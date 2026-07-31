import {
  AgentCapabilityManifestSchema,
  type ConfirmationAction,
  type ExecutionEvent,
  type ExecutionStatus
} from "@app/contracts";

export const SUPPORTED_CONTRACT_VERSION = "1";
const LOCK_TTL_MS = 60_000;

export interface AgentCapabilityManifest {
  pluginVersion: string;
  contractVersion: string;
  capabilities: {
    feishuCli: boolean;
    browser: boolean;
  };
  agentId: string;
  sessionId: string;
  executionId: string;
}

export interface ConfirmationRequest {
  action: ConfirmationAction;
  executionId: string;
  configVersion: number;
  agentId: string;
  sessionId: string;
}

export interface ConfirmationDelivery extends ConfirmationRequest {
  confirmationId: string;
  token: string;
  expiresAt: string;
}

export interface ConfirmationBridge {
  waitForConfirmation(request: ConfirmationRequest): Promise<ConfirmationDelivery>;
}

export interface ClaimExecutionResult {
  pluginSessionCount: number;
  configVersion: number;
  events: ExecutionEvent[];
}

export interface LocalApiClient {
  claimExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<ClaimExecutionResult>;
  heartbeatExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<void>;
  postStepEvent(
    event: ExecutionEvent,
    manifest: AgentCapabilityManifest,
    confirmation?: ConfirmationDelivery
  ): Promise<void>;
}

export type AgentClientErrorCode =
  | "INCOMPATIBLE_CONTRACT"
  | "MISSING_CAPABILITY"
  | "EXECUTION_BINDING_MISMATCH"
  | "EXECUTION_LOCKED"
  | "EXECUTION_LOCK_MISMATCH"
  | "DUPLICATE_PLUGIN_SESSION"
  | "DUPLICATE_EVENT"
  | "FOREIGN_CONFIRMATION"
  | "CONFIRMATION_REPLAYED"
  | "CONFIRMATION_REQUIRED"
  | "INVALID_CONFIRMATION_ACTION"
  | "INVALID_EVENT_ORDER"
  | "UNKNOWN_STATE"
  | "API_REQUEST_FAILED";

export class AgentClientError extends Error {
  readonly code: AgentClientErrorCode;

  constructor(code: AgentClientErrorCode) {
    super(code);
    this.code = code;
  }
}

interface PersistedConfirmation {
  delivery: ConfirmationDelivery;
  consumed: boolean;
}

interface PersistedLock {
  agentId: string;
  sessionId: string;
  executionId: string;
  heartbeatAt: string;
  expiresAtMs: number;
}

/** Durable state used by the deterministic fake across simulated process restarts. */
export class FakeLocalApiPersistence {
  readonly executionId: string;
  readonly configVersion = 1;
  readonly events: ExecutionEvent[] = [];
  readonly confirmations = new Map<string, PersistedConfirmation>();
  pluginSessionCount = 0;
  recoveredClaimCount = 0;
  heartbeatCount = 0;
  lock: PersistedLock | null = null;
  pluginBinding: Pick<
    AgentCapabilityManifest,
    "agentId" | "sessionId" | "executionId"
  > | null = null;

  constructor(executionId = "EX-1") {
    this.executionId = executionId;
  }
}

export class FakeLocalApiClient implements LocalApiClient {
  private readonly persistence: FakeLocalApiPersistence;
  private readonly now: () => Date;

  constructor(options?: {
    persistence?: FakeLocalApiPersistence;
    executionId?: string;
    now?: () => Date;
  }) {
    this.persistence =
      options?.persistence ?? new FakeLocalApiPersistence(options?.executionId);
    this.now = options?.now ?? (() => new Date("2026-07-30T00:00:00.000Z"));
  }

  get events(): readonly ExecutionEvent[] {
    return this.persistence.events;
  }

  get pluginSessionCount(): number {
    return this.persistence.pluginSessionCount;
  }

  get consumedConfirmationActions(): ConfirmationAction[] {
    return [...this.persistence.confirmations.values()]
      .filter(({ consumed }) => consumed)
      .map(({ delivery }) => delivery.action);
  }

  async claimExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<ClaimExecutionResult> {
    validateManifest(executionId, manifest);
    if (executionId !== this.persistence.executionId) {
      throw new AgentClientError("EXECUTION_BINDING_MISMATCH");
    }

    const currentTime = this.now().getTime();
    const lock = this.persistence.lock;
    if (
      lock &&
      lock.expiresAtMs > currentTime &&
      lock.agentId === manifest.agentId &&
      !sameBinding(lock, manifest)
    ) {
      throw new AgentClientError("DUPLICATE_PLUGIN_SESSION");
    }
    if (
      lock &&
      lock.expiresAtMs > currentTime &&
      !sameBinding(lock, manifest)
    ) {
      throw new AgentClientError("EXECUTION_LOCKED");
    }

    const pluginBinding = this.persistence.pluginBinding;
    if (pluginBinding && !sameBinding(pluginBinding, manifest)) {
      throw new AgentClientError("DUPLICATE_PLUGIN_SESSION");
    }
    if (pluginBinding) {
      this.persistence.recoveredClaimCount += 1;
    } else {
      this.persistence.pluginBinding = bindingOf(manifest);
      this.persistence.pluginSessionCount = 1;
    }
    this.persistence.lock = lockFor(manifest, this.now());

    return {
      pluginSessionCount: this.persistence.pluginSessionCount,
      configVersion: this.persistence.configVersion,
      events: [...this.persistence.events]
    };
  }

  async heartbeatExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<void> {
    this.requireCurrentBinding(executionId, manifest);
    this.persistence.heartbeatCount += 1;
    this.persistence.lock = lockFor(manifest, this.now());
  }

  async postStepEvent(
    event: ExecutionEvent,
    manifest: AgentCapabilityManifest,
    confirmation?: ConfirmationDelivery
  ): Promise<void> {
    this.requireCurrentBinding(event.executionId, manifest);
    if (
      this.persistence.events.some(
        (persisted) =>
          persisted.stepId === event.stepId && persisted.attempt === event.attempt
      )
    ) {
      throw new AgentClientError("DUPLICATE_EVENT");
    }

    if (confirmation) {
      this.validateConfirmation(event, manifest, confirmation);
    } else if (isConfirmationContinuation(event)) {
      throw new AgentClientError("CONFIRMATION_REQUIRED");
    }

    const lastStatus = this.persistence.events.at(-1)?.status;
    if (lastStatus === "unknown") {
      throw new AgentClientError("UNKNOWN_STATE");
    }
    assertNextEvent(this.persistence.events, event);
    this.persistence.events.push(structuredClone(event));
  }

  async issueConfirmation(
    action: ConfirmationAction,
    manifest: AgentCapabilityManifest
  ): Promise<ConfirmationDelivery> {
    this.requireCurrentBinding(manifest.executionId, manifest);
    const expectedAction = waitingAction(this.persistence.events.at(-1));
    if (expectedAction !== action) {
      throw new AgentClientError("INVALID_CONFIRMATION_ACTION");
    }
    const ordinal = this.persistence.confirmations.size + 1;
    const hex = ordinal.toString(16).padStart(16, "0");
    const delivery: ConfirmationDelivery = {
      action,
      executionId: manifest.executionId,
      configVersion: this.persistence.configVersion,
      agentId: manifest.agentId,
      sessionId: manifest.sessionId,
      confirmationId: `confirm:${hex}`,
      token: `confirm_token:${ordinal.toString(16).padStart(64, "0")}`,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString()
    };
    this.persistence.confirmations.set(delivery.confirmationId, {
      delivery,
      consumed: false
    });
    return delivery;
  }

  private requireCurrentBinding(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): void {
    validateManifest(executionId, manifest);
    const lock = this.persistence.lock;
    if (
      !lock ||
      lock.expiresAtMs <= this.now().getTime() ||
      !sameBinding(lock, manifest)
    ) {
      throw new AgentClientError("EXECUTION_LOCK_MISMATCH");
    }
  }

  private validateConfirmation(
    event: ExecutionEvent,
    manifest: AgentCapabilityManifest,
    confirmation: ConfirmationDelivery
  ): void {
    if (
      confirmation.executionId !== event.executionId ||
      confirmation.executionId !== manifest.executionId ||
      confirmation.agentId !== manifest.agentId ||
      confirmation.sessionId !== manifest.sessionId ||
      confirmation.configVersion !== this.persistence.configVersion
    ) {
      throw new AgentClientError("FOREIGN_CONFIRMATION");
    }
    const persisted = this.persistence.confirmations.get(
      confirmation.confirmationId
    );
    if (!persisted || !sameDelivery(persisted.delivery, confirmation)) {
      throw new AgentClientError("FOREIGN_CONFIRMATION");
    }
    if (persisted.consumed) {
      throw new AgentClientError("CONFIRMATION_REPLAYED");
    }
    const expectedAction = confirmationActionForStep(event.stepId);
    if (!isConfirmationContinuation(event) || expectedAction !== confirmation.action) {
      throw new AgentClientError("INVALID_CONFIRMATION_ACTION");
    }
    if (new Date(confirmation.expiresAt).getTime() <= this.now().getTime()) {
      throw new AgentClientError("FOREIGN_CONFIRMATION");
    }
    persisted.consumed = true;
  }
}

export class FakeConfirmationBridge implements ConfirmationBridge {
  readonly requestedActions: ConfirmationAction[] = [];
  private readonly api: FakeLocalApiClient;

  constructor(api: FakeLocalApiClient) {
    this.api = api;
  }

  async waitForConfirmation(
    request: ConfirmationRequest
  ): Promise<ConfirmationDelivery> {
    this.requestedActions.push(request.action);
    return this.api.issueConfirmation(request.action, {
      pluginVersion: "simulator-1.0.0",
      contractVersion: SUPPORTED_CONTRACT_VERSION,
      capabilities: { feishuCli: true, browser: true },
      agentId: request.agentId,
      sessionId: request.sessionId,
      executionId: request.executionId
    });
  }
}

export class HttpLocalApiClient implements LocalApiClient {
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    baseUrl: string,
    headers: Readonly<Record<string, string>> = {},
    fetchImplementation: typeof fetch = fetch
  ) {
    this.baseUrl = baseUrl;
    this.headers = headers;
    this.fetchImplementation = fetchImplementation;
  }

  claimExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<ClaimExecutionResult> {
    return this.request(
      `/api/executions/${encodeURIComponent(executionId)}/agent/claim`,
      manifest
    );
  }

  async heartbeatExecution(
    executionId: string,
    manifest: AgentCapabilityManifest
  ): Promise<void> {
    await this.request(
      `/api/executions/${encodeURIComponent(executionId)}/agent/heartbeat`,
      {
        agentId: manifest.agentId,
        sessionId: manifest.sessionId
      }
    );
  }

  async postStepEvent(
    event: ExecutionEvent,
    manifest: AgentCapabilityManifest,
    confirmation?: ConfirmationDelivery
  ): Promise<void> {
    await this.request(
      `/api/executions/${encodeURIComponent(event.executionId)}/events`,
      {
        agentId: manifest.agentId,
        sessionId: manifest.sessionId,
        event,
        ...(confirmation
          ? {
              confirmation: {
                confirmationId: confirmation.confirmationId,
                token: confirmation.token,
                action: confirmation.action,
                configVersion: confirmation.configVersion
              }
            }
          : {})
      }
    );
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as T & { code?: AgentClientErrorCode };
    if (!response.ok) {
      throw new AgentClientError(payload.code ?? "API_REQUEST_FAILED");
    }
    return payload;
  }
}

export interface SimulationResult {
  simulator: true;
  outputLabel: "SIMULATOR_ONLY";
  pluginSessionCount: number;
  finalStatus: ExecutionStatus;
  waitingFor?: ConfirmationAction;
}

function validateManifest(
  executionId: string,
  manifest: AgentCapabilityManifest
): void {
  const candidate = manifest as unknown as Record<string, unknown>;
  const capabilities = candidate.capabilities;
  const parsed = AgentCapabilityManifestSchema.safeParse(manifest);
  if (parsed.success && parsed.data.executionId === executionId) {
    return;
  }
  if (candidate.contractVersion !== SUPPORTED_CONTRACT_VERSION) {
    throw new AgentClientError("INCOMPATIBLE_CONTRACT");
  }
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    !("feishuCli" in capabilities) ||
    !("browser" in capabilities) ||
    capabilities.feishuCli !== true ||
    capabilities.browser !== true
  ) {
    throw new AgentClientError("MISSING_CAPABILITY");
  }
  throw new AgentClientError("EXECUTION_BINDING_MISMATCH");
}

function bindingOf(manifest: AgentCapabilityManifest) {
  return {
    agentId: manifest.agentId,
    sessionId: manifest.sessionId,
    executionId: manifest.executionId
  };
}

function sameBinding(
  binding: Pick<AgentCapabilityManifest, "agentId" | "sessionId" | "executionId">,
  manifest: AgentCapabilityManifest
): boolean {
  return (
    binding.agentId === manifest.agentId &&
    binding.sessionId === manifest.sessionId &&
    binding.executionId === manifest.executionId
  );
}

function lockFor(
  manifest: AgentCapabilityManifest,
  now: Date
): PersistedLock {
  return {
    ...bindingOf(manifest),
    heartbeatAt: now.toISOString(),
    expiresAtMs: now.getTime() + LOCK_TTL_MS
  };
}

function sameDelivery(
  left: ConfirmationDelivery,
  right: ConfirmationDelivery
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isConfirmationContinuation(event: ExecutionEvent): boolean {
  return (
    event.status === "succeeded" &&
    confirmationActionForStep(event.stepId) !== undefined &&
    event.stepId !== "publish.verify"
  );
}

function confirmationActionForStep(
  stepId: ExecutionEvent["stepId"]
): ConfirmationAction | undefined {
  if (stepId === "publish.confirm") return "publish";
  if (stepId === "numbers.confirm") return "import_numbers";
  if (stepId === "dial.confirm") return "start_dial";
  return undefined;
}

function waitingAction(event: ExecutionEvent | undefined): ConfirmationAction | undefined {
  return event?.status === "waiting_confirmation"
    ? confirmationActionForStep(event.stepId)
    : undefined;
}

const expectedFlow: ReadonlyArray<Pick<ExecutionEvent, "stepId" | "status">> = [
  { stepId: "source.parse", status: "succeeded" },
  { stepId: "draft.confirm", status: "succeeded" },
  { stepId: "environment.preflight", status: "succeeded" },
  { stepId: "robot.create", status: "succeeded" },
  { stepId: "field.configure", status: "succeeded" },
  { stepId: "voice.preflight", status: "succeeded" },
  { stepId: "publish.confirm", status: "waiting_confirmation" },
  { stepId: "publish.confirm", status: "succeeded" },
  { stepId: "publish.verify", status: "succeeded" },
  { stepId: "numbers.confirm", status: "waiting_confirmation" },
  { stepId: "numbers.confirm", status: "succeeded" },
  { stepId: "dial.confirm", status: "waiting_confirmation" },
  { stepId: "dial.confirm", status: "succeeded" },
  { stepId: "dial.verify", status: "succeeded" },
  { stepId: "complete", status: "succeeded" }
];

function assertNextEvent(events: readonly ExecutionEvent[], event: ExecutionEvent): void {
  if (event.status === "unknown") {
    return;
  }
  const expected = expectedFlow[events.length];
  if (!expected || expected.stepId !== event.stepId || expected.status !== event.status) {
    throw new AgentClientError("INVALID_EVENT_ORDER");
  }
}
