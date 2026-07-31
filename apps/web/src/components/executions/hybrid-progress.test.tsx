import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import type {
  ExecutionEvent,
  ExecutionPhase,
  ExecutionStatus
} from "@app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HybridProgress,
  type ExecutionSummary,
  type PersistedExecutionEvent
} from "./hybrid-progress";

const execution: ExecutionSummary = {
  id: "EX-1",
  configVersion: 7,
  status: "running",
  phase: "environment_preflight",
  targetPolicy: "create_only",
  updatedAt: "2026-07-30T08:00:00.000Z",
  agentId: "agent-owner",
  agentHeartbeatAt: "2026-07-30T08:00:00.000Z"
};

const connectedBridge = {
  getConnection: () => ({
    connected: true,
    agentId: "agent-owner",
    sessionId: "session-owner",
    executionId: "EX-1"
  }),
  subscribe: () => () => undefined,
  deliverConfirmation: vi.fn().mockResolvedValue({ acknowledged: true })
};

const runningEvent: ExecutionEvent = {
  executionId: "EX-1",
  stepId: "environment.preflight",
  attempt: 1,
  status: "running",
  occurredAt: "2026-07-30T08:00:00.000Z",
  inputHash: "sha256:abc",
  evidence: {
    kind: "checkpoint",
    summary: { phase: "environment_preflight", status: "running" },
    reference: {
      kind: "checkpoint",
      id: "checkpoint:1111111111111111"
    }
  },
  nextAction: "wait_for_user"
};

describe("HybridProgress", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    connectedBridge.deliverConfirmation.mockReset();
    connectedBridge.deliverConfirmation.mockResolvedValue({
      acknowledged: true
    });
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows persisted running facts without inventing connected success", () => {
    render(
      <HybridProgress
        execution={execution}
        initialEvents={[persisted("cursor:opaque:first", runningEvent)]}
      />
    );

    expect(screen.getByText("正在执行")).toBeInTheDocument();
    expect(
      screen.getAllByText("environment_preflight / running")
    ).toHaveLength(2);
    expect(screen.getByText("create_only")).toBeInTheDocument();
    expect(screen.getByText("配置版本 7")).toBeInTheDocument();
    expect(screen.queryByText("已接通")).not.toBeInTheDocument();
  });

  it("shows the persisted agent heartbeat timestamp and its age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T08:30:00.000Z"));
    render(
      <HybridProgress
        execution={{
          ...execution,
          agentId: "agent-owner",
          agentHeartbeatAt: "2026-07-30T08:00:00.000Z"
        }}
        initialEvents={[persisted("cursor:opaque:first", runningEvent)]}
      />
    );

    expect(screen.getByText(/30 分钟前/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("keeps unavailable platform evidence unknown", () => {
    const unknownEvent: ExecutionEvent = {
      ...runningEvent,
      status: "unknown",
      stepId: "dial.verify",
      evidence: {
        kind: "platform_record",
        summary: { outcome: "unavailable" },
        reference: {
          kind: "platform_record",
          id: "platform_record:2222222222222222"
        }
      },
      errorCode: "CALL_RECORD_UNAVAILABLE",
      nextAction: "inspect_call_record"
    };

    render(
      <HybridProgress
        execution={{ ...execution, status: "unknown", phase: "call_verify" }}
        initialEvents={[persisted("cursor:opaque:unknown", unknownEvent)]}
      />
    );

    expect(screen.getAllByText("未知").length).toBeGreaterThan(0);
    expect(screen.getByText("CALL_RECORD_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("inspect_call_record")).toBeInTheDocument();
    expect(screen.queryByText("已接通")).not.toBeInTheDocument();
  });

  it.each([
    ["publish_confirm", "publish", "确认发布"],
    ["numbers_confirm", "import_numbers", "确认导入号码"],
    ["dial_confirm", "start_dial", "确认开始外呼"]
  ] as const)(
    "shows only the matching confirmation for %s",
    (phase, _action, expectedLabel) => {
      render(
        <HybridProgress
          execution={{
            ...execution,
            status: "waiting_confirmation",
            phase
          }}
          initialEvents={[
            persisted(
              `cursor:opaque:${phase}`,
              checkpoint(
                phaseStep(phase),
                "waiting_confirmation",
                phase
              )
            )
          ]}
          localAgentBridge={connectedBridge}
        />
      );

      expect(
        screen.getByRole("button", { name: expectedLabel })
      ).toBeEnabled();
      for (const label of ["确认发布", "确认导入号码", "确认开始外呼"]) {
        if (label !== expectedLabel) {
          expect(
            screen.queryByRole("button", { name: label })
          ).not.toBeInTheDocument();
        }
      }
    }
  );

  it("does not expose a confirmation from a cross-action event", () => {
    render(
      <HybridProgress
        execution={{
          ...execution,
          status: "waiting_confirmation",
          phase: "publish_confirm"
        }}
        initialEvents={[
          persisted(
            "cursor:opaque:cross-action",
            checkpoint(
              "numbers.confirm",
              "waiting_confirmation",
              "numbers_confirm"
            )
          )
        ]}
        localAgentBridge={connectedBridge}
      />
    );

    expect(
      screen.queryByRole("button", { name: "确认发布" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认导入号码" })
    ).not.toBeInTheDocument();
  });

  it("deduplicates SSE events and reconnects from the opaque last event id", async () => {
    vi.useFakeTimers();
    render(
      <HybridProgress
        execution={execution}
        initialEvents={[persisted("cursor:opaque:first", runningEvent)]}
      />
    );

    expect(FakeEventSource.instances[0]?.url).toContain(
      "cursor=cursor%3Aopaque%3Afirst"
    );

    const next = checkpoint(
      "robot.create",
      "running",
      "robot_create"
    );
    act(() => {
      FakeEventSource.instances[0]?.emit(next, "cursor:opaque:second");
      FakeEventSource.instances[0]?.emit(next, "cursor:opaque:second");
    });

    expect(screen.getAllByText("robot.create")).toHaveLength(1);

    act(() => FakeEventSource.instances[0]?.fail());
    expect(screen.getByText("正在重新连接")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toContain(
      "cursor=cursor%3Aopaque%3Asecond"
    );
  });

  it("refreshes the authoritative summary after SSE and ignores an older response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HybridProgress
        execution={execution}
        initialEvents={[persisted("cursor:opaque:first", runningEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    const publishWaiting = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );
    const numbersWaiting = checkpoint(
      "numbers.confirm",
      "waiting_confirmation",
      "numbers_confirm"
    );
    act(() => {
      FakeEventSource.instances[0]?.emit(
        publishWaiting,
        "cursor:opaque:publish"
      );
      FakeEventSource.instances[0]?.emit(
        numbersWaiting,
        "cursor:opaque:numbers"
      );
    });

    second.resolve(
      summaryResponse({
        ...execution,
        status: "waiting_confirmation",
        phase: "numbers_confirm"
      }, numbersWaiting)
    );
    expect(
      await screen.findByRole("button", { name: "确认导入号码" })
    ).toBeEnabled();

    first.resolve(
      summaryResponse({
        ...execution,
        status: "waiting_confirmation",
        phase: "publish_confirm"
      }, publishWaiting)
    );
    await act(async () => undefined);

    expect(
      screen.getByRole("button", { name: "确认导入号码" })
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "确认发布" })
    ).not.toBeInTheDocument();
  });

  it("does not issue a confirmation without the matching connected agent bridge", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );

    render(
      <HybridProgress
        execution={{
          ...execution,
          status: "waiting_confirmation",
          phase: "publish_confirm"
        }}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={null}
      />
    );

    expect(screen.getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(screen.getByText("本地代理桥未连接")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables confirmation when the authoritative summary has no current lock agent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );

    render(
      <HybridProgress
        execution={{
          ...execution,
          status: "waiting_confirmation",
          phase: "publish_confirm",
          agentId: null,
          agentHeartbeatAt: null
        }}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    expect(screen.getByText("无持久化记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "disconnects",
      {
        connected: false,
        agentId: null,
        sessionId: null,
        executionId: null
      }
    ],
    [
      "switches agent",
      {
        connected: true,
        agentId: "agent-other",
        sessionId: "session-other",
        executionId: "EX-1"
      }
    ]
  ] as const)(
    "retains one token without wrong delivery when the bridge %s during POST",
    async (_label, changedConnection) => {
      const waitingEvent = checkpoint(
        "publish.confirm",
        "waiting_confirmation",
        "publish_confirm"
      );
      const waitingSummary: ExecutionSummary = {
        ...execution,
        status: "waiting_confirmation",
        phase: "publish_confirm"
      };
      const issued = {
        confirmationId: "confirm:0123456789abcdef",
        action: "publish" as const,
        executionId: "EX-1",
        configVersion: 7,
        token: `confirm_token:${"3".repeat(64)}`,
        expiresAt: "2099-07-30T08:05:00.000Z"
      };
      const originalConnection = {
        connected: true,
        agentId: "agent-owner",
        sessionId: "session-owner",
        executionId: "EX-1"
      } as const;
      const bridge = mutableBridge(originalConnection);
      const post = deferred<Response>();
      const fetchMock = vi.fn(
        (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith("/confirmations")) {
            return post.promise;
          }
          expect(init?.method).toBeUndefined();
          return Promise.resolve(summaryResponse(waitingSummary, waitingEvent));
        }
      );
      vi.stubGlobal("fetch", fetchMock);

      render(
        <HybridProgress
          execution={waitingSummary}
          initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
          localAgentBridge={bridge}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([url]) =>
            String(url).endsWith("/confirmations")
          )
        ).toHaveLength(1)
      );
      act(() => bridge.setConnection(changedConnection));
      post.resolve(
        new Response(JSON.stringify({ confirmation: issued }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      );

      expect(
        await screen.findByText(/本地代理连接已变化/)
      ).toBeInTheDocument();
      expect(bridge.deliverConfirmation).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "重试交付确认" })
      ).toBeDisabled();

      act(() => bridge.setConnection(originalConnection));
      const retry = screen.getByRole("button", { name: "重试交付确认" });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);

      expect(
        await screen.findByText("本地代理已确认接收")
      ).toBeInTheDocument();
      expect(bridge.deliverConfirmation).toHaveBeenCalledWith(issued);
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith("/confirmations")
        )
      ).toHaveLength(1);
    }
  );

  it("retries delivery with the same in-memory token and clears it after ACK", async () => {
    const issued = {
      confirmationId: "confirm:0123456789abcdef",
      action: "publish" as const,
      executionId: "EX-1",
      configVersion: 7,
      token: `confirm_token:${"1".repeat(64)}`,
      expiresAt: "2099-07-30T08:05:00.000Z"
    };
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );
    const waitingSummary = {
      ...execution,
      status: "waiting_confirmation" as const,
      phase: "publish_confirm" as const
    };
    const fetchMock = vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        String(url).endsWith("/confirmations")
          ? new Response(JSON.stringify({ confirmation: issued }), {
              status: 201,
              headers: { "content-type": "application/json" }
            })
          : summaryResponse(waitingSummary, waitingEvent)
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    connectedBridge.deliverConfirmation
      .mockRejectedValueOnce(new Error("bridge offline"))
      .mockResolvedValueOnce({ acknowledged: true });

    render(
      <HybridProgress
        execution={waitingSummary}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    expect(
      await screen.findByRole("button", { name: "重试交付确认" })
    ).toBeEnabled();
    expect(confirmationPostCalls(fetchMock)).toHaveLength(1);
    expect(connectedBridge.deliverConfirmation).toHaveBeenNthCalledWith(
      1,
      issued
    );
    expect(screen.queryByText(issued.token)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试交付确认" }));
    expect(await screen.findByText("本地代理已确认接收")).toBeInTheDocument();
    expect(confirmationPostCalls(fetchMock)).toHaveLength(1);
    expect(connectedBridge.deliverConfirmation).toHaveBeenNthCalledWith(
      2,
      issued
    );
  });

  it("recovers from a pre-issue network failure and prevents double submission", async () => {
    const pending = deferred<Response>();
    let postCount = 0;
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );
    const waitingSummary = {
      ...execution,
      status: "waiting_confirmation" as const,
      phase: "publish_confirm" as const
    };
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (!String(url).endsWith("/confirmations")) {
        return Promise.resolve(summaryResponse(waitingSummary, waitingEvent));
      }
      postCount += 1;
      return postCount === 1
        ? Promise.reject(new Error("offline"))
        : pending.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HybridProgress
        execution={waitingSummary}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    expect(
      await screen.findByRole("button", { name: "确认发布" })
    ).toBeEnabled();

    const retry = screen.getByRole("button", { name: "确认发布" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() =>
      expect(confirmationPostCalls(fetchMock)).toHaveLength(2)
    );
  });

  it("renders loading, empty, and load-error states explicitly", () => {
    const { rerender } = render(
      <HybridProgress execution={execution} initialEvents={[]} loading />
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在加载执行记录");

    rerender(<HybridProgress execution={execution} initialEvents={[]} />);
    expect(screen.getByText("暂无持久化执行事件")).toBeInTheDocument();

    rerender(
      <HybridProgress
        execution={execution}
        initialEvents={[]}
        loadError="无法读取执行记录"
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("无法读取执行记录");
  });

  it("reports confirmation conflict without optimistic success", async () => {
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );
    let summaryReads = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith("/confirmations")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ code: "CONFIRMATION_CONFIG_MISMATCH" }),
            {
              status: 409,
              headers: { "content-type": "application/json" }
            }
          )
        );
      }
      summaryReads += 1;
      return Promise.resolve(
        summaryReads === 1
          ? summaryResponse(
              {
                ...execution,
                status: "waiting_confirmation",
                phase: "publish_confirm"
              },
              waitingEvent
            )
          : summaryResponse(
              { ...execution, status: "running", phase: "publish_verify" },
              checkpoint("publish.verify", "running", "publish_verify")
            )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HybridProgress
        execution={{
          ...execution,
          status: "waiting_confirmation",
          phase: "publish_confirm"
        }}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "确认发布" })
      ).not.toBeInTheDocument()
    );
    expect(screen.queryByText("发布成功")).not.toBeInTheDocument();
    expect(confirmationPostCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/executions/EX-1/confirmations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          configVersion: 7,
          agentId: "agent-owner"
        })
      })
    );
  });

  it("reissues after a conflict only when the refreshed exact gate still waits", async () => {
    const waitingEvent = checkpoint(
      "publish.confirm",
      "waiting_confirmation",
      "publish_confirm"
    );
    const issued = {
      confirmationId: "confirm:fedcba9876543210",
      action: "publish" as const,
      executionId: "EX-1",
      configVersion: 7,
      token: `confirm_token:${"2".repeat(64)}`,
      expiresAt: "2099-07-30T08:05:00.000Z"
    };
    const waitingSummary = {
      ...execution,
      status: "waiting_confirmation" as const,
      phase: "publish_confirm" as const
    };
    let postCount = 0;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (!String(url).endsWith("/confirmations")) {
        return Promise.resolve(summaryResponse(waitingSummary, waitingEvent));
      }
      postCount += 1;
      return Promise.resolve(
        postCount === 1
          ? new Response(JSON.stringify({ code: "CONFIRMATION_INVALID" }), {
              status: 409,
              headers: { "content-type": "application/json" }
            })
          : new Response(JSON.stringify({ confirmation: issued }), {
              status: 201,
              headers: { "content-type": "application/json" }
            })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HybridProgress
        execution={waitingSummary}
        initialEvents={[persisted("cursor:opaque:publish", waitingEvent)]}
        localAgentBridge={connectedBridge}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    expect(
      await screen.findByText(/状态已刷新，可重试/)
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "确认发布" });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(await screen.findByText("本地代理已确认接收")).toBeInTheDocument();
    expect(confirmationPostCalls(fetchMock)).toHaveLength(2);
    expect(connectedBridge.deliverConfirmation).toHaveBeenCalledWith(issued);
  });
});

function persisted(
  cursor: string,
  event: ExecutionEvent
): PersistedExecutionEvent {
  return { cursor, event };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type BridgeConnection = {
  connected: boolean;
  agentId: string | null;
  sessionId: string | null;
  executionId: string | null;
};

function mutableBridge(initial: BridgeConnection) {
  let connection = initial;
  const listeners = new Set<() => void>();
  return {
    getConnection: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deliverConfirmation: vi.fn().mockResolvedValue({ acknowledged: true }),
    setConnection(next: BridgeConnection) {
      connection = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

function confirmationPostCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/confirmations")
  );
}

function summaryResponse(
  summary: ExecutionSummary,
  event: ExecutionEvent
): Response {
  return new Response(
    JSON.stringify({
      execution: summary,
      events: [persisted(`cursor:summary:${event.stepId}`, event)]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function checkpoint(
  stepId: ExecutionEvent["stepId"],
  status: ExecutionStatus,
  phase: ExecutionPhase
): ExecutionEvent {
  return {
    ...runningEvent,
    stepId,
    status,
    evidence: {
      kind: "checkpoint",
      summary: { phase, status },
      reference: {
        kind: "checkpoint",
        id: "checkpoint:3333333333333333"
      }
    }
  };
}

function phaseStep(
  phase: "publish_confirm" | "numbers_confirm" | "dial_confirm"
): ExecutionEvent["stepId"] {
  return {
    publish_confirm: "publish.confirm",
    numbers_confirm: "numbers.confirm",
    dial_confirm: "dial.confirm"
  }[phase] as ExecutionEvent["stepId"];
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(event: ExecutionEvent, lastEventId: string): void {
    const message = new MessageEvent("execution-step", {
      data: JSON.stringify(event),
      lastEventId
    });
    for (const listener of this.listeners.get("execution-step") ?? []) {
      listener(message);
    }
  }

  fail(): void {
    this.onerror?.();
  }

  close(): void {}
}
