import { describe, it, expect, vi, beforeEach } from "vitest";
import { scheduleBackground } from "../schedule-background";
import * as nextServer from "next/server";

vi.mock("next/server", () => ({
  after: vi.fn(),
}));

describe("scheduleBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to Next.js after() when inside a request context", () => {
    const afterMock = vi.mocked(nextServer.after);
    afterMock.mockImplementation((task) => {
      // Mock successful scheduling
      return task as unknown as void;
    });

    const task = vi.fn();
    scheduleBackground(task);

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(afterMock).toHaveBeenCalledWith(task);
    // Task itself is deferred, not immediately called by scheduleBackground
    expect(task).not.toHaveBeenCalled();
  });

  it("gracefully runs the task immediately when after() throws outside a request scope", () => {
    const afterMock = vi.mocked(nextServer.after);
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    const task = vi.fn();
    scheduleBackground(task);

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("gracefully runs async tasks when outside a request scope", async () => {
    const afterMock = vi.mocked(nextServer.after);
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    let asyncDone = false;
    const asyncTask = async () => {
      await Promise.resolve();
      asyncDone = true;
    };

    scheduleBackground(asyncTask);

    await Promise.resolve();
    expect(asyncDone).toBe(true);
  });
});
