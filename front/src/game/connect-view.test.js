import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./game-board.js", () => ({ renderBoard: vi.fn() }));

import { renderBoard } from "./game-board.js";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { createConnectChain, addHop } from "./connect-model.js";
import {
  render,
  draw,
  formatElapsed,
  setBoardHandlers,
  setEndpointsExpanded,
} from "./connect-view.js";

function mountDom() {
  const mk = (key, tag = "div") => {
    els[key] = document.createElement(tag);
    return els[key];
  };
  mk("connectTitleStart", "span");
  mk("connectTitleGoal", "span");
  mk("connectHopsValue", "span");
  mk("connectParPill");
  mk("connectParValue", "span");
  mk("connectRivalPill");
  mk("connectRivalText", "span");
  mk("connectLineList", "ul");
  mk("connectEndpoints");
  mk("connectStageEmpty");
  mk("connectAddInput", "input");
  mk("connectAddBtn", "button");
  mk("connectBrowse");
  mk("connectBrowseChips");
  mk("connectBrowseLabel", "span");
  mk("connectUndo", "button");
  mk("connectReset", "button");
  mk("connectGiveUp", "button");
  mk("connectShare", "button");
  mk("connectLockin", "button");
  mk("connectFinishScore", "span");
  mk("connectFinishLabel", "span");
  mk("connectFinishDetail");
  mk("connectLeaderboard");
  mk("connectTimerValue", "span");
}

beforeEach(() => {
  renderBoard.mockClear();
  mountDom();
  setBoardHandlers({});
  setEndpointsExpanded(false);
  Object.assign(State.connect, {
    startName: "",
    goalName: "",
    game: null,
    photos: {},
    ids: {},
    frontier: null,
    rivalBanner: null,
    par: null,
    seasonId: null,
    submitted: false,
    unresolved: {},
  });
});

describe("render() with no game", () => {
  it("falls back to the placeholder titles and an empty line", () => {
    render();
    expect(els.connectTitleStart.textContent).toBe("Start");
    expect(els.connectTitleGoal.textContent).toBe("Goal");
    expect(els.connectHopsValue.textContent).toBe("0");
    expect(els.connectLineList.innerHTML).toBe("");
    expect(els.connectStageEmpty.hidden).toBe(true);
  });

  it("shows no score and keeps the endpoint editor open", () => {
    render();
    expect(els.connectFinishScore.textContent).toBe("—");
    expect(els.connectEndpoints.hidden).toBe(false);
  });
});

describe("render() with an active game", () => {
  beforeEach(() => {
    const s = State.connect;
    s.startName = "Drake";
    s.goalName = "Adele";
    s.game = createConnectChain("Drake", "Adele");
  });

  it("writes the endpoints, hop count and the start row", () => {
    render();
    expect(els.connectTitleStart.textContent).toBe("Drake");
    expect(els.connectTitleGoal.textContent).toBe("Adele");
    expect(els.connectHopsValue.textContent).toBe("0");
    expect(els.connectLineList.innerHTML).toContain("Drake");
    expect(els.connectLineList.innerHTML).toContain("the origin");
    expect(els.connectStageEmpty.hidden).toBe(true);
  });

  it("collapses the endpoint editor once both endpoints are known", () => {
    render();
    expect(els.connectEndpoints.hidden).toBe(true);
    setEndpointsExpanded(true);
    render();
    expect(els.connectEndpoints.hidden).toBe(false);
  });

  it("shows the PAR pill only once the challenge ideal is known", () => {
    render();
    expect(els.connectParPill.hidden).toBe(true);
    State.connect.par = 3;
    render();
    expect(els.connectParPill.hidden).toBe(false);
    expect(els.connectParValue.textContent).toBe("3");
  });

  it("shows the rival banner when chasing someone", () => {
    State.connect.rivalBanner = { name: "kat", score: 88 };
    render();
    expect(els.connectRivalPill.hidden).toBe(false);
    expect(els.connectRivalText.textContent).toBe("Chasing kat · 88");
  });

  it("escapes artist names instead of injecting them as markup", () => {
    State.connect.game = createConnectChain("<img src=x onerror=1>", "Adele");
    render();
    expect(els.connectLineList.querySelector("img")).toBeNull();
    expect(els.connectLineList.querySelector(".clp-row-name").textContent).toBe(
      "<img src=x onerror=1>",
    );
    expect(els.connectLineList.innerHTML).toContain("&lt;img");
  });

  it("keeps Lock in disabled until the line reaches the goal", () => {
    render();
    expect(els.connectLockin.disabled).toBe(true);
    addHop(State.connect.game, "Adele");
    render();
    expect(els.connectLockin.disabled).toBe(false);
    expect(els.connectLockin.textContent).toBe("Lock in");
  });

  it("labels Lock in as done once submitted", () => {
    addHop(State.connect.game, "Adele");
    State.connect.submitted = true;
    render();
    expect(els.connectLockin.disabled).toBe(true);
    expect(els.connectLockin.textContent).toBe("Locked in");
  });
});

describe("[SF-GAME-34 / ADR-0009] честное состояние вместо фейкового узла", () => {
  beforeEach(() => {
    State.connect.startName = "Drake";
    State.connect.goalName = "Nobody";
    State.connect.game = createConnectChain("Drake", "Nobody");
  });

  it("names the endpoint that couldn't be identified and says what to do", () => {
    State.connect.unresolved = { Nobody: true };
    render();
    expect(els.connectStageEmpty.hidden).toBe(false);
    expect(els.connectStageEmpty.textContent).toContain("Nobody");
    expect(els.connectStageEmpty.textContent).toContain("pick the artist from the suggestions");
  });

  it("names both when neither resolved", () => {
    State.connect.unresolved = { Drake: true, Nobody: true };
    render();
    expect(els.connectStageEmpty.textContent).toContain("Drake");
    expect(els.connectStageEmpty.textContent).toContain("Nobody");
    expect(els.connectStageEmpty.textContent).toContain("pick both artists");
  });

  it("stays quiet about hops/other names that aren't the endpoints", () => {
    State.connect.unresolved = { "Some Hop": true };
    render();
    expect(els.connectStageEmpty.hidden).toBe(true);
  });

  it("goes away once the name resolves", () => {
    State.connect.unresolved = { Nobody: true };
    render();
    expect(els.connectStageEmpty.hidden).toBe(false);
    State.connect.unresolved = {};
    render();
    expect(els.connectStageEmpty.hidden).toBe(true);
  });
});

describe("frontier (dandelion) chips", () => {
  beforeEach(() => {
    const s = State.connect;
    s.startName = "Drake";
    s.goalName = "Adele";
    s.game = createConnectChain("Drake", "Adele");
  });

  it("stays hidden with no frontier at all", () => {
    render();
    expect(els.connectBrowse.hidden).toBe(true);
  });

  it("renders each collaborator on the ui-chip kit base [SF-GAME-33]", () => {
    State.connect.frontier = {
      centerName: "Drake",
      loading: false,
      neighbours: [{ id: 200, name: "SZA", image: null }],
    };
    render();
    expect(els.connectBrowse.hidden).toBe(false);
    expect(els.connectBrowseChips.innerHTML).toContain("ui-chip");
    expect(els.connectBrowseChips.innerHTML).toContain("SZA");
  });

  it("says so honestly while loading / when there's no data", () => {
    State.connect.frontier = { centerName: "Drake", loading: true, neighbours: [] };
    render();
    expect(els.connectBrowseChips.innerHTML).toContain("Loading");

    State.connect.frontier = {
      centerName: "Drake",
      loading: false,
      neighbours: [],
      unavailable: true,
    };
    render();
    expect(els.connectBrowseChips.innerHTML).toContain("No graph data");

    State.connect.frontier = { centerName: "Drake", loading: false, neighbours: [], failed: true };
    render();
    expect(els.connectBrowseChips.innerHTML).toContain("No collaborators found");
  });
});

describe("draw() → the real graph engine", () => {
  it("hands the board the game, photos, frontier, ids and the registered handlers", () => {
    const handlers = { onPick: vi.fn(), onFocus: vi.fn(), onReachGoal: vi.fn() };
    setBoardHandlers(handlers);
    State.connect.game = createConnectChain("Drake", "Adele");
    State.connect.ids = { Drake: 100 };
    draw();
    expect(renderBoard).toHaveBeenCalledTimes(1);
    const [game, photos, frontier, ids, cbs] = renderBoard.mock.calls[0];
    expect(game.start).toBe("Drake");
    expect(photos).toBe(State.connect.photos);
    expect(frontier).toBeNull();
    expect(ids).toEqual({ Drake: 100 });
    expect(cbs).toBe(handlers);
  });
});

describe("formatElapsed", () => {
  it("formats m:ss and clamps negatives", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(75_000)).toBe("1:15");
    expect(formatElapsed(600_000)).toBe("10:00");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
