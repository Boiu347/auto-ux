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
  updatedAt: "2026-07-30T08:00:00.000Z"
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "CONFIRMATION_CONFIG_MISMATCH" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    );
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
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "确认已失效或执行状态已变化"
      );
    });
    expect(screen.queryByText("发布成功")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/executions/EX-1/confirmations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "publish", configVersion: 7 })
      })
    );
  });
});

function persisted(
  cursor: string,
  event: ExecutionEvent
): PersistedExecutionEvent {
  return { cursor, event };
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
