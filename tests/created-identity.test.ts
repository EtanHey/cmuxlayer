import { describe, expect, it } from "vitest";
import {
  CreatedIdentityScope,
  createdIdentityFromError,
} from "../src/created-identity.js";

class UnclassifiedPostCreationError extends Error {}

describe("CreatedIdentityScope", () => {
  it("attaches recorded identity without changing the error type or cause", () => {
    const cause = new Error("socket stderr");
    const error = new UnclassifiedPostCreationError("later failure", {
      cause,
    });
    const scope = new CreatedIdentityScope();
    scope.record({ surface: "surface:7", workspace: "workspace:2" });

    const attached = scope.attach(error);

    expect(attached).toBe(error);
    expect(attached).toBeInstanceOf(UnclassifiedPostCreationError);
    expect(attached.cause).toBe(cause);
    expect(createdIdentityFromError(attached)).toEqual({
      surface: "surface:7",
      workspace: "workspace:2",
    });
  });

  it("does not invent identity before creation", () => {
    const scope = new CreatedIdentityScope();
    expect(createdIdentityFromError(scope.attach(new Error("preflight")))).toEqual(
      {},
    );
  });

  it("accumulates prior batch identities and updates the failing member", () => {
    const scope = new CreatedIdentityScope();
    const sameSurface = (
      left: Record<string, unknown>,
      right: Record<string, unknown>,
    ) => left.surface_id === right.surface_id;
    scope.append(
      "agents",
      { agent_id: "pending-a", surface_id: "surface:a" },
      sameSurface,
    );
    scope.append(
      "agents",
      { agent_id: "agent-a", surface_id: "surface:a" },
      sameSurface,
    );
    scope.append(
      "agents",
      { agent_id: "agent-b", surface_id: "surface:b" },
      sameSurface,
    );

    expect(createdIdentityFromError(scope.attach(new Error("batch")))).toEqual({
      agents: [
        { agent_id: "agent-a", surface_id: "surface:a" },
        { agent_id: "agent-b", surface_id: "surface:b" },
      ],
    });
  });
});
