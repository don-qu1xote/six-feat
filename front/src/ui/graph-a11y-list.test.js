import { describe, it, expect, vi, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { renderGraphA11yList } from "./graph-a11y-list.js";
import { setFocus } from "../vis-adapter/index.js";
import { showArtistSidebar } from "./sidebar.js";

vi.mock("../vis-adapter/index.js", () => ({ setFocus: vi.fn() }));
vi.mock("./sidebar.js", () => ({ showArtistSidebar: vi.fn() }));

function renderMarkup() {
  document.body.innerHTML = `
    <ul id="graph-a11y-node-list"></ul>
    <h3 id="graph-a11y-neighbors-heading"></h3>
    <ul id="graph-a11y-neighbor-list"></ul>`;
  els.graphA11yNodeList = document.getElementById("graph-a11y-node-list");
  els.graphA11yNeighborList = document.getElementById("graph-a11y-neighbor-list");
  els.graphA11yNeighborsHeading = document.getElementById("graph-a11y-neighbors-heading");
}

const nodeButtons = () => els.graphA11yNodeList.querySelectorAll("button[data-node-id]");
const neighbourButtons = () => els.graphA11yNeighborList.querySelectorAll("button[data-node-id]");

beforeEach(() => {
  renderMarkup();

  State.graphNodes = [];
  State.graphEdges = [];
  renderGraphA11yList();

  State.graphNodes = [
    { id: 1, name: "Drake", isSeed: true },
    { id: 2, name: "Future", isSeed: false },
    { id: 3, name: "Rihanna", isSeed: false },
  ];
  State.graphEdges = [
    { from: 1, to: 2, dominantRole: "featured" },
    { from: 1, to: 3, dominantRole: "producer" },
  ];
  State.network = null;
});

describe("node list rendering", () => {
  it("lists every node in the graph as its own button", () => {
    renderGraphA11yList();
    expect(nodeButtons()).toHaveLength(3);
  });

  it("announces the seed artist as such", () => {
    renderGraphA11yList();
    expect(nodeButtons()[0].textContent).toContain("seed artist");
    expect(nodeButtons()[1].textContent).not.toContain("seed artist");
  });

  it("pluralises the connection count so screen readers read it naturally", () => {
    renderGraphA11yList();
    expect(nodeButtons()[0].textContent).toContain("2 connections");
    expect(nodeButtons()[1].textContent).toContain("1 connection");
    expect(nodeButtons()[1].textContent).not.toContain("1 connections");
  });

  it("reports zero connections for an isolated node", () => {
    State.graphNodes = [{ id: 9, name: "Loner", isSeed: false }];
    State.graphEdges = [];
    renderGraphA11yList();
    expect(nodeButtons()[0].textContent).toContain("0 connections");
  });

  it("escapes markup in artist names", () => {
    State.graphNodes = [{ id: 1, name: "<b>bold</b>", isSeed: false }];
    State.graphEdges = [];
    renderGraphA11yList();

    expect(els.graphA11yNodeList.querySelector("b")).toBeNull();
    expect(nodeButtons()[0].textContent).toContain("<b>bold</b>");
  });

  it("renders nothing and does not throw when the list is not on this page", () => {
    els.graphA11yNodeList = null;
    expect(() => renderGraphA11yList()).not.toThrow();
  });
});

describe("selecting a node", () => {
  it("focuses the graph, the sidebar and the neighbour list together", () => {
    State.network = { focus: vi.fn() };
    renderGraphA11yList();

    nodeButtons()[0].click();

    expect(State.network.focus).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.5 }));
    expect(setFocus).toHaveBeenCalledWith(1);
    expect(showArtistSidebar).toHaveBeenCalledWith(1);
  });

  it("works without a rendered network (a11y list is usable before the canvas exists)", () => {
    renderGraphA11yList();
    expect(() => nodeButtons()[0].click()).not.toThrow();
    expect(setFocus).toHaveBeenCalledWith(1);
  });

  it("marks exactly one button as aria-current", () => {
    renderGraphA11yList();
    nodeButtons()[0].click();
    expect(els.graphA11yNodeList.querySelectorAll("[aria-current]")).toHaveLength(1);

    nodeButtons()[1].click();
    const current = els.graphA11yNodeList.querySelectorAll("[aria-current]");
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("data-node-id")).toBe("2");
  });

  it("ignores a click for a node that is no longer in the graph", () => {
    renderGraphA11yList();
    State.graphNodes = [];
    nodeButtons()[0].click();

    expect(setFocus).not.toHaveBeenCalled();
    expect(showArtistSidebar).not.toHaveBeenCalled();
  });
});

describe("neighbour list", () => {
  it("names the selected artist in the heading", () => {
    renderGraphA11yList();
    nodeButtons()[0].click();
    expect(els.graphA11yNeighborsHeading.textContent).toBe("Connections of Drake");
  });

  it("falls back to a generic heading when nothing is selected", () => {
    renderGraphA11yList();
    expect(els.graphA11yNeighborsHeading.textContent).toBe("Connections");
  });

  it("lists the neighbour on the far side of each edge, in either direction", () => {
    renderGraphA11yList();
    nodeButtons()[1].click();

    expect(neighbourButtons()).toHaveLength(1);
    expect(neighbourButtons()[0].textContent).toContain("Drake");
  });

  it("labels each connection with its dominant role", () => {
    renderGraphA11yList();
    nodeButtons()[0].click();

    const labels = [...neighbourButtons()].map((b) => b.textContent);
    expect(labels.some((l) => l.includes("featured"))).toBe(true);
    expect(labels.some((l) => l.includes("producer"))).toBe(true);
  });

  it("describes an unknown role as a plain collaborator rather than blank", () => {
    State.graphEdges = [{ from: 1, to: 2, dominantRole: "mixer" }];
    renderGraphA11yList();
    nodeButtons()[0].click();

    expect(neighbourButtons()[0].textContent).toContain("collaborator");
  });

  it("says so explicitly when the selected artist has no connections", () => {
    State.graphEdges = [];
    renderGraphA11yList();
    nodeButtons()[0].click();

    expect(els.graphA11yNeighborList.textContent).toContain("No connections");
  });

  it("names a neighbour by id when the node itself is missing from the graph", () => {
    State.graphEdges = [{ from: 1, to: 404, dominantRole: "featured" }];
    renderGraphA11yList();
    nodeButtons()[0].click();

    expect(neighbourButtons()[0].textContent).toContain("Artist #404");
  });

  it("lets the user walk the graph by clicking through neighbours", () => {
    renderGraphA11yList();
    nodeButtons()[0].click();
    neighbourButtons()[0].click();

    expect(showArtistSidebar).toHaveBeenLastCalledWith(2);
    expect(els.graphA11yNeighborsHeading.textContent).toBe("Connections of Future");
  });

  it("drops a stale selection when the graph is replaced", () => {
    renderGraphA11yList();
    nodeButtons()[0].click();

    State.graphNodes = [{ id: 77, name: "Someone Else", isSeed: true }];
    State.graphEdges = [];
    renderGraphA11yList();

    expect(els.graphA11yNeighborsHeading.textContent).toBe("Connections");
    expect(els.graphA11yNodeList.querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  it("keeps a selection that survives a re-render", () => {
    renderGraphA11yList();
    nodeButtons()[1].click();
    renderGraphA11yList();

    expect(els.graphA11yNeighborsHeading.textContent).toBe("Connections of Future");
    expect(els.graphA11yNodeList.querySelectorAll("[aria-current]")).toHaveLength(1);
  });

  it("skips the neighbour list when it is not on this page", () => {
    els.graphA11yNeighborList = null;
    renderGraphA11yList();
    expect(() => nodeButtons()[0].click()).not.toThrow();
  });
});
